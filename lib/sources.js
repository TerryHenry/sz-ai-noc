'use strict';
// Which data sources this wall reads. RUCKUS AI and SmartZone can both be enabled at once; each screen shows exactly one of them.
//   enabled()  -> ['rai', 'smartzone'] subset, in the order the wall prefers them
//   primary()  -> the source used when a screen does not name one (cfg.source if enabled, else the first enabled)
//   of(screen) -> the source a screen shows: its own `source` if that one is enabled, else primary()
const cfg = require('./config');

const aiConfigured = () => Boolean(cfg.r1.clientId && cfg.r1.clientSecret);
const szControllers = () => ((cfg.sz && cfg.sz.controllers) || []).filter((c) => c.enabled !== false && c.host && c.username && c.password);
function enabled() {
  if (cfg.demo) return [cfg.source];   // the demo generator plays one source at a time (NOC_DEMO_SZ / NOC_DEMO_AI pick which)
  const out = [];
  if (cfg.aiEnabled !== false && aiConfigured()) out.push('rai');
  if (szControllers().length) out.push('smartzone');
  return out;
}
function primary() { const on = enabled(); return on.includes(cfg.source) ? cfg.source : on[0] || cfg.source; }
function of(screen) { const on = enabled(); const s = screen && screen.source; return s && on.includes(s) ? s : primary(); }
module.exports = { enabled, primary, of, szControllers, aiConfigured };
