// config.js - the one place that answers "what value should this run actually use?"
//
// PRECEDENCE, low to high. Each layer overrides the one before it KEY BY KEY (a deep
// merge, never a whole-object replace), so a user who sets only `timeouts.settleMs` in
// their config file keeps every other `timeouts.*` default:
//
//   1. defaults          - this file's DEFAULTS, which import their numbers (and the
//                          comments explaining those numbers) from constants.js
//   2. replayright.config.json   - found in cwd, or the nearest ancestor directory
//   3. environment       - REPLAYRIGHT_* variables (see "ENV VARS" below)
//   4. flow.config       - the optional `config` object inside a site's flow.json
//   5. CLI flags         - passed in already-parsed by the caller
//
// The ordering is not arbitrary. The file is the project's committed baseline; env vars
// are how an operator adjusts one knob for one machine or one cron entry without editing
// a committed file; `flow.config` is per-site knowledge that a human learned about THIS
// site (e.g. "this one genuinely needs 20s to settle") and wrote down permanently, so it
// must beat a machine-wide env default; and a CLI flag is a deliberate, one-off human
// instruction for this invocation, so it beats everything.
//
// ---------------------------------------------------------------------------------
// ENV VARS - the convention, and why
// ---------------------------------------------------------------------------------
// `REPLAYRIGHT_` + the config path, each segment upper-snake-cased and joined with `_`:
//
//   timeouts.settleMs    -> REPLAYRIGHT_TIMEOUTS_SETTLE_MS
//   display.mode         -> REPLAYRIGHT_DISPLAY_MODE
//   browser.userAgent    -> REPLAYRIGHT_BROWSER_USER_AGENT
//   sitesDir             -> REPLAYRIGHT_SITES_DIR
//   repeat.defaultTimes  -> REPLAYRIGHT_REPEAT_DEFAULT_TIMES
//
// One var per leaf, rather than a single `REPLAYRIGHT_CONFIG='{"timeouts":{...}}'` JSON
// blob. The audience for env vars here is an ops person adding one override to a cron
// line or a container spec - `REPLAYRIGHT_TIMEOUTS_SETTLE_MS=20000` is something you can
// write, read and grep at a glance, where a JSON blob has to be escaped correctly inside
// a shell/YAML/Dockerfile quote and is unreadable in `docker inspect` output. A JSON blob
// would also duplicate, badly, the job the config FILE already does.
//
// `_` is used both as the path separator and as the camelCase word boundary, which is
// ambiguous in the parse direction (does `TIMEOUTS_SETTLE_MS` mean `timeouts.settleMs` or
// `timeouts.settle.ms`?). So this module never parses an env var name into a path. It
// walks the known schema, derives the ONE canonical env name for each leaf, and looks
// that name up. Ambiguity cannot arise, adding a config key automatically gets an env var,
// and a name that matches nothing in the schema is reported rather than silently ignored.
//
// One meta var exists and is not a config value: REPLAYRIGHT_CONFIG_PATH points at a
// specific config file, skipping the upward search entirely.
//
// ---------------------------------------------------------------------------------
// `flow.config` - the convention (defined here; nothing writes it yet)
// ---------------------------------------------------------------------------------
// A site's flow.json MAY carry a top-level `"config"` object holding a PARTIAL config of
// exactly the shape below. Recording never produces one - it is hand-added, and it is the
// place to record something learned about that specific site:
//
//   { "startUrl": "...", "steps": [...],
//     "config": { "timeouts": { "settleMs": 20000 },
//                 "browser": { "locale": "de-DE" } } }
//
// Same deep-merge rules as every other layer. Keys that describe how the flow was FOUND
// rather than how it RUNS (`sitesDir`) are accepted but meaningless there - the flow has
// already been located by the time its own config is read.
//
// ---------------------------------------------------------------------------------
// Relationship to constants.js
// ---------------------------------------------------------------------------------
// constants.js is the defaults' source of truth for every value that already lived there,
// and keeps its comments - those comments record the real failure each number fixed, and
// deleting them would delete the reasoning. This file imports the values and does not
// restate them. Values that are new in the config schema carry their explanation here.
//
// MARKER_PREFIX is deliberately NOT configurable: it is baked into every recorded marker
// selector and into every sites/*/last-recording.actions.json, so changing it invalidates
// existing recordings (CLAUDE.md, "Gotchas"). It stays a constant, not a setting.
const fs = require('fs');
const path = require('path');

