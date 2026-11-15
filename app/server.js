'use strict';
// Thermostat Web: a small LAN-only page for the Amazon Smart Thermostat.
// It talks to Amazon's Alexa cloud through alexa-remote2 (unofficial API).
// Nothing goes anywhere except Amazon.

const http = require('http');
const fs = require('fs');
const path = require('path');
const Alexa = require('alexa-remote2');

const PORT = Number(process.env.PORT || 8890);
const PROXY_PORT = Number(process.env.PROXY_PORT || 3001);
const HOST_IP = process.env.HOST_IP || 'localhost'; // the LAN IP your browser uses to reach this box (set HOST_IP)
const DATA_DIR = process.env.DATA_DIR || '/data';
const COOKIE_FILE = path.join(DATA_DIR, 'alexa-cookie.json');
const VACATION_FILE = path.join(DATA_DIR, 'vacation.json');
const POLL_MS = Number(process.env.POLL_SECONDS || 60) * 1000;
const DEBUG = process.env.DEBUG === '1';
// Host header allow-list: blocks DNS-rebinding tricks from websites you visit.
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || `${HOST_IP},localhost,127.0.0.1`)
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const ACTIVITIES = ['HOME', 'AWAY', 'SLEEP'];
const FAN_MODES = ['ON', 'AUTO', 'CIRCULATE'];
const MIN_GAP = 3; // degrees between heat-to and cool-to

const PUBLIC_DIR = path.join(__dirname, 'public');
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- login-proxy header fix ----------
// Amazon's sign-in pages send "Content-Security-Policy: upgrade-insecure-requests",
// which makes the browser submit the login form to https://<this box>:3001 (nothing
// listens there, so the browser shows ERR_SSL_PROTOCOL_ERROR). Strip Amazon's CSP/HSTS
// headers, only on responses served by the login proxy port.
const STRIP_ON_PROXY = new Set(['content-security-policy', 'content-security-policy-report-only', 'strict-transport-security']);
const isProxyRes = (res) => res.req && res.req.socket && res.req.socket.localPort === PROXY_PORT;
const origSetHeader = http.ServerResponse.prototype.setHeader;
http.ServerResponse.prototype.setHeader = function (name, value) {
  if (isProxyRes(this) && STRIP_ON_PROXY.has(String(name).toLowerCase())) return this;
  return origSetHeader.call(this, name, value);
};
const origWriteHead = http.ServerResponse.prototype.writeHead;
http.ServerResponse.prototype.writeHead = function (status, ...rest) {
  if (isProxyRes(this)) {
    for (const h of STRIP_ON_PROXY) this.removeHeader(h);
    const hdrs = rest.find(a => a && typeof a === 'object');
    if (hdrs && !Array.isArray(hdrs)) for (const k of Object.keys(hdrs)) if (STRIP_ON_PROXY.has(k.toLowerCase())) delete hdrs[k];
  }
  return origWriteHead.call(this, status, ...rest);
};

// ---------- state ----------
const state = {
  status: 'starting',        // starting | needs_login | ready | error
  message: '',
  loginUrl: null,
  thermostats: [],
  updatedAt: null,
};
let alexa = null;
let refreshing = null;
let lastRefresh = 0;

// ---------- small file helpers ----------
function readJsonFile(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function writeJsonFile(f, data) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, f);
}
function saveCookie(data) {
  try { writeJsonFile(COOKIE_FILE, data); log('Saved Amazon session'); } catch (e) { log('Could not save session:', e.message); }
}

