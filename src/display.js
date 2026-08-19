// display.js
//
// A `requiresHeaded` flow (see headless-probe.js and Phase 1.3) needs a real X server to
// launch a headed Chromium against. On a developer's laptop that's whatever `DISPLAY`
// the desktop session already provides. On a headless Linux box - the actual point of a
// scheduled `play` run - there is none, and CLAUDE.md is explicit about the failure mode
// that must never happen here: silently falling back to headless produces a run that
// "succeeds" with plausible-looking empty output, because the site's bot protection
// (the whole reason requiresHeaded got set) blocks the headless request. So this module
// either gets a real display working, or it throws - it never degrades quietly.
//
// ensureDisplay() manages its own Xvfb child rather than shelling out to `xvfb-run`,
// because self-managing means we know the exact display number we picked and can kill
// exactly that process in dispose() - `xvfb-run -a` hides both from us.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const X11_SOCKET_DIR = '/tmp/.X11-unix';
const FIRST_DISPLAY_TO_TRY = 99;
const SOCKET_POLL_TIMEOUT_MS = 5000;
const SOCKET_POLL_INTERVAL_MS = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A no-op handle: `display` reflects whatever the environment already has (possibly
// undefined), and `dispose` is safe to call unconditionally by every caller regardless
// of which path was taken.
function noopHandle() {
  return { display: process.env.DISPLAY, dispose: () => {} };
}

// `/tmp/.X11-unix/X<N>` is the well-known per-display Unix socket every X server
// (Xvfb included) creates on Linux. Its absence is exactly "no server is listening on
// that display number", which is what we need to find a free one and, later, to confirm
// Xvfb actually came up.
function socketPathFor(displayNumber) {
  return path.join(X11_SOCKET_DIR, `X${displayNumber}`);
}

function findFreeDisplayNumber(startAt = FIRST_DISPLAY_TO_TRY) {
  let n = startAt;
  while (fs.existsSync(socketPathFor(n))) n += 1;
  return n;
}

async function waitForSocket(displayNumber, timeoutMs = SOCKET_POLL_TIMEOUT_MS) {
  const sock = socketPathFor(displayNumber);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(sock)) return true;
    await sleep(SOCKET_POLL_INTERVAL_MS);
  }
  return false;
}

// Spawns `Xvfb :N -screen 0 <screen> -nolisten tcp`, detached from this process's own
// process group. Detached matters here specifically: Node's default SIGINT/SIGTERM
// handling (and the shell's own job-control signal propagation to a foreground process
// group) would otherwise kill Xvfb the instant the parent gets the same signal, before
// our own `dispose()` runs deliberately in the `finally` block that also closes the
// browser. `-nolisten tcp` is the standard "local-only, no network X11" hardening flag.
function spawnXvfb(displayNumber, screen) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('Xvfb', [`:${displayNumber}`, '-screen', '0', screen, '-nolisten', 'tcp'], {
        detached: true,
        stdio: 'ignore',
      });
    } catch (err) {
      reject(err);
      return;
    }

    const onEarlyError = (err) => reject(err);
    child.once('error', onEarlyError);
    // Give spawn's async ENOENT/EACCES a tick to surface before we declare success -
    // `spawn` reports those via the 'error' event, not a thrown exception, because the
    // failure happens after this function has already returned a ChildProcess.
    setImmediate(() => {
      child.removeListener('error', onEarlyError);
      resolve(child);
    });
  });
}

function isMissingBinaryError(err) {
  return err && (err.code === 'ENOENT' || err.code === 'EACCES');
}

// Kills the Xvfb child and any of its own children by targeting the whole detached
// process group (negative pid), so nothing orphaned survives dispose(). Idempotent -
// safe to call more than once (e.g. once from a signal handler and once from the
// caller's own `finally`).
function killDetached(child) {
  if (!child || child.killed) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
}

// mode: 'auto' | 'off' | ':N' (explicit display number, e.g. ':50').
// screen: Xvfb's `-screen 0` spec, e.g. '1920x1080x24'.
//
// Returns { display, dispose }. `dispose()` is always safe to call - including on every
// no-op path - so callers can put it in one unconditional `finally` alongside closing
// the browser, rather than tracking whether Xvfb was actually spawned.
async function ensureDisplay({ mode = 'auto', screen = '1920x1080x24' } = {}) {
  if (mode === 'off') return noopHandle();

  // Guard defensively even though deciding whether to call this at all (e.g. "we're
  // running headless, skip it") is the caller's job - a caller that calls us anyway
  // when DISPLAY is already usable, or on a platform where Xvfb makes no sense, should
  // still get an inert handle rather than a spawn attempt.
  if (process.env.DISPLAY) return noopHandle();
  if (process.platform !== 'linux') return noopHandle();

  const displayNumber = mode === 'auto' || mode === undefined
    ? findFreeDisplayNumber()
    : parseDisplayNumber(mode);

  let child;
  try {
    child = await spawnXvfb(displayNumber, screen);
  } catch (err) {
    if (isMissingBinaryError(err)) {
      throw new Error(
        `Xvfb is not installed (needed to run a requiresHeaded flow without a real X display). `
        + `Install it with: apt-get install -y xvfb (Debian/Ubuntu) or yum install -y xorg-x11-server-Xvfb (RHEL/CentOS).`
      );
    }
    throw err;
  }

  const up = await waitForSocket(displayNumber);
  if (!up) {
    killDetached(child);
    throw new Error(
      `Xvfb did not create its display socket (${socketPathFor(displayNumber)}) within `
      + `${SOCKET_POLL_TIMEOUT_MS}ms of starting on display :${displayNumber}.`
    );
  }

  const display = `:${displayNumber}`;
  process.env.DISPLAY = display;

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    killDetached(child);
  };

  // An orphaned Xvfb per cron run is a real leak on a long-lived box: register the same
  // dispose on every path that could end the process without the caller's own `finally`
  // ever running (an uncaught exception elsewhere, Ctrl-C, `kill`).
  process.on('exit', dispose);
  process.on('SIGINT', dispose);
  process.on('SIGTERM', dispose);

  return { display, dispose };
}

function parseDisplayNumber(mode) {
  const match = /^:(\d+)$/.exec(mode);
  if (!match) throw new Error(`invalid --display value "${mode}" - expected "auto", "off", or ":<N>" (e.g. ":50")`);
  return Number(match[1]);
}

module.exports = { ensureDisplay, findFreeDisplayNumber, socketPathFor };