const {
  REPEAT_DEFAULT_TIMES,
  RESOLVE_WAIT_MS,
  SETTLE_TIMEOUT_MS,
  HEADLESS_PROBE_TIMEOUT_MS,
} = require('./constants');

const CONFIG_FILENAME = 'replayright.config.json';
const ENV_PREFIX = 'REPLAYRIGHT_';
const ENV_CONFIG_PATH = 'REPLAYRIGHT_CONFIG_PATH';

// Env vars under our prefix that are NOT config leaves. Anything else under the prefix
// that matches no leaf is reported as a warning (see readEnvLayer).
const META_ENV_VARS = new Set([ENV_CONFIG_PATH]);

// The complete default shape. Every key here is settable at every layer; nothing outside
// it is. Read this alongside TYPES below, which declares each leaf's type - a load-time
// self-check keeps the two from drifting apart.
const DEFAULTS = {
  // Where per-site recordings live. Relative paths resolve against the directory the
  // config file was found in (or `cwd` when there is no config file) - see
  // resolveSitesDir(). Existing behaviour is the repo's own `sites/`.
  sitesDir: './sites',

  browser: {
    // Playwright browser channel ('chrome', 'msedge', ...). null = bundled Chromium,
    // which is what every recording so far was made against.
    channel: null,
    // EXTRA Chromium args, appended to constants.js's CHROMIUM_ARGS - not a replacement
    // for them. Those two args fix launch friction that applies to every run (see the
    // comment on CHROMIUM_ARGS); this is for environment-specific additions like
    // '--no-sandbox' or '--disable-dev-shm-usage' in a container. Arrays REPLACE across
    // layers rather than concatenating, so a lower layer's list is not silently inherited.
    args: [],
    // { width, height } or null to let Playwright pick its own default.
    viewport: null,
    userAgent: null,
    locale: null,
    timezoneId: null,
    // Playwright's proxy option: { server, bypass?, username?, password? }.
    proxy: null,
  },

  display: {
    // Consumed verbatim by display.js's ensureDisplay({ mode, screen }) - these two keys
    // are that function's parameter object. 'auto' | 'off' | ':N'.
    mode: 'auto',
    screen: '1920x1080x24',
  },

  profile: {
    // Recording profiles persist in os.tmpdir()/playright-profile-<id> so cookie banners
    // and logins survive between sessions. Turning this off means a throwaway profile dir
    // per recording.
    persist: true,
    // Wipe cookies/storage before and after recording, so the session starts and ends
    // logged-out. OFF by default: on by default is fatal for any flow behind a login.
    clearTracking: false,
    // Override the profile directory entirely. null = the os.tmpdir() convention above.
    dir: null,
  },

  timeouts: {
    // All three come from constants.js, where each carries the comment explaining the
    // real failure it fixed. Do not restate those reasons here; do not change the values
    // here - change them there, or override them per-run through a config layer.
    resolveWaitMs: RESOLVE_WAIT_MS,
    settleMs: SETTLE_TIMEOUT_MS,
    probeMs: HEADLESS_PROBE_TIMEOUT_MS,
  },

  repeat: {
    // constants.js REPEAT_DEFAULT_TIMES: what a repeat block that names no `times` of its
    // own falls back to.
    defaultTimes: REPEAT_DEFAULT_TIMES,
    // Upper bound on any single repeat block's `times`, whether that number came from
    // flow.json or from `--times`. DISTINCT from constants.js's HARD_LOOP_CEILING (10000),
    // which is interpret.js's runaway backstop on iterations actually executed - that one
    // exists to stop a "load more" that never exhausts, and is deliberately far higher
    // than any number a human would type. This is the "you probably did not mean 5000
    // pages" guard on the configured value.
    maxTimes: 50,
  },

  output: {
    // `{id}` is substituted with the site id - see resolveOutputPath(). The default is the
    // same file cli.js writes today (sites/<id>/output.csv).
    path: 'sites/{id}/output.csv',
    // 'auto' keeps output.js's existing rule: the PATH'S EXTENSION decides ('.json' ->
    // JSON, anything else -> CSV). 'csv' / 'json' force the format regardless of extension.
    format: 'auto',
  },

  log: {
    // 'text' is log.js's current human-readable "[iso] message" line. 'json' is reserved
    // for structured output; log.js gains it when a layer actually needs it.
    format: 'text',
  },
};

