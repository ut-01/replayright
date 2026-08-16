// The "curl equivalent" bot-protection check, exercised against a tiny local HTTP server -
// no live network needed, no flakiness from a real site changing its own bot-detection
// posture out from under this test.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { probeRequiresHeaded } = require('../src/headless-probe');

// Starts a bare http server that always responds the same way, and returns its base URL
// plus a teardown function - same shape across every test below, so each test only needs
// to say how the server should respond.
function withServer(respond) {
  return new Promise((resolve) => {
    const server = http.createServer(respond);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => server.close() });
    });
  });
}

test('a plain 200 response means the site does not need headed mode', async () => {
  const { url, close } = await withServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  try {
    const { requiresHeaded, reason } = await probeRequiresHeaded(url);
    assert.strictEqual(requiresHeaded, false);
    assert.match(reason, /succeeded \(200\)/);
  } finally {
    close();
  }
});

test('a 403 - the classic bot-block status - flags the site as requiring headed mode', async () => {
  const { url, close } = await withServer((_req, res) => { res.writeHead(403); res.end('blocked'); });
  try {
    const { requiresHeaded, reason } = await probeRequiresHeaded(url);
    assert.strictEqual(requiresHeaded, true);
    assert.match(reason, /403/);
  } finally {
    close();
  }
});

test('a connection that never responds (protocol-level rejection stand-in) also flags requiresHeaded', async () => {
  // Standing in for the user's real ERR_HTTP2_PROTOCOL_ERROR: a socket that opens and then
  // hangs up without ever sending a response, so fetch() rejects rather than resolving.
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  server.on('connection', (socket) => socket.destroy());
  try {
    const { requiresHeaded, reason } = await probeRequiresHeaded(`http://127.0.0.1:${port}/`);
    assert.strictEqual(requiresHeaded, true);
    assert.match(reason, /plain HTTP request failed/);
  } finally {
    server.close();
  }
});

test('a redirect to a page that ultimately succeeds is followed, not treated as a block', async () => {
  const { url, close } = await withServer((req, res) => {
    if (req.url === '/') { res.writeHead(302, { Location: '/final' }); res.end(); }
    else { res.writeHead(200); res.end('ok'); }
  });
  try {
    const { requiresHeaded } = await probeRequiresHeaded(url);
    assert.strictEqual(requiresHeaded, false);
  } finally {
    close();
  }
});
