<p align="center"><img src="docs/img/icon.png" alt="SZ-AI NOC Wall" width="112"></p>

# SZ-AI NOC Wall

A **server-side NOC wall display for RUCKUS AI** (ruckus.cloud/ai) and, next, **RUCKUS SmartZone** controllers. One small
server collects the data; any browser on your network — wall TVs, kiosks, laptops — shows live, customizable dashboards.

> **Status: early development (0.1).** Live data from **RUCKUS AI** works: SmartZone controllers and their onboarding state, zones, every AP and
> switch, open incidents as alarms and Intent AI recommendations. Connect with a RUCKUS AI **Application Token**
> (Administration → Developers). RUCKUS AI has no per-client, switch-port, DPSK or guest data, so widgets built on those are hidden; run
> `npm run widgets:check` to see what works on your tenant. Built from [R1 NOC Wall](https://github.com/TerryHenry/r1-noc)'s dashboard engine,
> editor, alerts, HTTPS, backup, upgrade and packaging. Docs: [Getting started](docs/GETTING_STARTED.md) · [User guide](docs/USER_GUIDE.md).
> The screenshots in the docs were taken on the RUCKUS One version and will be retaken.

<p align="center"><img src="docs/img/overview.png" alt="SZ-AI NOC Wall overview screen (demo data)" width="800"></p>

## Roadmap

1. **RUCKUS AI** — *in progress.* Done: controllers, zones, APs, switches, incidents, Intent AI. Next: more of the analytics (health KPIs per system), if RUCKUS AI returns them for SmartZone.
2. **SmartZone** — live controller data (zones, APs, clients, WLANs, alarms, switches) from the SmartZone public API, one or many controllers.
3. Branding, docs, appliance / Mac / Windows releases.

## Running it (development)

```bash
npm run demo     # synthetic data, no credentials → http://<server-ip>:8080
npm run demo:ai   # demo limited to what RUCKUS AI supplies (the screenshots)
npm start        # real data
```

*Released under the [MIT License](LICENSE). Unofficial tool — not an official RUCKUS / CommScope product.*