// Flat map of every LEAF path to its type. This - not DEFAULTS - is the authority on
// "where does the config tree stop": `browser.proxy` defaults to null but holds an object
// when set, and only this table can say the whole object is one leaf value rather than a
// sub-tree with its own known keys.
//
// nullable  - null is an accepted value (usually meaning "let the layer below/Playwright
//             decide"), as distinct from "unset", which is `undefined` and never merges.
// values    - closed set; anything else is rejected with the valid options listed.
const TYPES = {
  'sitesDir': { type: 'string' },

  'browser.channel': { type: 'string', nullable: true },
  'browser.args': { type: 'string[]' },
  'browser.viewport': { type: 'viewport', nullable: true },
  'browser.userAgent': { type: 'string', nullable: true },
  'browser.locale': { type: 'string', nullable: true },
  'browser.timezoneId': { type: 'string', nullable: true },
  'browser.proxy': { type: 'object', nullable: true },

  'display.mode': { type: 'displayMode' },
  'display.screen': { type: 'string' },

  'profile.persist': { type: 'boolean' },
  'profile.clearTracking': { type: 'boolean' },
  'profile.dir': { type: 'string', nullable: true },

  'timeouts.resolveWaitMs': { type: 'number' },
  'timeouts.settleMs': { type: 'number' },
  'timeouts.probeMs': { type: 'number' },

  'repeat.defaultTimes': { type: 'number' },
  'repeat.maxTimes': { type: 'number' },

  'output.path': { type: 'string' },
  'output.format': { type: 'string', values: ['auto', 'csv', 'json'] },

  'log.format': { type: 'string', values: ['text', 'json'] },
};

// ---------------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = deepClone(value[key]);
    return out;
  }
  return value;
}

function getAt(obj, dottedPath) {
  let node = obj;
  for (const segment of dottedPath.split('.')) {
    if (!isPlainObject(node)) return undefined;
    node = node[segment];
  }
  return node;
}

function setAt(obj, dottedPath, value) {
  const segments = dottedPath.split('.');
  let node = obj;
  for (const segment of segments.slice(0, -1)) {
    if (!isPlainObject(node[segment])) node[segment] = {};
    node = node[segment];
  }
  node[segments[segments.length - 1]] = value;
}

