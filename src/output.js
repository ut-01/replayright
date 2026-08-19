// output.js
//
// Turns the flat rows collected in stats.records (see interpret.js's runExtract) into a
// file on disk. Deliberately a leaf module: no knowledge of flow.json, selectors, or the
// interpreter - just "here are some plain objects, write them out."
//
// Format is decided by the OUTPUT PATH'S EXTENSION, not a separate flag: `.json` writes
// a JSON array, anything else (including no extension) writes CSV. Column order is
// FIRST-SEEN across the records, not sorted - so the file reads in the same order the
// fields were tagged during recording, which is also the order a person picking them in
// the overlay would expect to see them back out.
const fs = require('fs');
const path = require('path');

// First-seen column order: walk every record in order and remember each key's first
// appearance. A later record introducing a field no earlier record had just appends a
// new column rather than reordering everything already decided.
function collectColumns(records) {
  const columns = [];
  const seen = new Set();
  for (const record of records || []) {
    for (const key of Object.keys(record)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  return columns;
}

// RFC 4180-ish: quote only when needed, double up embedded quotes. `\r\n` line endings
// to be unsurprising to Excel/Sheets, which is the overwhelmingly likely first consumer
// of a CSV like this.
function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(records) {
  const columns = collectColumns(records);
  const lines = [columns.map(csvEscape).join(',')];
  for (const record of records || []) {
    lines.push(columns.map((c) => csvEscape(record[c])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function toJson(records) {
  return `${JSON.stringify(records || [], null, 2)}\n`;
}

// Writes CSV or JSON depending on `outPath`'s extension (`.json` -> JSON, anything else
// -> CSV). Nothing is written when there are no records at all - an untagged flow (no
// `extract` steps anywhere) produces no output file, rather than an empty one that looks
// like a run which found zero rows. Returns the path written, or null when skipped.
function writeOutput(outPath, records) {
  if (!records || !records.length) return null;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const isJson = path.extname(outPath).toLowerCase() === '.json';
  fs.writeFileSync(outPath, isJson ? toJson(records) : toCsv(records));
  return outPath;
}

module.exports = { writeOutput, toCsv, toJson, collectColumns };
