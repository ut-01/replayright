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
