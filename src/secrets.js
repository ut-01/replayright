// secrets.js
//
// Resolves `{{env:NAME}}` placeholders inside a recorded `fill` step's `text` at
// replay time. Recording still captures whatever was typed verbatim (see ir.js's
// cleanAction) - there is no reliable signal in Playwright's action stream to tell
// "this was a password field" apart from any other text input, so this is a purely
// additive, opt-in-by-syntax mechanism: a literal fill value with no `{{env:...}}`
// in it is untouched. The documented workflow is to record normally, then hand-edit
// the fill step's `text` in flow.json to a placeholder before the file is ever
// committed - the same "flow.json is hand-editable" model already used for
// reordering selector candidates.
const PLACEHOLDER = /\{\{env:([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

// Replaces every `{{env:NAME}}` in `text` with `env[NAME]`. Throws rather than
// silently typing the literal placeholder string into the site - that would look
// like a working run while quietly breaking every login it touches.
function resolveSecrets(text, env = process.env) {
  return text.replace(PLACEHOLDER, (match, name) => {
    const value = env[name];
    if (value === undefined) {
      throw new Error(`Missing environment variable "${name}" required by a fill step's {{env:${name}}} placeholder`);
    }
    return value;
  });
}

// Recursively walks a flow's steps collecting every `{{env:NAME}}` reference found
// in any fill step's text, for a preflight check (fail before launching a browser,
// not mid-run). Same recursion shape as cli.js's overrideTimes().
function findSecretRefs(steps) {
  const names = new Set();
  for (const step of steps || []) {
    if (step.kind === 'action' && step.action?.name === 'fill' && typeof step.action.text === 'string') {
      for (const match of step.action.text.matchAll(PLACEHOLDER)) names.add(match[1]);
    }
    if (step.body) for (const name of findSecretRefs(step.body)) names.add(name);
  }
  return [...names];
}

module.exports = { resolveSecrets, findSecretRefs };