// ---------- alexa ----------
function startAlexa() {
  alexa = new Alexa();
  const saved = readJsonFile(COOKIE_FILE);

  alexa.on('cookie', (cookie, csrf, macDms) => saveCookie(alexa.cookieData || { cookie, csrf, macDms }));

  const options = {
    cookie: saved || undefined,
    macDms: (saved && saved.macDms) || undefined,
    amazonPage: 'amazon.com',
    alexaServiceHost: 'pitangui.amazon.com',
    acceptLanguage: 'en-US',
    amazonPageProxyLanguage: 'en_US',
    proxyOnly: true,
    setupProxy: true,
    proxyOwnIp: HOST_IP,
    proxyPort: PROXY_PORT,
    proxyListenBind: '0.0.0.0',
    proxyLogLevel: 'warn',
    formerDataStorePath: path.join(DATA_DIR, 'formerDataStore.json'),
    bluetooth: false,
    notifications: false,
    useWsMqtt: false,
    usePushConnection: false,
    logger: DEBUG ? (m) => log('[alexa]', m) : undefined,
  };

  if (!saved) {
    state.status = 'needs_login';
    state.loginUrl = `http://${HOST_IP}:${PROXY_PORT}/`;
    state.message = 'Sign in to Amazon to link your account.';
  }

  // This callback can fire more than once: first with a "please open the proxy"
  // error when no session exists, then once login succeeds, and again after each
  // automatic session refresh (every few days).
  alexa.init(options, async (err) => {
    if (err) {
      const msg = String(err.message || err);
      if (/Please open http/i.test(msg)) {
        state.status = 'needs_login';
        state.loginUrl = `http://${HOST_IP}:${PROXY_PORT}/`;
        state.message = 'Sign in to Amazon to link your account.';
        log('Waiting for Amazon login at', state.loginUrl);
      } else {
        state.status = 'error';
        state.message = msg;
        log('Alexa init error:', msg);
        // Network not ready yet (e.g. DNS right after a reboot): exit and let
        // Docker's restart policy try again, instead of staying broken.
        if (/EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH/.test(msg)) {
          log('Network error; restarting in 30 s');
          setTimeout(() => process.exit(1), 30000);
        }
      }
      return;
    }
    log('Connected to Alexa.');
    state.loginUrl = null;
    try {
      await discover();
      state.status = 'ready';
      state.message = '';
      // first state read can be slow on Amazon's side; don't block the page on it
      refresh(true).catch(e => log('Initial refresh failed:', e.message));
    } catch (e) {
      state.status = 'error';
      state.message = 'Connected, but could not load devices: ' + e.message;
      log(state.message);
    }
  });
}

const p = (fn) => new Promise((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res))));

function gql(query, variables) {
  return new Promise((resolve, reject) => alexa.httpsGet('/nexus/v1/graphql', (err, res) => {
    if (err) return reject(err);
    if (res && res.errors && res.errors.length && !res.data) return reject(new Error(res.errors[0].message || 'GraphQL error'));
    resolve(res);
  }, { method: 'POST', data: JSON.stringify({ query, variables }), timeout: 30000 }));
}

const SCHEDULE_FIELDS = DAYS.map(d => `${d} { startTimeInMinutes setpoints { lowerSetpoint upperSetpoint } fanSetting { mode } activityType { activityType } }`).join(' ');
const FEATURE_MUTATION = `mutation($in: SetEndpointFeaturesInput!) { setEndpointFeatures(setEndpointFeaturesInput: $in) {
  featureControlResponses { featureOperationName code responsePayload { type
    ... on WeeklyScheduleResponse { weeklySchedule { temperatureScale ${SCHEDULE_FIELDS} } } } }
  errors { featureOperationName code message } } }`;

// Run one "feature operation" on the thermostat (schedule, fan mode, ...).
async function feature(t, featureName, op, payload, instance) {
  const req = { endpointId: t.endpointId, featureName, featureOperationName: op };
  if (instance) req.instance = instance;
  if (payload !== undefined) req.payload = payload;
  if (DEBUG) log('Feature request:', JSON.stringify(req));
  const res = await gql(FEATURE_MUTATION, { in: { featureControlRequests: [req] } });
  const out = res.data && res.data.setEndpointFeatures;
  const ok = out && (out.featureControlResponses || []).find(r => r.code === 'SUCCESS');
  if (!ok) {
    const e = out && out.errors && out.errors[0];
    throw httpErr(502, `Amazon rejected ${op}: ${e ? (e.message || e.code) : 'unknown error'}`);
  }
  return ok.responsePayload;
}

const friendly = (res) => {
  const fn = res && res.friendlyNames && res.friendlyNames[0];
  return fn && fn.value && fn.value.text;
};