// `settleMs` -> `SETTLE_MS`, `userAgent` -> `USER_AGENT`, `sitesDir` -> `SITES_DIR`.
function camelToUpperSnake(segment) {
  return segment.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

// The one canonical env var name for a config path. See "ENV VARS" at the top: names are
// only ever DERIVED this way, never parsed back into a path.
function envNameFor(dottedPath) {
  return ENV_PREFIX + dottedPath.split('.').map(camelToUpperSnake).join('_');
}

// path -> env name, plus the inverse for lookup. Built once; also used to tell an unknown
// REPLAYRIGHT_* var from a real one.
const ENV_NAME_TO_PATH = new Map();
for (const dottedPath of Object.keys(TYPES)) {
  const name = envNameFor(dottedPath);
  const clash = ENV_NAME_TO_PATH.get(name);
  if (clash) {
    throw new Error(
      `config.js: "${dottedPath}" and "${clash}" both map to the env var ${name}. `
      + `Rename one of the config keys - env names must be unambiguous.`
    );
  }
  ENV_NAME_TO_PATH.set(name, dottedPath);
}

// Load-time self-check: every leaf in DEFAULTS has a TYPES entry and vice versa. Without
// this, adding a key to DEFAULTS alone would give it no env var, no coercion and no
// validation, and the omission would only show up as a mystery at some call site.
(function assertSchemaCovers(node, prefix) {
  for (const key of Object.keys(node)) {
    const dottedPath = prefix ? `${prefix}.${key}` : key;
    const isLeafInTypes = Object.prototype.hasOwnProperty.call(TYPES, dottedPath);
    if (isLeafInTypes) continue;
    if (isPlainObject(node[key])) {
      assertSchemaCovers(node[key], dottedPath);
      continue;
    }
    throw new Error(`config.js: DEFAULTS has "${dottedPath}" but TYPES does not declare its type.`);
  }
})(DEFAULTS, '');

for (const dottedPath of Object.keys(TYPES)) {
  if (getAt(DEFAULTS, dottedPath) === undefined) {
    throw new Error(`config.js: TYPES declares "${dottedPath}" but DEFAULTS has no such key.`);
  }
}

// ---------------------------------------------------------------------------------
// merging
// ---------------------------------------------------------------------------------

// Deep-merges `patch` into `target` in place, using TYPES to decide where the tree stops.
//
// - a path in TYPES is a LEAF: its value replaces wholesale (arrays included - a lower
//   layer's `browser.args` is not concatenated into, it is superseded, so what a layer
//   states is what runs)
// - a path that is a plain object in DEFAULTS is recursed into (this is the deep merge:
//   setting one `timeouts.*` key leaves its siblings alone)
// - anything else is an unknown key
//
// Unknown keys THROW for file / flow / CLI layers: those are authored specifically for
// replayright, so `settleMS` instead of `settleMs` is unambiguously a bug and silently
// doing nothing is the worst possible response. (The environment is a shared namespace
// and is handled differently - see readEnvLayer.)
function mergeLayer(target, patch, source, prefix = '') {
  if (!isPlainObject(patch)) {
    throw new Error(`${source}: expected a JSON object${prefix ? ` at "${prefix}"` : ''}, got ${describe(patch)}.`);
  }
  for (const key of Object.keys(patch)) {
    const dottedPath = prefix ? `${prefix}.${key}` : key;
    const value = patch[key];
    // `undefined` is "not set by this layer" and must never clobber a lower layer. This
    // is what lets a caller build a CLI patch out of possibly-absent flags without
    // filtering it first.
    if (value === undefined) continue;

    if (Object.prototype.hasOwnProperty.call(TYPES, dottedPath)) {
      setAt(target, dottedPath, deepClone(value));
      continue;
    }
    if (isPlainObject(getAt(DEFAULTS, dottedPath))) {
      mergeLayer(target, value, source, dottedPath);
      continue;
    }
    throw new Error(
      `${source}: unknown config key "${dottedPath}". Known keys at this level: `
      + `${knownKeysAt(prefix).join(', ')}.`
    );
  }
  return target;
}

function knownKeysAt(prefix) {
  const node = prefix ? getAt(DEFAULTS, prefix) : DEFAULTS;
  return isPlainObject(node) ? Object.keys(node) : [];
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

// ---------------------------------------------------------------------------------
// layer 2: replayright.config.json
// ---------------------------------------------------------------------------------

// Search behaviour: start at `cwd` and walk UP one directory at a time, stopping at the
// first `replayright.config.json` found or at the filesystem root. This is the same rule
// every JS tool uses (eslint, prettier, tsconfig) and it exists so that running
// `npm run play` from inside a subdirectory of the project still finds the project's
// config. `REPLAYRIGHT_CONFIG_PATH` (or loadConfig's `configPath`) skips the search.
function findConfigFile(cwd, searchUp = true) {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (fs.existsSync(candidate)) return candidate;
    if (!searchUp) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// A MISSING file is not an error - the defaults are a complete, working configuration and
// most projects will never write one. A file that EXISTS but cannot be parsed is a hard
// error with the path and the parser's own message: silently ignoring it would run with
// settings the user believes are in effect, which is exactly how a scheduled job ends up
// producing confidently wrong output.
function readConfigFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Could not read ${filePath}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${filePath} is not valid JSON: ${err.message}. `
      + `It must contain a single JSON object of replayright settings, e.g. `
      + `{ "timeouts": { "settleMs": 20000 } }. Note JSON allows no comments and no trailing commas.`
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${filePath} must contain a JSON object, got ${describe(parsed)}.`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------------
// layer 3: environment
// ---------------------------------------------------------------------------------

function parseBooleanEnv(name, raw) {
  const lowered = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
  if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
  throw new Error(`${name}="${raw}" is not a boolean - use true/false (1/0, yes/no, on/off also work).`);
}

function parseNumberEnv(name, raw) {
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) throw new Error(`${name}="${raw}" is not a number.`);
  return value;
}

// `browser.args` from a shell: a JSON array when precision matters (an arg containing a
// comma), or a plain comma-separated list because that is what an ops person will type.
function parseStringArrayEnv(name, raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`${name}="${raw}" looks like a JSON array but does not parse: ${err.message}`);
    }
    if (!Array.isArray(parsed)) throw new Error(`${name}="${raw}" must be a JSON array of strings.`);
    return parsed.map(String);
  }
  if (trimmed === '') return [];
  return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
}

