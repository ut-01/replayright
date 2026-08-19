const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { clearTrackingData } = require('../src/profile');
const { recordSite, sitePaths } = require('../src/record');

// A minimal local page - these tests care about which profile dir a session launches
// against and what happens to it, not about anything recorded from the page itself.
const fixtureUrl = pathToFileURL(path.join(__dirname, 'fixtures', 'paged', 'page1.html')).href;

const PROFILE_TEST_SITE_IDS = [
  '_test_profile_cleartracking',
  '_test_profile_persist_false',
  '_test_profile_persist_true',
  '_test_profile_dir_override',
];

test.after(() => {
  for (const siteId of PROFILE_TEST_SITE_IDS) {
    fs.rmSync(sitePaths(siteId).dir, { recursive: true, force: true });
    fs.rmSync(path.join(os.tmpdir(), `playright-profile-${siteId}`), { recursive: true, force: true });
  }
});

function touch(...segments) {
  const full = path.join(...segments);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'x');
}

function mkdirWithFile(dir, fileName) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), 'x');
}

test('clearTrackingData removes cookies/storage/preferences but leaves the cache alone', () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playright-profile-test-'));

  mkdirWithFile(path.join(profileDir, 'Default', 'Network'), 'Cookies');
  mkdirWithFile(path.join(profileDir, 'Default', 'Local Storage'), 'leveldb');
  mkdirWithFile(path.join(profileDir, 'Default', 'Session Storage'), 'leveldb');
  mkdirWithFile(path.join(profileDir, 'Default', 'IndexedDB'), 'some.indexeddb');
  touch(profileDir, 'Default', 'Preferences');
  touch(profileDir, 'Default', 'Secure Preferences');
  touch(profileDir, 'Default', 'TransportSecurity');
  touch(profileDir, 'Default', 'Cookies');

  // Untouched by design: nothing here identifies a user or a session, only what has
  // already been fetched.
  mkdirWithFile(path.join(profileDir, 'Default', 'Cache'), 'some-cached-asset');
  mkdirWithFile(path.join(profileDir, 'Default', 'Media Cache'), 'some-cached-video');

  clearTrackingData(profileDir);

  for (const p of ['Default/Network', 'Default/Local Storage', 'Default/Session Storage', 'Default/IndexedDB',
    'Default/Preferences', 'Default/Secure Preferences', 'Default/TransportSecurity', 'Default/Cookies']) {
    assert.ok(!fs.existsSync(path.join(profileDir, p)), `${p} should have been removed`);
  }

  assert.ok(fs.existsSync(path.join(profileDir, 'Default', 'Cache', 'some-cached-asset')), 'the disk cache must survive');
  assert.ok(fs.existsSync(path.join(profileDir, 'Default', 'Media Cache', 'some-cached-video')), 'the media cache must survive');

  fs.rmSync(profileDir, { recursive: true, force: true });
});

test('clearTrackingData is a silent no-op against a profile dir that does not exist yet', () => {
  const profileDir = path.join(os.tmpdir(), 'playright-profile-never-created-' + process.pid);
  assert.doesNotThrow(() => clearTrackingData(profileDir));
});

// --------------------------------------------------------------------------------------
// Phase 5.3: recordSite() actually wiring clearTracking/persist/dir through, not just
// profile.js's clearTrackingData() in isolation.
// --------------------------------------------------------------------------------------

test('clearTracking: true wipes tracking data both before launch and after the session closes', async () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playright-profile-cleartest-'));
  // A "leftover from a previous session" marker, in a path clearTrackingData removes
  // wholesale. If the before-launch wipe runs, this must be gone by the time `drive`
  // gets to inspect the live session.
  const staleMarker = path.join(profileDir, 'Default', 'Local Storage', 'STALE-MARKER');
  fs.mkdirSync(path.dirname(staleMarker), { recursive: true });
  fs.writeFileSync(staleMarker, 'x');

  let staleMarkerGoneAtLaunch = null;
  let midSessionMarker;

  await recordSite({
    siteId: '_test_profile_cleartracking',
    url: fixtureUrl,
    headless: true,
    userDataDir: profileDir,
    clearTracking: true,
    drive: async () => {
      staleMarkerGoneAtLaunch = !fs.existsSync(staleMarker);

      // Plant a fresh marker mid-session, in the same tracking path, to prove the
      // after-close wipe runs too (not just the before-launch one).
      fs.mkdirSync(path.dirname(staleMarker), { recursive: true });
      midSessionMarker = path.join(profileDir, 'Default', 'Local Storage', 'MID-SESSION-MARKER');
      fs.writeFileSync(midSessionMarker, 'x');
    },
  });

  assert.strictEqual(staleMarkerGoneAtLaunch, true,
    'the before-launch clearTrackingData call should have removed the pre-existing marker');
  assert.ok(!fs.existsSync(midSessionMarker),
    'the after-close clearTrackingData call should have removed the marker planted mid-session');

  fs.rmSync(profileDir, { recursive: true, force: true });
});

test('persist: false launches against a fresh per-run temp dir, not the stable playright-profile-<id> dir, and removes it afterward', async () => {
  const siteId = '_test_profile_persist_false';
  const stableDir = path.join(os.tmpdir(), `playright-profile-${siteId}`);
  fs.rmSync(stableDir, { recursive: true, force: true });

  let observedProfileDir = null;

  await recordSite({
    siteId,
    url: fixtureUrl,
    headless: true,
    persist: false,
    drive: async () => {
      const match = fs.readdirSync(os.tmpdir()).find((e) => e.startsWith(`playright-profile-${siteId}-`));
      assert.ok(match, 'expected a uniquely-named ephemeral profile dir under os.tmpdir()');
      observedProfileDir = path.join(os.tmpdir(), match);
      assert.ok(fs.existsSync(observedProfileDir), 'the ephemeral profile dir should exist while the session is live');
    },
  });

  assert.ok(observedProfileDir, 'drive should have observed an ephemeral profile dir');
  assert.notStrictEqual(observedProfileDir, stableDir,
    'persist: false must not reuse the stable playright-profile-<id> dir');
  assert.ok(!fs.existsSync(observedProfileDir), 'the ephemeral profile dir should be removed once the run ends');
  assert.ok(!fs.existsSync(stableDir), 'persist: false must not create the stable per-site dir either');
});

test('persist: true (default) uses the stable playright-profile-<id> dir and leaves it in place afterward', async () => {
  const siteId = '_test_profile_persist_true';
  const stableDir = path.join(os.tmpdir(), `playright-profile-${siteId}`);
  fs.rmSync(stableDir, { recursive: true, force: true });

  await recordSite({
    siteId,
    url: fixtureUrl,
    headless: true,
    drive: async () => {},
  });

  assert.ok(fs.existsSync(stableDir), 'the stable per-site profile dir should exist and persist after the run');

  fs.rmSync(stableDir, { recursive: true, force: true });
});

test('profile.dir, when set, is used as the launch directory instead of the stable per-site path', async () => {
  const siteId = '_test_profile_dir_override';
  const stableDir = path.join(os.tmpdir(), `playright-profile-${siteId}`);
  fs.rmSync(stableDir, { recursive: true, force: true });
  const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playright-custom-profile-'));

  await recordSite({
    siteId,
    url: fixtureUrl,
    headless: true,
    dir: customDir,
    drive: async () => {},
  });

  assert.ok(fs.existsSync(path.join(customDir, 'Default')),
    'chromium should have written its profile data into the custom dir');
  assert.ok(!fs.existsSync(stableDir),
    'the stable per-site dir should never have been created when profile.dir is set');

  fs.rmSync(customDir, { recursive: true, force: true });
});