async function discover() {
  const res = await p(cb => alexa.getSmarthomeDevicesV2(cb));
  const found = [];
  for (const d of res || []) {
    const la = d.legacyAppliance || {};
    const caps = Array.isArray(la.capabilities) ? la.capabilities : [];
    const types = la.applianceTypes || [];
    const isThermo = types.includes('THERMOSTAT') || caps.some(c => c && c.interfaceName === 'Alexa.ThermostatController');
    if (!isThermo || la.isEnabled === false || !la.applianceId) continue;

    const tc = caps.find(c => c && c.interfaceName === 'Alexa.ThermostatController') || {};
    const sched = caps.find(c => c && c.interfaceName === 'Alexa.ThermostatController.Schedule');
    // The fan is exposed as a ModeController named "Fan Mode" with numeric mode values.
    const fanCap = caps.find(c => c && c.interfaceName === 'Alexa.ModeController' && /fan/i.test(friendly(c.resources) || ''));
    const fanModes = {};
    if (fanCap) for (const m of (fanCap.configuration && fanCap.configuration.supportedModes) || []) {
      const name = String(friendly(m.modeResources) || '').toUpperCase();
      if (FAN_MODES.includes(name)) fanModes[name] = String(m.value);
    }
    const modes = ((tc.configuration && tc.configuration.supportedModes) || []).map(m => String(m && m.value ? m.value : m)).filter(Boolean);

    found.push({
      applianceId: la.applianceId,
      entityId: la.entityId,
      endpointId: d.endpointId || d.id,
      name: la.friendlyName || d.friendlyName || 'Thermostat',
      supportedModes: modes.length ? modes : ['HEAT', 'COOL', 'AUTO', 'OFF'],
      hasSchedule: !!sched,
      maxEntriesPerDay: (sched && sched.configuration && sched.configuration.maxEntryPerDay) || 7,
      fanInstance: fanCap ? String(fanCap.instance) : null,
      fanModes,
    });
    if (DEBUG) log('Thermostat capabilities:', JSON.stringify(caps));
  }
  state.thermostats = found.map(t => ({ ...(state.thermostats.find(o => o.applianceId === t.applianceId) || {}), ...t }));
  log(`Found ${found.length} thermostat(s):`, found.map(t => t.name).join(', ') || '(none)');
}

function parseTemp(v) {
  if (v == null) return null;
  if (typeof v === 'object' && v.value != null) return { value: Number(v.value), scale: String(v.scale || 'FAHRENHEIT').toUpperCase() };
  if (!isNaN(Number(v))) return { value: Number(v), scale: 'FAHRENHEIT' };
  return null;
}
const plain = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);

