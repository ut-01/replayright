// display.test.js
//
// Xvfb itself is Linux-only and this suite runs on a Mac dev machine too, so most of
// what can be proven here without a live X server is the no-op paths. The spawn/dispose
// path only runs when an `Xvfb` binary is actually found on PATH (test.skip otherwise) -
// this file is written to also be correct on a real headless Linux CI box.
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const { ensureDisplay, findFreeDisplayNumber, socketPathFor } = require('../src/display');

function hasXvfb() {
  try {
    const result = spawnSync('which', ['Xvfb'], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

const XVFB_AVAILABLE = process.platform === 'linux' && hasXvfb();

test('ensureDisplay is a no-op when DISPLAY is already set', async () => {
  const original = process.env.DISPLAY;
  process.env.DISPLAY = ':7';
  try {
    const { display, dispose } = await ensureDisplay({ mode: 'auto' });
    assert.strictEqual(display, ':7');
    assert.doesNotThrow(() => dispose());
    // Must not have touched the env var it found already set.
    assert.strictEqual(process.env.DISPLAY, ':7');
  } finally {
    if (original === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = original;
  }
});

test('ensureDisplay is a no-op when mode is "off", regardless of platform or DISPLAY', async () => {
  const original = process.env.DISPLAY;
  delete process.env.DISPLAY;
  try {
    const { display, dispose } = await ensureDisplay({ mode: 'off' });
    assert.strictEqual(display, undefined);
    assert.doesNotThrow(() => dispose());
    assert.strictEqual(process.env.DISPLAY, undefined);
  } finally {
    if (original === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = original;
  }
});

test('ensureDisplay is a no-op on a non-Linux platform even with no DISPLAY set', { skip: process.platform === 'linux' }, async () => {
  const original = process.env.DISPLAY;
  delete process.env.DISPLAY;
  try {
    const { dispose } = await ensureDisplay({ mode: 'auto' });
    assert.doesNotThrow(() => dispose());
    // Never spawned anything, so DISPLAY stays unset.
    assert.strictEqual(process.env.DISPLAY, undefined);
  } finally {
    if (original === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = original;
  }
});

test('findFreeDisplayNumber returns a number with no existing socket', () => {
  const n = findFreeDisplayNumber(99);
  assert.strictEqual(typeof n, 'number');
  const { existsSync } = require('node:fs');
  assert.ok(!existsSync(socketPathFor(n)));
});

test(
  'ensureDisplay spawns Xvfb, picks a free display, and dispose() reaps the process',
  { skip: XVFB_AVAILABLE ? false : 'Xvfb binary not found on PATH (expected on non-Linux dev machines)' },
  async () => {
    const original = process.env.DISPLAY;
    delete process.env.DISPLAY;
    try {
      const { display, dispose } = await ensureDisplay({ mode: 'auto', screen: '1024x768x24' });
      assert.match(display, /^:\d+$/);
      assert.strictEqual(process.env.DISPLAY, display);

      const displayNumber = display.slice(1);
      const { existsSync } = require('node:fs');
      assert.ok(existsSync(socketPathFor(displayNumber)), 'Xvfb should have created its X11 socket');

      dispose();

      // Give the SIGTERM a moment to land and the socket to be cleaned up.
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.ok(!existsSync(socketPathFor(displayNumber)), 'the X11 socket should be gone after dispose()');
    } finally {
      if (original === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = original;
    }
  }
);

test(
  'ensureDisplay throws a clear, actionable error when the Xvfb binary is missing',
  { skip: process.platform === 'linux' ? (XVFB_AVAILABLE ? 'Xvfb is installed on this box; cannot exercise the missing-binary path' : false) : 'binary-missing path only spawns on Linux' },
  async () => {
    const original = process.env.DISPLAY;
    delete process.env.DISPLAY;
    try {
      await assert.rejects(
        () => ensureDisplay({ mode: 'auto' }),
        (err) => {
          assert.match(err.message, /Xvfb/);
          assert.match(err.message, /apt-get install/);
          return true;
        }
      );
    } finally {
      if (original === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = original;
    }
  }
);

// Regression tests for a bug found during review: dispose() killed the Xvfb child but
// never cleared process.env.DISPLAY, so a SECOND ensureDisplay({mode:'auto'}) call in the
// same process (e.g. one site after another in `run --all`) found DISPLAY still set to
// the now-dead socket, hit the "already usable" no-op short-circuit, and handed its
// caller a display nothing was listening on - a real headed launch silently regressing to
// a broken one. Fixed by having dispose() clear DISPLAY (only if it still points at the
// display this call owns), and by having 'auto' mode reference-count concurrent/
// sequential callers in-process so they share one Xvfb instead of racing to spawn their
// own or tearing it down while a sibling is still using it.
test(
  'a second sequential ensureDisplay() call after dispose() spawns a fresh, working display - not a stale no-op',
  { skip: XVFB_AVAILABLE ? false : 'Xvfb binary not found on PATH (expected on non-Linux dev machines)' },
  async () => {
    const original = process.env.DISPLAY;
    delete process.env.DISPLAY;
    try {
      const first = await ensureDisplay({ mode: 'auto' });
      assert.match(first.display, /^:\d+$/);
      first.dispose();
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.strictEqual(process.env.DISPLAY, undefined, 'dispose() should have cleared DISPLAY');

      const second = await ensureDisplay({ mode: 'auto' });
      assert.match(second.display, /^:\d+$/);
      const { existsSync } = require('node:fs');
      assert.ok(existsSync(socketPathFor(second.display.slice(1))), 'the second call should have spawned its own live Xvfb, not reused a dead one');
      second.dispose();
    } finally {
      if (original === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = original;
    }
  }
);

test(
  'two concurrent auto-mode ensureDisplay() calls share one Xvfb; it is only torn down once BOTH dispose',
  { skip: XVFB_AVAILABLE ? false : 'Xvfb binary not found on PATH (expected on non-Linux dev machines)' },
  async () => {
    const original = process.env.DISPLAY;
    delete process.env.DISPLAY;
    try {
      const [a, b] = await Promise.all([ensureDisplay({ mode: 'auto' }), ensureDisplay({ mode: 'auto' })]);
      assert.strictEqual(a.display, b.display, 'concurrent auto-mode calls should share one display, not spawn two');

      const { existsSync } = require('node:fs');
      const socket = socketPathFor(a.display.slice(1));
      assert.ok(existsSync(socket));

      a.dispose();
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.ok(existsSync(socket), 'the shared Xvfb must still be alive - b has not disposed yet');
      assert.strictEqual(process.env.DISPLAY, a.display, 'DISPLAY must not be cleared while a sibling still holds a reference');

      b.dispose();
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.ok(!existsSync(socket), 'the shared Xvfb should be gone once the last reference disposes');
    } finally {
      if (original === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = original;
    }
  }
);
