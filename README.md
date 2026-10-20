<p align="center"><img src="docs/img/icon.png" alt="SZ-AI NOC Wall" width="112"></p>

# SZ-AI NOC Wall

A **server-side NOC wall display for RUCKUS AI and RUCKUS SmartZone.** One small server collects the data; any browser on your network (wall TVs, kiosks,
laptops) shows live, customizable dashboards. Connect **RUCKUS AI**, **SmartZone controllers directly**, or **both at once**: each screen shows one source,
and the editor only offers the widgets and screens that work with it.

<p align="center"><img src="docs/img/overview.png" alt="RUCKUS AI overview screen (demo data)" width="49%"> <img src="docs/img/sz-overview.png" alt="SmartZone overview screen (demo data)" width="49%"></p>
<p align="center"><sub>The same wall on RUCKUS AI (left) and on SmartZone (right). Screenshots use synthetic demo data.</sub></p>

> **Status: 0.1, early.** RUCKUS AI is confirmed against a live tenant. SmartZone is confirmed against a live SmartZone 7.2 (API v14_0) for zones, APs, WLANs and
> the controller; clients, alarms, DPSK, VLAN pools, Wi-Fi calling policies, controller load, switches and switch ports are confirmed too; guest passes and the switch event log are confirmed as well. The Windows builds are untested on a real Windows machine.

## Features

**Two data sources, side by side**
- **RUCKUS AI**: controllers and their onboarding state, zones and switch groups, every AP and switch (status, model, firmware, IP, wired clients), open incidents as alarms,
  Intent AI recommendations, and connection experience (network-wide and per zone). One Application Token.
- **SmartZone, direct** (for sites without RUCKUS AI): zones, APs with live status / model / firmware / IP / client counts / channel widths, WLANs, clients, alarms, DPSK users, VLAN pools, Wi-Fi calling policies, controller CPU / memory / disk, and ICX switches with their ports (status, PoE, CPU, memory, neighbours), from one or many
  controllers. Signs in with a read-only administrator (service ticket); passwords are write-only.
- **On / off per source and per controller.** Both can be on together; **each screen shows exactly one source**, never a mix. Stock screens, history and alerts follow the source.
- **Only what can work is offered.** Every widget and screen knows which sources it can show; the picker leaves out the impossible ones (with *RUCKUS AI only* / *SmartZone only* tags and a
  "For this screen / RUCKUS AI / SmartZone / Everything" switch), and presets are offered whole. Widgets that showed no data when tested are tagged *unverified* (shown by default, hide them with one setting);
  `npm run widgets:check` measures this against your own tenant or controller.

**Dashboards you design**
- A browser-based **editor** with a searchable catalog of widgets (KPIs, donuts, bars, tables, lists, trends, gauges, history comparisons), a drag-and-drop **layout designer** with
  chart previews, auto-fit tiling, multi-display video walls with per-display playlists, views and time-of-day schedules, per-tile thresholds, and zone drill-down.
- A scrolling **ticker** (custom messages, RSS news, weather, stock quotes) and a message board.
- Light and dark themes, a scale option for far-away TVs, kiosk-friendly URLs.

**Alerts and reports**
- **Rules** on alarms, offline APs, clients, connection success, incidents and more, with severity, hold times, reminders and acknowledgement; critical rules **take over every screen** until acknowledged.
- Notifications to **Slack, Microsoft Teams, email (SMTP) and webhooks**.
- Scheduled, printable **reports** (saved as HTML, emailed, print to PDF), and 30 days of metric history for trends and "vs yesterday / last week".

**Run it anywhere, safely**
- **Virtual appliance (OVA)**, **macOS app**, **Windows installer / zip**, or **from source** (Node 22.5+, nothing to install).
- HTTPS with a generated or your own certificate, an editor sign-in, view keys, encrypted full backups, and **in-app software updates** from a release file.
- No credentials in the browser: the server is the only thing that talks to RUCKUS AI or your controllers, and it only ever reads.

## Screens

### RUCKUS AI

<p><img src="docs/img/zones.png" alt="Zones and AP breakdowns" width="49%"> <img src="docs/img/switches.png" alt="Switches" width="49%"></p>
<p><img src="docs/img/intent-ai.png" alt="Intent AI recommendations" width="49%"> <img src="docs/img/connection-health.png" alt="Connection health" width="49%"></p>

Controllers, zones, every AP and switch, incidents, Intent AI, and connection success by stage (network-wide and per zone).

### SmartZone

<p><img src="docs/img/sz-zones.png" alt="SmartZone zones" width="49%"> <img src="docs/img/sz-networks.png" alt="SmartZone Wi-Fi networks" width="49%"></p>
<p><img src="docs/img/sz-clients.png" alt="SmartZone clients" width="49%"> <img src="docs/img/takeover.png" alt="Alert takeover" width="49%"></p>

Zones with AP and client counts, WLANs by SSID / security / VLAN, clients, and the alert takeover that covers every screen.

### The editor

<p><img src="docs/img/connections.png" alt="Data sources and connections" width="49%"> <img src="docs/img/picker.png" alt="Widget picker with source tags" width="49%"></p>
<p><img src="docs/img/designer-charts.png" alt="Layout designer" width="49%"> <img src="docs/img/history.png" alt="History comparisons" width="49%"></p>

Connect each source with its own on / off, pick widgets (tagged by source), arrange them in the layout designer, and compare now against yesterday or last week.

## Get it

Download from the [Releases page](../../releases):

| | |
|---|---|
| `SZ-AI-NOC-Wall-x.y.z.ova` | virtual appliance (VMware, VirtualBox, Proxmox): import, power on, sign in at `https://<ip>/admin` |
| `SZ-AI-NOC-Wall-x.y.z-mac.dmg` | macOS menu-bar app (Apple silicon and Intel; right-click, Open the first time) |
| `SZ-AI-NOC-Wall-x.y.z-win-x64-setup.exe` / `.zip` | Windows installer / portable (unsigned, untested on real Windows) |
| `sz-ai-noc-x.y.z.tgz` | the release file used by the in-app *Software update* |

From source:

```bash
git clone https://github.com/TerryHenry/sz-ai-noc.git && cd sz-ai-noc
npm run demo:ai    # RUCKUS AI demo, no credentials  → http://<server-ip>:8080
npm run demo:sz    # SmartZone demo
npm start          # real data: open http://<server-ip>:8080/admin and connect a source
```

Then follow the [Getting started guide](docs/GETTING_STARTED.md): about 15 minutes from download to a live wall. The [User guide](docs/USER_GUIDE.md) covers every setting.

## Connecting

- **RUCKUS AI:** create an **Application Token** (Administration → Developers → Application Tokens). RUCKUS One API keys do not work.
- **SmartZone:** add each controller's address with a **read-only administrator**'s user name and password. There is no API key.

## Tests

```bash
npm test    # 30 tests, ~5 s: backups and secrets, the SmartZone client, source and preset rules, and the whole server against
            # a synthetic RUCKUS AI and SmartZone (test/mocks), no credentials or network needed (uses the openssl CLI for a throw-away certificate)
```

## Roadmap

1. **RUCKUS AI**: more of the analytics (health KPIs per system) where RUCKUS AI returns them for SmartZone.
2. **SmartZone**: confirm client and alarm fields on a controller that has them; switches if the controller exposes them; events.
3. Notarized macOS and signed Windows builds.

Built from [R1 NOC Wall](https://github.com/TerryHenry/r1-noc)'s dashboard engine, editor, alerts, HTTPS, backup, upgrade and packaging.

*Released under the [MIT License](LICENSE). Unofficial tool, not an official RUCKUS / CommScope product.*