async function refresh(force = false) {
  if (!alexa || !state.thermostats.length) return;
  if (!force && Date.now() - lastRefresh < 8000) return;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const reqs = state.thermostats.map(t => ({ entityId: t.applianceId, entityType: 'APPLIANCE' }));
    const res = await p(cb => alexa.querySmarthomeDevices(reqs, 'APPLIANCE', 20000, cb));
    if (DEBUG) log('State response:', JSON.stringify(res));
    for (const ds of (res && res.deviceStates) || []) {
      const id = ds.entity && ds.entity.entityId;
      const t = state.thermostats.find(x => x.applianceId === id || x.entityId === id);
      if (!t) continue;
      for (let cap of ds.capabilityStates || []) {
        try { cap = typeof cap === 'string' ? JSON.parse(cap) : cap; } catch { continue; }
        const { namespace: ns, name, value, instance } = cap;
        if (ns === 'Alexa.TemperatureSensor' && name === 'preciseTemperature') t.precise = parseTemp(value);
        else if (ns === 'Alexa.TemperatureSensor' && name === 'temperature') t.current = parseTemp(value);
        else if (ns === 'Alexa.HumiditySensor' && name === 'relativeHumidity') t.humidity = Number(plain(value));
        else if (ns === 'Alexa.ThermostatController') {
          if (name === 'targetSetpoint') t.target = parseTemp(value);
          else if (name === 'lowerSetpoint') t.lower = parseTemp(value);
          else if (name === 'upperSetpoint') t.upper = parseTemp(value);
          else if (name === 'thermostatMode') t.mode = String(plain(value)).toUpperCase();
        } else if (ns === 'Alexa.ThermostatController.Schedule') {
          if (name === 'scheduleEnabled') t.scheduleEnabled = !!plain(value);
          else if (name === 'adaptiveRecoveryEnabled') t.adaptiveRecovery = !!plain(value);
          else if (name === 'lastActivityType') t.activity = String(plain(value));
        } else if (ns === 'Alexa.ThermostatController.HVAC.Components') {
          t.hvac = t.hvac || {};
          t.hvac[name] = String(plain(value));
        } else if (ns === 'Alexa.ThermostatController.Configuration' && name === 'allowedTemperatureRange') {
          t.allowedRange = value;
        } else if (ns === 'Alexa.ModeController' && t.fanInstance && String(instance) === t.fanInstance) {
          const v = String(plain(value));
          t.fan = Object.keys(t.fanModes).find(k => t.fanModes[k] === v) || null;
        } else if (ns === 'Alexa.EndpointHealth' && name === 'connectivity') {
          t.online = String(plain(value)).toUpperCase() === 'OK';
        }
      }
      // what the system is doing right now
      const h = t.hvac || {};
      t.running = /^(ON|STAGE)/i.test(h.primaryHeaterOperation || '') ? 'HEATING'
        : /^(ON|STAGE)/i.test(h.coolerOperation || '') ? 'COOLING'
        : /^ON/i.test(h.fanOperation || '') ? 'FAN' : 'IDLE';
      t.error = null;
    }
    for (const e of (res && res.errors) || []) {
      const id = e.entity && e.entity.entityId;
      const t = state.thermostats.find(x => x.applianceId === id || x.entityId === id);
      if (t) t.error = e.code || 'UNKNOWN_ERROR';
    }
    lastRefresh = Date.now();
    state.updatedAt = new Date().toISOString();
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// ---------- limits ----------
function limits(t) {
  const scale = scaleOf(t);
  const r = t.allowedRange || {};
  const num = (o, d) => (o && o.value != null ? Number(o.value) : d);
  const F = scale !== 'CELSIUS';
  return {
    scale,
    heatMin: num(r.heating && r.heating.minimum, F ? 40 : 4), heatMax: num(r.heating && r.heating.maximum, F ? 87 : 30),
    coolMin: num(r.cooling && r.cooling.minimum, F ? 53 : 12), coolMax: num(r.cooling && r.cooling.maximum, F ? 90 : 32),
  };
}
function scaleOf(t) { return (t.target && t.target.scale) || (t.lower && t.lower.scale) || (t.current && t.current.scale) || 'FAHRENHEIT'; }
function checkRange(t, lower, upper) {
  const L = limits(t);
  if (!isFinite(lower) || !isFinite(upper)) throw httpErr(400, 'Temperatures must be numbers');
  if (lower < L.heatMin || lower > L.heatMax) throw httpErr(400, `Heat-to must be ${L.heatMin}–${L.heatMax}°`);
  if (upper < L.coolMin || upper > L.coolMax) throw httpErr(400, `Cool-to must be ${L.coolMin}–${L.coolMax}°`);
  if (upper - lower < MIN_GAP) throw httpErr(400, `Cool-to must be at least ${MIN_GAP}° above heat-to`);
}

// ---------- basic controls (phoenix API) ----------
async function phoenix(t, params) {
  log(`Control ${t.name}:`, JSON.stringify(params));
  const res = await p(cb => alexa.executeSmarthomeDeviceAction(t.entityId || t.applianceId, params, 'APPLIANCE', cb));
  if (DEBUG) log('Control response:', JSON.stringify(res));
  const ok = res && Array.isArray(res.controlResponses) && res.controlResponses[0] && res.controlResponses[0].code === 'SUCCESS';
  if (!ok) {
    const code = (res && res.errors && res.errors[0] && (res.errors[0].code || res.errors[0].message)) || 'Amazon rejected the command';
    throw httpErr(502, code);
  }
}
async function setMode(t, mode) {
  mode = String(mode).toUpperCase();
  if (!t.supportedModes.includes(mode)) throw httpErr(400, `Mode ${mode} is not supported`);
  await phoenix(t, { action: 'setThermostatMode', 'thermostatMode.value': mode });
  t.mode = mode;
}
async function setRange(t, lower, upper) {
  checkRange(t, lower, upper);
  const scale = scaleOf(t);
  await phoenix(t, {
    action: 'setTargetTemperature',
    'lowerSetTemperature.value': String(lower), 'lowerSetTemperature.scale': scale,
    'upperSetTemperature.value': String(upper), 'upperSetTemperature.scale': scale,
  });
  t.lower = { value: lower, scale }; t.upper = { value: upper, scale };
}
async function setTarget(t, v) {
  const L = limits(t);
  const lo = t.mode === 'COOL' ? L.coolMin : L.heatMin, hi = t.mode === 'COOL' ? L.coolMax : L.heatMax;
  if (!isFinite(v) || v < lo || v > hi) throw httpErr(400, `Temperature must be between ${lo} and ${hi}`);
  await phoenix(t, { action: 'setTargetTemperature', 'targetTemperature.value': String(v), 'targetTemperature.scale': L.scale });
  t.target = { value: v, scale: L.scale };
}
async function setScheduleEnabled(t, on) {
  await feature(t, 'thermostatSchedule', 'setScheduleState', { scheduleEnabled: !!on });
  t.scheduleEnabled = !!on;
}

async function control(t, body) {
  if (body.mode !== undefined) await setMode(t, body.mode);
  else if (body.lower !== undefined || body.upper !== undefined) await setRange(t, Number(body.lower), Number(body.upper));
  else if (body.target !== undefined) await setTarget(t, Number(body.target));
  else if (body.scheduleEnabled !== undefined) await setScheduleEnabled(t, body.scheduleEnabled);
  else if (body.adaptiveRecovery !== undefined) {
    await feature(t, 'thermostatSchedule', 'setAdaptiveRecovery', { adaptiveRecoveryEnabled: !!body.adaptiveRecovery });
    t.adaptiveRecovery = !!body.adaptiveRecovery;
  } else if (body.fan !== undefined) {
    const f = String(body.fan).toUpperCase();
    if (!t.fanInstance || !t.fanModes[f]) throw httpErr(400, `Fan mode ${f} is not supported`);
    await feature(t, 'mode', 'setMode', { mode: t.fanModes[f] }, t.fanInstance);
    t.fan = f;
  } else throw httpErr(400, 'Nothing to change');
  setTimeout(() => refresh(true).catch(e => log('Refresh after control failed:', e.message)), 4000);
}

// ---------- weekly schedule ----------
// Our format: { scale, days: { Monday: [{ start, lower, upper, fan, activity }] } }
async function getSchedule(t) {
  const r = await feature(t, 'thermostatSchedule', 'getWeeklySchedule');
  const w = r && r.weeklySchedule;
  if (!w) throw httpErr(502, 'Amazon returned no schedule');
  const days = {};
  for (const d of DAYS) {
    days[d] = (w[d] || []).map(e => ({
      start: e.startTimeInMinutes,
      lower: e.setpoints.lowerSetpoint,
      upper: e.setpoints.upperSetpoint,
      fan: (e.fanSetting && e.fanSetting.mode) || null,
      activity: (e.activityType && e.activityType.activityType) || null,
    })).sort((a, b) => a.start - b.start);
  }
  return { scale: w.temperatureScale, days };
}

function validateSchedule(t, sched) {
  if (!sched || typeof sched.days !== 'object') throw httpErr(400, 'Bad schedule');
  const clean = {};
  for (const d of DAYS) {
    const list = sched.days[d];
    if (!Array.isArray(list)) throw httpErr(400, `${d} is missing`);
    if (list.length > t.maxEntriesPerDay) throw httpErr(400, `${d}: at most ${t.maxEntriesPerDay} entries`);
    const seen = new Set();
    clean[d] = list.map((e, i) => {
      const start = Number(e.start), lower = Number(e.lower), upper = Number(e.upper);
      if (!Number.isInteger(start) || start < 0 || start > 1439) throw httpErr(400, `${d} entry ${i + 1}: bad time`);
      if (seen.has(start)) throw httpErr(400, `${d}: two entries start at the same time`);
      seen.add(start);
      try { checkRange(t, lower, upper); } catch (err) { throw httpErr(400, `${d} entry ${i + 1}: ${err.message}`); }
      const fan = e.fan ? String(e.fan).toUpperCase() : null;
      if (fan && !FAN_MODES.includes(fan)) throw httpErr(400, `${d} entry ${i + 1}: bad fan mode`);
      const activity = e.activity ? String(e.activity).toUpperCase() : null;
      if (activity && !ACTIVITIES.includes(activity)) throw httpErr(400, `${d} entry ${i + 1}: bad activity`);
      return { start, lower, upper, fan, activity };
    }).sort((a, b) => a.start - b.start);
  }
  return clean;
}

async function saveSchedule(t, sched) {
  const days = validateSchedule(t, sched);
  // Amazon's write format (Alexa.ThermostatController.Schedule SetWeeklySchedule):
  // activity goes under "type", not "activityType" as in the read format.
  const weeklySchedule = { temperatureScale: (sched.scale || scaleOf(t)).toUpperCase() };
  for (const d of DAYS) {
    weeklySchedule[d] = days[d].map(e => {
      const o = { startTimeInMinutes: e.start, setpoints: { lowerSetpoint: e.lower, upperSetpoint: e.upper } };
      if (e.fan) o.fanSetting = { mode: e.fan };
      if (e.activity) o.activityType = { type: e.activity };
      return o;
    });
  }
  log(`Saving weekly schedule for ${t.name}`);
  await feature(t, 'thermostatSchedule', 'setWeeklySchedule', { weeklySchedule });
  return getSchedule(t);
}

// "Preferred temperatures": set heat/cool for every schedule entry of one activity.
async function setPreferred(t, activity, lower, upper) {
  activity = String(activity).toUpperCase();
  if (!ACTIVITIES.includes(activity)) throw httpErr(400, 'Bad activity');
  checkRange(t, lower, upper);
  const s = await getSchedule(t);
  let n = 0;
  for (const d of DAYS) for (const e of s.days[d]) if (e.activity === activity) { e.lower = lower; e.upper = upper; n++; }
  if (!n) throw httpErr(400, `No ${activity.toLowerCase()} periods in your schedule yet. Add one in the schedule editor.`);
  return saveSchedule(t, s);
}

// ---------- vacation (run by this server) ----------
// Pauses the schedule and holds fixed temperatures until the return time, then
// turns the schedule back on. Persisted in data/vacation.json so it survives restarts.
let vacation = readJsonFile(VACATION_FILE);
let vacationBusy = false;
function saveVacation() {
  try { if (vacation) writeJsonFile(VACATION_FILE, vacation); else fs.rmSync(VACATION_FILE, { force: true }); }
  catch (e) { log('Could not save vacation:', e.message); }
}

async function applyHold(t, lower, upper) {
  if (t.mode === 'AUTO') await setRange(t, lower, upper);
  else if (t.mode === 'HEAT' || t.mode === 'EM_HEAT') await setTarget(t, lower);
  else if (t.mode === 'COOL') await setTarget(t, upper);
  // OFF: nothing to hold
}

async function startVacationNow(v) {
  const t = state.thermostats.find(x => x.applianceId === v.applianceId);
  if (!t) throw new Error('Thermostat not found');
  v.prev = {
    scheduleEnabled: t.scheduleEnabled !== false,
    lower: t.lower && t.lower.value, upper: t.upper && t.upper.value, target: t.target && t.target.value,
  };
  if (t.scheduleEnabled !== false) await setScheduleEnabled(t, false);
  await applyHold(t, v.lower, v.upper);
  v.active = true;
  v.startedAt = new Date().toISOString();
  saveVacation();
  log(`Vacation started for ${t.name} until ${v.end}`);
}

async function endVacationNow(reason) {
  const v = vacation;
  const t = v && state.thermostats.find(x => x.applianceId === v.applianceId);
  if (v && v.active && t) {
    const prev = v.prev || {};
    if (prev.scheduleEnabled) await setScheduleEnabled(t, true);
    else if (t.mode === 'AUTO' && prev.lower != null && prev.upper != null) await setRange(t, prev.lower, prev.upper);
    else if (prev.target != null && (t.mode === 'HEAT' || t.mode === 'COOL')) await setTarget(t, prev.target);
  }
  log(`Vacation ended (${reason})`);
  vacation = null;
  saveVacation();
  setTimeout(() => refresh(true).catch(() => {}), 4000);
}

async function vacationTick() {
  if (!vacation || vacationBusy || state.status !== 'ready') return;
  vacationBusy = true;
  try {
    const now = Date.now();
    if (!vacation.active && now >= Date.parse(vacation.end)) { vacation = null; saveVacation(); }
    else if (!vacation.active && now >= Date.parse(vacation.start)) await startVacationNow(vacation);
    else if (vacation.active && now >= Date.parse(vacation.end)) await endVacationNow('return time reached');
    if (vacation) vacation.lastError = null;
  } catch (e) {
    log('Vacation step failed (will retry):', e.message);
    if (vacation) vacation.lastError = e.message;
  } finally { vacationBusy = false; }
}

async function createVacation(t, body) {
  if (vacation) throw httpErr(409, 'A vacation is already set. Cancel it first.');
  const start = body.start ? Date.parse(body.start) : Date.now();
  const end = Date.parse(body.end);
  if (!isFinite(start) || !isFinite(end)) throw httpErr(400, 'Pick a valid return date and time');
  if (end <= Math.max(start, Date.now()) + 5 * 60000) throw httpErr(400, 'Return time must be in the future, after the start');
  const lower = Number(body.lower), upper = Number(body.upper);
  checkRange(t, lower, upper);
  vacation = { applianceId: t.applianceId, name: t.name, start: new Date(start).toISOString(), end: new Date(end).toISOString(), lower, upper, active: false };
  saveVacation();
  vacationBusy = true;
  try { if (start <= Date.now()) await startVacationNow(vacation); }
  catch (e) { vacation.lastError = e.message; throw e; }
  finally { vacationBusy = false; }
}

function httpErr(code, msg) { const e = new Error(msg); e.status = code; return e; }

// ---------- http ----------
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};

