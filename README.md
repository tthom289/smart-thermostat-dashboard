# Smart Thermostat Dashboard

A fast, ad-free web page for controlling an Amazon Smart Thermostat from any browser on your home network.

## Why this exists

I built this because controlling the thermostat through the Alexa app was painful. The app is clunky and slow, it pushes ads and "suggestions" at you, and changing a setpoint or editing the schedule means digging through a maze of screens.

This dashboard puts everything on one clean page: the current temperature, setpoints, mode, fan, the weekly schedule and a vacation hold. It installs on your phone's home screen like an app.

## Screenshots

| Now | Schedule | Vacation |
|:---:|:---:|:---:|
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/now-dark.png"><img src="docs/screenshots/now-light.png" alt="Now tab: current temperature, heat/cool setpoints, mode and fan" width="260"></picture> | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/schedule-dark.png"><img src="docs/screenshots/schedule-light.png" alt="Schedule tab: preferred temperatures and weekly schedule editor" width="260"></picture> | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/vacation-dark.png"><img src="docs/screenshots/vacation-light.png" alt="Vacation tab: hold temperatures until a return date" width="260"></picture> |

Light and dark themes follow your device setting.

## Compatible thermostats

| Thermostat | Status |
|---|---|
| **Amazon Smart Thermostat** (made with Honeywell Home / Resideo) | ✅ Tested. Every feature works. |

The Amazon Smart Thermostat is the only thermostat Amazon makes, and it's the one this was built and tested with.

**Other Alexa-connected thermostats** (ecobee, Honeywell Home, Google Nest, Emerson Sensi and similar) are untested. The app finds any thermostat linked to your Alexa account, so the basics may work: reading the temperature and changing setpoints and mode. The weekly schedule and fan controls use Amazon-specific features and probably won't. If you try another model, please open an issue and say how it went.

**Region:** this currently only supports US Amazon accounts (amazon.com).

## Features

- **Now:** current temperature and humidity, heat-to/cool-to setpoints, mode (Heat/Cool/Auto/Off), fan (Auto/On/Circulate), schedule on/off, and whether it's heating or cooling.
- **Schedule:** a weekly schedule editor (add or remove entries, copy one day to others), plus Home/Sleep/Away "preferred temperatures" that update every matching schedule entry at once.
- **Vacation:** pauses the schedule, holds the temperatures you pick, and turns the schedule back on at your return time. It survives restarts.
- **Air quality monitor:** if you have an Amazon Indoor Air Quality Monitor on the same account, its readings (temperature, humidity, PM2.5, PM10, VOC, carbon monoxide, air score) show on the Now tab.
- **History (Grafana):** every poll is logged to a SQLite file on your server, and a History tab shows it in a ready-made Grafana dashboard. See [History and energy tracking](#history-and-energy-tracking).
- Installs to your phone's home screen (PWA).

## How it works

The Amazon Smart Thermostat has no local API, so this app talks to Amazon's Alexa cloud, the same way the Alexa app does. It uses the unofficial [`alexa-remote2`](https://github.com/Apollon77/alexa-remote) library. Your data only goes to Amazon, never to any third party.

Since the API is unofficial, Amazon could change it at any time and break things.

## Setup

You need Docker with Docker Compose, running on a machine on your home network (a home server, Raspberry Pi, NAS and so on).

```bash
git clone https://github.com/tthom289/smart-thermostat-dashboard.git
cd smart-thermostat-dashboard
cp .env.example .env        # set HOST_IP to this machine's LAN IP
mkdir -m 700 data           # holds your Amazon session
mkdir history grafana-data  # history database and Grafana's own data
docker compose up -d --build
```

> The containers run as user ID 1000. If your user ID isn't 1000 (check with `id -u`), run `sudo chown 1000:1000 data history grafana-data`.

Grafana downloads its SQLite plugin on first start, so the first launch needs internet access.

**Link your Amazon account:**

1. Open `http://<HOST_IP>:8890`. It shows a link to the sign-in page.
2. Sign in to Amazon at `http://<HOST_IP>:3001`. This is Amazon's real login page, passed through the app.
3. You're done. The session is saved to `data/alexa-cookie.json` and refreshes itself every few days.

To sign in again from scratch, delete `data/alexa-cookie.json` and run `docker compose restart`.

## History and energy tracking

The app logs everything it sees to `history.sqlite3` in `HISTORY_DIR`, and the History tab embeds a Grafana dashboard built on it. You can also open Grafana directly at `http://<HOST_IP>:3010`.

**What's logged:**

- **Readings, every poll:** thermostat temperature, humidity, setpoints, mode, fan, schedule period, and the remote sensor the thermostat is using (if any). Also every reading from air quality monitors.
- **HVAC run cycles:** when the heat, AC and blower turned on and off, and how long each ran.
- **Setting changes:** what changed and who most likely changed it: this app, the schedule, or "Alexa / thermostat" (the Alexa app, voice, or the thermostat itself).
- **Commands:** every command sent from this app, and whether Amazon accepted it.

**The dashboard shows:** runtime and cycle counts for the selected time range; temperature against setpoints; a timeline of when the system was heating or cooling; **runtime per day and per month**; humidity and air quality; and a searchable event log.

**Comparing with your energy bill:** set the time range to your billing period. The heating and cooling runtime totals are the closest thing to energy use this app can measure; the thermostat doesn't report kWh or gas usage. Runtime is measured from polls, so with the default 60-second poll each cycle is accurate to about a minute. Set `POLL_SECONDS=30` for finer detail.

Set `TZ` to your time zone so "per day" totals split at your local midnight. If you change it later, past days are recalculated automatically.

The database grows by roughly 200 MB a year at a 30-second poll (about half that at 60 seconds). Back up `HISTORY_DIR` like any other important data.

## Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `HOST_IP` | *(required)* | The LAN IP you open the page with. Also used for the sign-in link. |
| `EXTRA_ALLOWED_HOSTS` | *(empty)* | Other hostnames or IPs you'll open the page with, comma-separated (e.g. a hostname or a Tailscale IP). |
| `POLL_SECONDS` | `60` | How often to fetch the thermostat's state from Amazon. |
| `TZ` | `UTC` | Your time zone, e.g. `America/Chicago`. Used for per-day runtime totals. |
| `HISTORY_DIR` | `./history` | Folder for the history database. Point it at a large disk if you like. |
| `GRAFANA_PORT` | `3010` | Port for Grafana (the History tab). |
| `GRAFANA_ADMIN_PASSWORD` | *(required)* | Grafana admin password. Only needed to edit dashboards; viewing needs no login. |
| `DEBUG` | `0` | Set to `1` to log raw Amazon responses. These logs contain account and device identifiers. |

## Security

- **This is for your home network only. Never port-forward 8890, 3001 or 3010.** Grafana lets anyone on your network view the history without logging in (read-only). The page has no login of its own, so anyone who can reach it can change your temperature. For remote access, use a VPN such as Tailscale or WireGuard and add its address to `EXTRA_ALLOWED_HOSTS`.
- **`data/alexa-cookie.json` is an Amazon login.** Keep it private and never commit it (it's already in `.gitignore`).
- The container is locked down: read-only filesystem, all Linux capabilities dropped, `no-new-privileges`, and a 256 MB memory limit.
- A Host-header allow-list blocks DNS-rebinding attacks. Changes require a custom header and a JSON body, which blocks cross-site request forgery from other websites.

## Disclaimer

This is an independent project. It isn't affiliated with, endorsed by or supported by Amazon. "Amazon", "Alexa" and "Amazon Smart Thermostat" are trademarks of Amazon.com, Inc. or its affiliates.