// `1280x720` shorthand, or a JSON object, or the literal "null" to mean "no override".
function parseViewportEnv(name, raw) {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;
  const shorthand = /^(\d+)x(\d+)$/i.exec(trimmed);
  if (shorthand) return { width: Number(shorthand[1]), height: Number(shorthand[2]) };
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`${name}="${raw}" must be "<width>x<height>" (e.g. 1280x720) or a JSON object.`);
  }
  return parsed;
}

function parseObjectEnv(name, raw) {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`${name}="${raw}" must be a JSON object: ${err.message}`);
  }
}

function coerceEnvValue(name, raw, spec) {
  if (spec.nullable && raw.trim().toLowerCase() === 'null') return null;
  switch (spec.type) {
    case 'boolean': return parseBooleanEnv(name, raw);
    case 'number': return parseNumberEnv(name, raw);
    case 'string[]': return parseStringArrayEnv(name, raw);
    case 'viewport': return parseViewportEnv(name, raw);
    case 'object': return parseObjectEnv(name, raw);
    default: return raw;
  }
}

// Returns { patch, warnings }.
//
// An unknown REPLAYRIGHT_* var WARNS rather than throwing, unlike an unknown key in a
// config file. The environment is a namespace we share with whoever set up the machine -
// a CI system exporting REPLAYRIGHT_VERSION, or a leftover from an older release, must not
// stop today's scheduled run. It is still reported, because a typo'd override that
// silently does nothing is the classic config-system failure. Values themselves still
// throw when malformed: `REPLAYRIGHT_TIMEOUTS_SETTLE_MS=twenty` is not ambiguous, it is
// wrong, and continuing would run with a timeout the operator did not choose.
function readEnvLayer(env) {
  const patch = {};
  const warnings = [];
  for (const name of Object.keys(env)) {
    if (!name.startsWith(ENV_PREFIX)) continue;
    if (META_ENV_VARS.has(name)) continue;
    const dottedPath = ENV_NAME_TO_PATH.get(name);
    if (!dottedPath) {
      warnings.push(`ignoring unknown environment variable ${name} (no config key maps to that name)`);
      continue;
    }
    const raw = env[name];
    if (raw === undefined) continue;
    setAt(patch, dottedPath, coerceEnvValue(name, raw, TYPES[dottedPath]));
  }
  return { patch, warnings };
}

// ---------------------------------------------------------------------------------
// validation of the merged result
// ---------------------------------------------------------------------------------

const DISPLAY_MODE_RE = /^(auto|off|:\d+)$/;

function validateLeaf(dottedPath, value, spec) {
  const label = `config value "${dottedPath}"`;
  if (value === null) {
    if (spec.nullable) return;
    throw new Error(`${label} must not be null.`);
  }
  if (spec.values && !spec.values.includes(value)) {
    throw new Error(`${label} must be one of ${spec.values.join(', ')} - got ${JSON.stringify(value)}.`);
  }
  switch (spec.type) {
    case 'boolean':
      if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean, got ${describe(value)}.`);
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${label} must be a finite number, got ${JSON.stringify(value)}.`);
      }
      if (value < 0) throw new Error(`${label} must not be negative, got ${value}.`);
      break;
    case 'string[]':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw new Error(`${label} must be an array of strings.`);
      }
      break;
    case 'viewport':
      if (!isPlainObject(value) || !Number.isFinite(value.width) || !Number.isFinite(value.height)) {
        throw new Error(`${label} must be { width, height } with numeric values, or null.`);
      }
      break;
    case 'object':
      if (!isPlainObject(value)) throw new Error(`${label} must be an object, or null.`);
      break;
    // 'displayMode' is a string with a closed grammar shared with display.js's
    // parseDisplayNumber(); catching it here means a bad --display/config value fails
    // immediately instead of halfway into a recording.
    case 'displayMode':
      if (typeof value !== 'string' || !DISPLAY_MODE_RE.test(value)) {
        throw new Error(`${label} must be "auto", "off", or ":<N>" (e.g. ":50") - got ${JSON.stringify(value)}.`);
      }
      break;
    default:
      if (typeof value !== 'string') throw new Error(`${label} must be a string, got ${describe(value)}.`);
  }
}