function send(res, status, body, type = 'application/json') {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  });
  res.end(data);
}

function publicState() {
  return {
    status: state.status,
    message: state.message,
    loginUrl: state.loginUrl,
    updatedAt: state.updatedAt,
    vacation: vacation && { name: vacation.name, applianceId: vacation.applianceId, start: vacation.start, end: vacation.end, lower: vacation.lower, upper: vacation.upper, active: !!vacation.active, lastError: vacation.lastError || null },
    thermostats: state.thermostats.map(({ entityId, endpointId, fanInstance, fanModes, hvac, ...t }) => ({
      ...t, fanOptions: Object.keys(fanModes || {}), limits: limits(t), minGap: MIN_GAP,
    })),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 65536) { reject(httpErr(413, 'Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(httpErr(400, 'Bad JSON')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!ALLOWED_HOSTS.includes(host)) return send(res, 421, { error: `Host "${host}" not allowed; add it to ALLOWED_HOSTS` });

    const url = new URL(req.url, 'http://x');

    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8'), type);
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      if (state.status === 'ready') await refresh(false).catch(e => log('Refresh failed:', e.message));
      return send(res, 200, publicState());
    }

    const m = url.pathname.match(/^\/api\/thermostat\/([^/]+)(?:\/(schedule|preferred|vacation))?$/);
    const findT = () => {
      if (state.status !== 'ready') throw httpErr(503, 'Not connected to Amazon yet');
      const t = state.thermostats.find(x => x.applianceId === decodeURIComponent(m[1]));
      if (!t) throw httpErr(404, 'Unknown thermostat');
      return t;
    };

    if (req.method === 'GET' && m && m[2] === 'schedule') return send(res, 200, await getSchedule(findT()));

    if ((req.method === 'POST' || req.method === 'DELETE') && url.pathname.startsWith('/api/')) {
      // CSRF guard: a custom header + JSON body forces a CORS preflight, which we never approve.
      if (req.headers['x-thermostat'] !== '1' || !String(req.headers['content-type'] || '').startsWith('application/json')) {
        return send(res, 403, { error: 'Forbidden' });
      }
      if (url.pathname === '/api/refresh') {
        if (state.status !== 'ready') return send(res, 503, { error: 'Not connected to Amazon yet' });
        await discover();
        await refresh(true);
        return send(res, 200, publicState());
      }
      if (m) {
        const t = findT();
        const body = await readBody(req);
        if (!m[2] && req.method === 'POST') { await control(t, body); return send(res, 200, publicState()); }
        if (m[2] === 'schedule' && req.method === 'POST') return send(res, 200, await saveSchedule(t, body));
        if (m[2] === 'preferred' && req.method === 'POST') return send(res, 200, await setPreferred(t, body.activity, Number(body.lower), Number(body.upper)));
        if (m[2] === 'vacation' && req.method === 'POST') { await createVacation(t, body); return send(res, 200, publicState()); }
        if (m[2] === 'vacation' && req.method === 'DELETE') {
          if (!vacation) return send(res, 404, { error: 'No vacation set' });
          await endVacationNow('cancelled');
          return send(res, 200, publicState());
        }
      }
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    log('Request error:', e.message);
    send(res, e.status || 500, { error: e.message || 'Server error' });
  }
});

server.listen(PORT, '0.0.0.0', () => log(`Thermostat Web on http://${HOST_IP}:${PORT}`));
setInterval(() => { if (state.status === 'ready') refresh(true).catch(e => log('Poll failed:', e.message)); }, POLL_MS);
setInterval(() => vacationTick(), 30000);
process.on('SIGTERM', () => { log('Stopping'); process.exit(0); });
startAlexa();
