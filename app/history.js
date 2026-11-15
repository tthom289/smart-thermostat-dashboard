'use strict';
// History: logs thermostat + air quality readings, HVAC run cycles, setting changes
// and app commands to a SQLite file (HISTORY_DIR/history.sqlite3) for Grafana.
// If the folder isn't mounted or writable, history is simply turned off.

const fs = require('fs');
const path = require('path');

const HISTORY_DIR = process.env.HISTORY_DIR || '/history';
const DB_FILE = path.join(HISTORY_DIR, 'history.sqlite3');
const RECENT_MS = 3 * 60 * 1000; // a change within 3 min of our own command is credited to it
const KINDS = { HEAT: 'heat_on', COOL: 'cool_on', FAN: 'fan_on' };

const log = (...a) => console.log(new Date().toISOString(), ...a);
const now = () => Math.floor(Date.now() / 1000);
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone; // follows the TZ env var
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const localDay = (sec) => dayFmt.format(new Date(sec * 1000)); // YYYY-MM-DD in local time

let db = null;
let stmts = {};
const last = new Map();    // applianceId -> last logged thermostat snapshot
const recent = new Map();  // applianceId -> { field: { at, source } }

function open() {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { log('History off: this Node version has no built-in SQLite'); return; }
  try {
    fs.accessSync(HISTORY_DIR, fs.constants.W_OK);
  } catch { log(`History off: ${HISTORY_DIR} is not mounted or not writable`); return; }
  try {
    db = new DatabaseSync(DB_FILE);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS thermostat_readings (
        time INTEGER NOT NULL, device TEXT NOT NULL,
        temp_f REAL, sensor_temp_f REAL, humidity REAL,
        heat_to_f REAL, cool_to_f REAL, target_f REAL,
        mode TEXT, fan TEXT, period TEXT, schedule_on INTEGER,
        running TEXT, heat_on INTEGER, cool_on INTEGER, fan_on INTEGER);
      CREATE INDEX IF NOT EXISTS thermostat_readings_time ON thermostat_readings (time);
      CREATE TABLE IF NOT EXISTS air_readings (
        time INTEGER NOT NULL, device TEXT NOT NULL,
        temp_f REAL, humidity REAL, pm25 REAL, pm10 REAL, voc REAL, co REAL, iaq REAL);
      CREATE INDEX IF NOT EXISTS air_readings_time ON air_readings (time);
      CREATE TABLE IF NOT EXISTS hvac_runs (
        id INTEGER PRIMARY KEY, device TEXT NOT NULL, kind TEXT NOT NULL,
        started INTEGER NOT NULL, ended INTEGER, seconds INTEGER, day TEXT);
      CREATE INDEX IF NOT EXISTS hvac_runs_started ON hvac_runs (started);
      CREATE TABLE IF NOT EXISTS events (
        time INTEGER NOT NULL, device TEXT, category TEXT NOT NULL,
        event TEXT NOT NULL, detail TEXT, source TEXT);
      CREATE INDEX IF NOT EXISTS events_time ON events (time);
    `);
    stmts = {
      thermo: db.prepare(`INSERT INTO thermostat_readings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      air: db.prepare(`INSERT INTO air_readings VALUES (?,?,?,?,?,?,?,?,?)`),
      event: db.prepare(`INSERT INTO events VALUES (?,?,?,?,?,?)`),
      runOpen: db.prepare(`INSERT INTO hvac_runs (device, kind, started, day) VALUES (?,?,?,?)`),
      runClose: db.prepare(`UPDATE hvac_runs SET ended = ?, seconds = ? - started WHERE id = ?`),
      openRuns: db.prepare(`SELECT id, kind, started FROM hvac_runs WHERE device = ? AND ended IS NULL`),
      lastReading: db.prepare(`SELECT MAX(time) AS t FROM thermostat_readings WHERE device = ?`),
    };
    // Run days are stored in local time; recompute them if the time zone changed.
    const prevTz = db.prepare(`SELECT value FROM meta WHERE key = 'tz'`).get();
    if (!prevTz || prevTz.value !== TZ) {
      const upd = db.prepare(`UPDATE hvac_runs SET day = ? WHERE id = ?`);
      for (const r of db.prepare(`SELECT id, started FROM hvac_runs`).all()) upd.run(localDay(r.started), r.id);
      db.prepare(`INSERT OR REPLACE INTO meta VALUES ('tz', ?)`).run(TZ);
    }
    log(`History on: ${DB_FILE} (time zone ${TZ})`);
  } catch (e) {
    log('History off: could not open database:', e.message);
    db = null;
  }
}

const safe = (fn) => (...a) => { if (!db) return; try { return fn(...a); } catch (e) { log('History write failed:', e.message); } };