function validate(config) {
  for (const [dottedPath, spec] of Object.entries(TYPES)) {
    validateLeaf(dottedPath, getAt(config, dottedPath), spec);
  }
  if (config.repeat.defaultTimes > config.repeat.maxTimes) {
    throw new Error(
      `config value "repeat.defaultTimes" (${config.repeat.defaultTimes}) exceeds "repeat.maxTimes" `
      + `(${config.repeat.maxTimes}). Raise repeat.maxTimes if that many iterations is really intended.`
    );
  }
  return config;
}

// ---------------------------------------------------------------------------------
// the CLI layer
// ---------------------------------------------------------------------------------

// Maps cli.js's already-parsed `args` object onto a PARTIAL config. Parsing argv stays
// cli.js's job (Phase 5.2 wires the two together); this exists so that wiring is one call
// and the flag -> key mapping lives next to the schema it targets.
//
// Absent flags come through as `undefined` and mergeLayer skips them, so this can be built
// unconditionally - no filtering at the call site.
//
// Two things NOT mapped, deliberately:
// - `headless` / `requiresHeaded`: not in the config schema. Headedness is decided per run
//   from flow.requiresHeaded and the explicit flag (see cli.js's cmdPlay); making it a
//   config key would add a fourth input to that decision for no gain.
// - `--times` as a FORCED override: cli.js's overrideTimes() rewrites every repeat block's
//   `times`, which is a stronger statement than "the default for blocks that name none".
//   That rewrite stays in cli.js. The value is also surfaced here as repeat.defaultTimes so
//   a block with no `times` of its own agrees with the flag.
function configFromCliArgs(args = {}) {
  const browserArgs = [];
  if (args.disableDevShmUsage) browserArgs.push('--disable-dev-shm-usage');
  if (args.disableGpu) browserArgs.push('--disable-gpu');
  // A genuine security tradeoff (required as root in a container, an attack surface
  // otherwise), so it is only ever here because the flag was passed explicitly.
  if (args.noSandbox) browserArgs.push('--no-sandbox');

  return {
    browser: {
      args: browserArgs.length ? browserArgs : undefined,
    },
    display: {
      mode: args.display,
      screen: args.screen,
    },
    profile: {
      // `|| undefined` on purpose: cli.js gives clearTracking a hard `false` default, and
      // an unset opt-in flag must not out-rank a config file that turned it on. Only the
      // true case is an actual statement from the command line.
      clearTracking: args.clearTracking || undefined,
    },
    repeat: {
      defaultTimes: args.times,
    },
    output: {
      path: args.out,
    },
  };
}

// ---------------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------------

/**
 * Resolve the effective configuration for one run.
 *
 * @param {object}  [options]
 * @param {string}  [options.cwd=process.cwd()]  where the config-file search starts.
 * @param {string}  [options.configPath]         an explicit config file; skips the search.
 *                                               Also settable via REPLAYRIGHT_CONFIG_PATH.
 * @param {boolean} [options.searchUp=true]      walk up parent directories looking for
 *                                               replayright.config.json (see findConfigFile).
 * @param {object}  [options.env=process.env]    the environment to read REPLAYRIGHT_* from.
 * @param {object}  [options.flow]               a parsed flow.json; its `config` key is the
 *                                               flow layer (see the flow.config convention).
 * @param {object}  [options.flowConfig]         the flow layer given directly. Wins over
 *                                               `flow.config` when both are present.
 * @param {object}  [options.cliArgs]            cli.js's parsed args object, run through
 *                                               configFromCliArgs().
 * @param {object}  [options.cliOverrides]       a partial config applied as the CLI layer.
 *                                               Merged after `cliArgs`, so it wins.
 *
 * @returns {object} the merged config. A non-enumerable `__meta` carries
 *   { configPath, rootDir, layers, warnings } - non-enumerable so the config still
 *   deep-equals the plain default shape and JSON.stringify()s cleanly.
 *
 * @throws on a malformed config file, an unknown key in the file/flow/CLI layers, an
 *   unparseable env value, or a merged value of the wrong type. Never throws for a
 *   MISSING config file.
 */
