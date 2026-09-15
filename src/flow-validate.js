// flow-validate.js - a pure, static (no browser, no network) structural check of a
// flow.json's steps. Complements interpret.js's runtime dispatch (its `switch (step.kind)`
// only recognizes known kinds while actually replaying) by catching a hand-edit mistake
// before ever launching a browser: an unknown step kind, an extract step outside a
// foreach (interpret.js tolerates this at runtime by writing null - useful to flag as a
// mistake anyway, not fatal), an empty selector array masquerading as "no selectors
// needed", or a repeat/foreach with nothing in its body.
const KNOWN_KINDS = new Set(['action', 'repeat', 'foreach', 'extract']);
const PAGE_LEVEL_ACTIONS = new Set(['openPage', 'closePage', 'navigate']);
const KNOWN_ACTION_NAMES = new Set(['click', 'check', 'uncheck', 'fill', 'press', 'select', 'hover', ...PAGE_LEVEL_ACTIONS]);

function isNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function validateSteps(steps, { path: pathPrefix, insideForeach }, errors, warnings) {
  if (!isNonEmptyArray(steps)) return;

  steps.forEach((step, index) => {
    const stepPath = `${pathPrefix}[${index}]`;

    if (!KNOWN_KINDS.has(step.kind)) {
      errors.push(`${stepPath}: unknown step kind ${JSON.stringify(step.kind)}`);
      return;
    }

    if (step.kind === 'action') {
      const action = step.action || {};
      if (!KNOWN_ACTION_NAMES.has(action.name)) {
        errors.push(`${stepPath}: unknown action name ${JSON.stringify(action.name)}`);
      }
      if (!PAGE_LEVEL_ACTIONS.has(action.name)) {
        const selectors = step.scope === 'item' ? step.relativeSelectors : step.selectors;
        if (!isNonEmptyArray(selectors)) {
          errors.push(`${stepPath}: action step needs a non-empty ${step.scope === 'item' ? 'relativeSelectors' : 'selectors'} array`);
        }
      }
    }

    if (step.kind === 'extract') {
      if (!step.key) errors.push(`${stepPath}: extract step is missing "key"`);
      if (!insideForeach) warnings.push(`${stepPath}: extract step "${step.key}" is not inside a foreach - it will always write null at replay time`);
      if (step.relativeSelectors !== undefined && !isNonEmptyArray(step.relativeSelectors)) {
        errors.push(`${stepPath}: extract step's relativeSelectors, when present, must be a non-empty array`);
      }
    }

    if (step.kind === 'repeat' || step.kind === 'foreach') {
      if (!isNonEmptyArray(step.body)) {
        errors.push(`${stepPath}: ${step.kind} step needs a non-empty "body" array`);
      }
      if (step.kind === 'foreach') {
        if (!isNonEmptyArray(step.parentSelectors)) errors.push(`${stepPath}: foreach step needs a non-empty "parentSelectors" array`);
        if (!isNonEmptyArray(step.itemSelectors)) errors.push(`${stepPath}: foreach step needs a non-empty "itemSelectors" array`);
      }
      validateSteps(step.body, { path: `${stepPath}/body`, insideForeach: insideForeach || step.kind === 'foreach' }, errors, warnings);
    }
  });
}

function validateFlow(flow) {
  const errors = [];
  const warnings = [];

  if (!flow || typeof flow !== 'object') {
    return { errors: ['flow.json must be a JSON object'], warnings };
  }
  if (!flow.startUrl) errors.push('flow.json is missing "startUrl"');
  if (!isNonEmptyArray(flow.steps)) {
    errors.push('flow.json is missing a non-empty "steps" array');
    return { errors, warnings };
  }

  validateSteps(flow.steps, { path: 'steps', insideForeach: false }, errors, warnings);

  return { errors, warnings };
}

module.exports = { validateFlow };
