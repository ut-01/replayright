// profile.js
//
// Wipes the identity-carrying parts of a Chromium persistent profile - cookies, local/
// session storage, IndexedDB, and the profile-level Preferences files - while leaving
// everything else (the disk/media Cache, extension state if any) untouched. Opt-in (see
// record.js's `clearTracking` option): unlike a from-scratch recorder, replayright's
// default is to let cookie banners and login state persist across sessions the same
// stable profile dir already provides - clearing on every run would break any flow that
// depends on being logged in. Paths verified against a modern (Network Service era,
// M80+) Chromium profile layout; a major Chromium upgrade bundled with Playwright could
// in principle move one of these, in which case this silently becomes a no-op for that
// one path (each removal is existence-guarded) rather than an error - worth re-checking
// after upgrading playwright-core if tracking data turns up persisting again.
const fs = require('fs');
const path = require('path');

const TRACKING_DIRS = [
  'Default/Network', // cookies (modern Chromium) + network/HSTS state
  'Default/Local Storage',
  'Default/Session Storage',
  'Default/IndexedDB',
];

const TRACKING_FILES = [
  'Default/Preferences',
  'Default/Secure Preferences',
  'Default/TransportSecurity',
  'Default/Cookies', // legacy location, pre-Network-Service Chromium
];

function clearTrackingData(profileDir) {
  if (!fs.existsSync(profileDir)) return;

  for (const dir of TRACKING_DIRS) {
    const full = path.join(profileDir, dir);
    if (fs.existsSync(full)) fs.rmSync(full, { recursive: true, force: true });
  }
  for (const file of TRACKING_FILES) {
    const full = path.join(profileDir, file);
    if (fs.existsSync(full)) fs.rmSync(full, { force: true });
  }
}

module.exports = { clearTrackingData };