function loadConfig({
  cwd = process.cwd(),
  configPath,
  searchUp = true,
  env = process.env,
  flow,
  flowConfig,
  cliArgs,
  cliOverrides,
} = {}) {
  const config = deepClone(DEFAULTS);
  const layers = ['defaults'];
  const warnings = [];

  // Layer 2 - replayright.config.json.
  const explicitPath = configPath || (env && env[ENV_CONFIG_PATH]) || null;
  let foundPath = null;
  if (explicitPath) {
    foundPath = path.resolve(cwd, explicitPath);
    if (!fs.existsSync(foundPath)) {
      // An explicitly named file that is not there IS an error - unlike the implicit
      // search, someone stated this path on purpose and running with defaults instead
      // would silently ignore their instruction.
      throw new Error(
        `Config file not found: ${foundPath}`
        + (configPath ? '' : ` (from ${ENV_CONFIG_PATH}=${env[ENV_CONFIG_PATH]})`)
      );
    }
  } else {
    foundPath = findConfigFile(cwd, searchUp);
  }
  if (foundPath) {
    mergeLayer(config, readConfigFile(foundPath), path.basename(foundPath) + ` (${foundPath})`);
    layers.push('file');
  }

  // Layer 3 - environment.
  const { patch: envPatch, warnings: envWarnings } = readEnvLayer(env || {});
  warnings.push(...envWarnings);
  if (Object.keys(envPatch).length) {
    mergeLayer(config, envPatch, 'environment');
    layers.push('env');
  }

  // Layer 4 - flow.config.
  const flowLayer = flowConfig !== undefined ? flowConfig : (flow && flow.config);
  if (flowLayer !== undefined && flowLayer !== null) {
    mergeLayer(config, flowLayer, 'flow.json "config"');
    layers.push('flow');
  }

  // Layer 5 - CLI flags, highest.
  if (cliArgs) {
    mergeLayer(config, configFromCliArgs(cliArgs), 'command line');
    layers.push('cli');
  }
  if (cliOverrides) {
    mergeLayer(config, cliOverrides, 'command line');
    if (!layers.includes('cli')) layers.push('cli');
  }

  validate(config);

  Object.defineProperty(config, '__meta', {
    value: {
      configPath: foundPath,
      // What relative paths in the config (sitesDir, output.path) resolve against: the
      // config file's own directory when there is one, so a config that says "./sites"
      // means the sites dir next to itself no matter where the command was run from.
      rootDir: foundPath ? path.dirname(foundPath) : path.resolve(cwd),
      layers,
      warnings,
    },
    enumerable: false,
    writable: false,
  });

  return config;
}

// ---------------------------------------------------------------------------------
// consumers' helpers
// ---------------------------------------------------------------------------------

function rootDirOf(config, baseDir) {
  if (baseDir) return baseDir;
  if (config && config.__meta && config.__meta.rootDir) return config.__meta.rootDir;
  return process.cwd();
}

function resolveSitesDir(config, { baseDir } = {}) {
  return path.resolve(rootDirOf(config, baseDir), config.sitesDir);
}

// `output.path` is a template: `{id}` becomes the site id. The default
// `sites/{id}/output.csv` reproduces exactly what cli.js writes today, so a run with no
// config at all lands on the same file it always has.
function resolveOutputPath(config, siteId, { baseDir } = {}) {
  const template = config.output.path;
  if (template.includes('{id}') && !siteId) {
    throw new Error(`config value "output.path" is "${template}" but no site id was given to substitute for {id}.`);
  }
  return path.resolve(rootDirOf(config, baseDir), template.replace(/\{id\}/g, siteId || ''));
}

// 'auto' defers to output.js's extension rule; 'csv'/'json' force it. Returns 'csv' | 'json'.
function resolveOutputFormat(config, outPath) {
  if (config.output.format !== 'auto') return config.output.format;
  return path.extname(outPath || config.output.path).toLowerCase() === '.json' ? 'json' : 'csv';
}

module.exports = {
  loadConfig,
  configFromCliArgs,
  defaults: () => deepClone(DEFAULTS),
  resolveSitesDir,
  resolveOutputPath,
  resolveOutputFormat,
  envNameFor,
  CONFIG_FILENAME,
  ENV_PREFIX,
  ENV_CONFIG_PATH,
  // Exported for tests and for a future `replayright config --explain`: the flat leaf
  // table is the readable index of everything that can be set, anywhere.
  TYPES,
};