const toF = (t) => {
  if (!t || t.value == null || isNaN(t.value)) return null;
  return t.scale === 'CELSIUS' ? Math.round((t.value * 9 / 5 + 32) * 10) / 10 : Number(t.value);
};
const num = (v) => (v == null || isNaN(Number(v)) ? null : Number(v));
const fmtDur = (s) => { const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

function snapshot(t) {
  const h = t.hvac || {};
  return {
    mode: t.mode || null, fan: t.fan || null, period: t.activity || null,
    schedule_on: t.scheduleEnabled == null ? null : (t.scheduleEnabled ? 1 : 0),
    heat_to_f: toF(t.lower), cool_to_f: toF(t.upper), target_f: toF(t.target),
    heat_on: /^(ON|STAGE)/i.test(h.primaryHeaterOperation || '') ? 1 : 0,
    cool_on: /^(ON|STAGE)/i.test(h.coolerOperation || '') ? 1 : 0,
    fan_on: /^ON/i.test(h.fanOperation || '') ? 1 : 0,
    heatStage: h.primaryHeaterOperation, coolStage: h.coolerOperation,
  };
}

// Our own command (or vacation step) is about to change these fields.
const markRecent = (t, fields, source) => {
  const r = recent.get(t.applianceId) || {};
  for (const f of fields) r[f] = { at: Date.now(), source };
  recent.set(t.applianceId, r);
};
const recentSource = (t, field) => {
  const r = (recent.get(t.applianceId) || {})[field];
  return r && Date.now() - r.at < RECENT_MS ? r.source : null;
};

const event = safe((device, category, ev, detail, source, time = now()) => {
  stmts.event.run(time, device, category, ev, detail || null, source || null);
});

// A command sent from this app (or by the vacation feature).
const command = safe((t, text, fields, ok, error, source = 'this app') => {
  if (ok && fields && fields.length) markRecent(t, fields, source);
  event(t ? t.name : null, 'command', text, ok ? 'OK' : `FAILED: ${error}`, source);
});

const LABEL = { mode: 'Mode', fan: 'Fan', heat_to_f: 'Heat-to', cool_to_f: 'Cool-to', target_f: 'Target', schedule_on: 'Schedule', period: 'Period' };
const show = (k, v) => (v == null ? '–' : k === 'schedule_on' ? (v ? 'on' : 'off') : /_f$/.test(k) ? `${v}°F` : String(v));

const recordThermostat = safe((t, ts) => {
  const s = snapshot(t);
  const temp = toF(t.precise) ?? toF(t.current);
  const prev = last.get(t.applianceId);
  // Before inserting: the last reading from before a restart (used to settle open runs).
  const lastTs = prev ? null : stmts.lastReading.get(t.name);
  stmts.thermo.run(ts, t.name, temp, toF(t.externalTemp), num(t.humidity),
    s.heat_to_f, s.cool_to_f, s.target_f, s.mode, s.fan, s.period, s.schedule_on,
    t.running || null, s.heat_on, s.cool_on, s.fan_on);

  last.set(t.applianceId, s);

  if (!prev) {
    // First reading since start: settle any runs left open by a restart. A run that
    // ended while we were down is closed at the last reading we have from before.
    const before = lastTs && lastTs.t && lastTs.t < ts ? lastTs.t : ts;
    const open = stmts.openRuns.all(t.name);
    for (const [kind, key] of Object.entries(KINDS)) {
      const runs = open.filter(r => r.kind === kind);
      if (s[key]) { if (!runs.length) stmts.runOpen.run(t.name, kind, ts, localDay(ts)); }
      for (const r of (s[key] ? runs.slice(1) : runs)) {
        const end = Math.max(before, r.started);
        stmts.runClose.run(end, end, r.id);
        event(t.name, 'hvac', `${kind} OFF`, `ran at least ${fmtDur(end - r.started)} (ended while app was offline)`, 'thermostat', end);
      }
    }
    return;
  }

  // HVAC on/off transitions -> run cycles + events
  for (const [kind, key] of Object.entries(KINDS)) {
    if (s[key] === prev[key]) continue;
    if (s[key]) {
      stmts.runOpen.run(t.name, kind, ts, localDay(ts));
      const stage = kind === 'HEAT' ? s.heatStage : kind === 'COOL' ? s.coolStage : null;
      event(t.name, 'hvac', `${kind} ON`, stage && !/^ON$/i.test(stage) ? stage : null, 'thermostat', ts);
    } else {
      let detail = null;
      for (const r of stmts.openRuns.all(t.name).filter(r => r.kind === kind)) {
        stmts.runClose.run(ts, ts, r.id);
        detail = `ran ${fmtDur(ts - r.started)}`;
      }
      event(t.name, 'hvac', `${kind} OFF`, detail, 'thermostat', ts);
    }
  }

  // Setting changes, credited to whoever most likely made them
  const periodChanged = s.period !== prev.period;
  for (const k of Object.keys(LABEL)) {
    if (s[k] === prev[k] || prev[k] == null || s[k] == null) continue; // skip unknown → value blips
    if (k === 'target_f' && s.mode === 'AUTO') continue; // not used in Auto
    let source = recentSource(t, k);
    if (!source) source = (k === 'period' || (periodChanged && /_f$/.test(k))) ? 'schedule' : 'Alexa / thermostat';
    event(t.name, 'change', `${LABEL[k]} changed`, `${show(k, prev[k])} → ${show(k, s[k])}`, source, ts);
  }
});

const recordAir = safe((m, ts) => {
  const v = m.values || {};
  stmts.air.run(ts, m.name, toF(m.temp), num(v.humidity), num(v.pm25), num(v.pm10), num(v.voc), num(v.co), num(v.iaq));
});

// Called after every successful poll.
// `fresh` = ids Amazon returned state for in this poll; others are skipped, not logged as blanks.
function record(state, fresh) {
  if (!db) return;
  const ts = now();
  for (const t of state.thermostats || []) if (!t.error && fresh.has(t.applianceId) && t.mode) recordThermostat(t, ts);
  for (const m of state.airMonitors || []) if (!m.error && fresh.has(m.applianceId) && m.values) recordAir(m, ts);
}

module.exports = { open, record, command, event, enabled: () => !!db };
