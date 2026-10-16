# Changelog

## 0.1.0 (in development)
- Started from R1 NOC Wall 0.3.9 (same dashboard engine, editor, alerts, HTTPS, backup, in-place upgrade and packaging), renamed to **SZ-AI NOC Wall**.
- Goal: a NOC wall for **RUCKUS AI** (ruckus.cloud/ai) first, then **RUCKUS SmartZone** controllers.
- Live data now comes from RUCKUS AI: SmartZone controllers (with onboarding state), zones and switch groups, every AP and switch, open incidents as alarms and Intent AI recommendations. Sign in with an Application Token (Administration → Developers → Application Tokens); RUCKUS One API keys do not work.
- New RUCKUS AI widgets (controllers healthy, controller table, APs by controller, Intent AI) and new default screens (Overview, Zones, Switches, Intent AI). Per-client lists, DPSK, guests, Wi-Fi calling and switch-port widgets have no RUCKUS AI data source.
- **Data source choice**: a wall reads either RUCKUS AI or SmartZone controllers directly (new `lib/sz.js`: public API client with API-version and API-key-style detection, paging, per-controller TLS setting). SmartZone reads zones, APs (status, model, firmware, IP, clients, channels), WLANs and controller info (field names confirmed on a SmartZone 7.2); clients and alarms are mapped but unconfirmed; the widget picker, presets and stock screens follow the chosen source. `scripts/widget-check.js --source smartzone` measures a controller.
- The editor's connection panel is "RUCKUS AI connection" (client ID, secret, optional tenant ID, region). MSP and per-customer modes are hidden.
