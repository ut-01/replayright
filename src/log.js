// log.js - the generic half of jscrape's src/util.js. The LinkedIn-specific parts
// (USER_AGENT, BLOCKED_STATUSES, extractJobId) are deliberately not carried over.
const { MIN_DELAY_MS, MAX_DELAY_MS } = require('./constants');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function randomDelay(minMs = MIN_DELAY_MS, maxMs = MAX_DELAY_MS) {
  return Math.floor(minMs + Math.random() * (maxMs - minMs));
}

// toISOString() is always UTC, so every log line is timestamped in UTC regardless of
// the machine's local timezone - useful when runs are compared across machines, or
// scheduled via cron in some other zone.
function logInfo(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function logWarn(...args) {
  console.warn(`[${new Date().toISOString()}] WARN`, ...args);
}

function logError(...args) {
  console.error(`[${new Date().toISOString()}] ERROR`, ...args);
}

module.exports = { sleep, randomDelay, logInfo, logWarn, logError };
