// headless-probe.js
//
// The "curl equivalent" check: one plain HTTP request, no browser at all, used to guess
// whether a site is likely to block headless Chromium the way it would block any other
// non-browser client. This is a proxy, not a proof - a plain request and headless Chromium
// have different network-layer fingerprints (TLS/HTTP2 handshake shape, in particular), so
// a site COULD block one and not the other in either direction. It is, however, cheap (one
// request, no browser launch) and self-corrects on every record/verify run rather than
// needing to be diagnosed and hand-set once.
const { HEADLESS_PROBE_TIMEOUT_MS } = require('./constants');

// Deliberately NOT a browser User-Agent - the point is to resemble the kind of request a
// scheduled headless run most closely approximates at the network layer, not to pass as a
// real browser.
const USER_AGENT = 'curl/8.0';

// `timeoutMs` is config.js's `timeouts.probeMs` - cli.js resolves and passes it once a
// config is loaded. Defaults to the constants.js value, so a caller that knows nothing
// about config.js (every existing test, and any direct call) is unaffected.
async function probeRequiresHeaded(url, { timeoutMs = HEADLESS_PROBE_TIMEOUT_MS } = {}) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return { requiresHeaded: true, reason: `plain HTTP request got ${res.status} ${res.statusText}` };
    }
    return { requiresHeaded: false, reason: `plain HTTP request succeeded (${res.status})` };
  } catch (err) {
    return { requiresHeaded: true, reason: `plain HTTP request failed: ${err.message}` };
  }
}

module.exports = { probeRequiresHeaded };
