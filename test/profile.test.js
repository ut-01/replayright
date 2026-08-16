const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { clearTrackingData } = require('../src/profile');

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
