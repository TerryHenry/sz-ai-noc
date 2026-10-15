<p align="center"><img src="docs/img/icon.png" alt="SZ-AI NOC Wall" width="112"></p>

# SZ-AI NOC Wall

A **server-side NOC wall display for RUCKUS AI** (ruckus.cloud/ai) and, next, **RUCKUS SmartZone** controllers. One small
server collects the data; any browser on your network — wall TVs, kiosks, laptops — shows live, customizable dashboards.

> **Status: early development.** This project starts from [R1 NOC Wall](https://github.com/TerryHenry/r1-noc) — its dashboard engine,
> editor, alerts and notifications, HTTPS, backup/restore, in-place upgrade and packaging (appliance, macOS, Windows) — and is being
> re-pointed at RUCKUS AI. The documentation in `docs/` still describes R1 NOC Wall and will be rewritten as the RUCKUS AI and
> SmartZone data sources land.

## Roadmap

1. **RUCKUS AI** — network health and KPIs, connection experience by stage, incidents across controllers/zones, Intent AI
   recommendations, top applications / SSIDs / APs, switch health, per system / zone / AP group views.
2. **SmartZone** — live controller data (zones, APs, clients, WLANs, alarms, switches) from the SmartZone public API, one or many controllers.
3. Branding, docs, appliance / Mac / Windows releases.

## Running it (development)

```bash
npm run demo     # synthetic data, no credentials → http://<server-ip>:8080
npm start        # real data
```

*Released under the [MIT License](LICENSE). Unofficial tool — not an official RUCKUS / CommScope product.*
