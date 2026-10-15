const parameterKeys = new Map([
  ['composer-2.5', ['fast']],
  ['claude-opus-5-5', ['context', 'effort', 'fast']],
]);

const normalizeLabel = value => value.trim().replace(/\s+/gu, ' ');
const sameKeys = (actual, expected) => actual.length === expected.length
  && actual.every(key => typeof key === 'string')
  && [...actual].sort().every((key, index) => key === [...expected].sort()[index]);

function parseModelId(value) {
  const match = /^([^\s[\]]+)(?:\[([^\[\]]*)\])?$/u.exec(value);
  if (!match) return null;
  const parameters = new Map();
  if (match[2] !== undefined) {
    if (!match[2]) return null;
    for (const part of match[2].split(',')) {
      const parameter = /^([^\s=,\[\]]+)\s*=\s*([^\s=,\[\]]+)$/u.exec(part.trim());
      if (!parameter || parameters.has(parameter[1])) return null;
      parameters.set(parameter[1], parameter[2]);
    }
  }
  return { base: match[1], parameters };
}

function signature({ base, parameters }) {
  return JSON.stringify([base, [...parameters].sort(([left], [right]) => left.localeCompare(right))]);
}

function addCandidate(index, alias, id) {
  if (typeof alias !== 'string' || !normalizeLabel(alias)) return;
  const key = normalizeLabel(alias);
  if (!index.has(key)) index.set(key, new Set());
  index.get(key).add(id);
}

function onlyCandidate(candidates, request, kind) {
  if (!candidates?.size) throw new Error(`Unknown Cursor model ${kind}: ${JSON.stringify(request)}`);
  if (candidates.size !== 1) throw new Error(`Ambiguous Cursor model ${kind}: ${JSON.stringify(request)}`);
  return candidates.values().next().value;
}

function definitionParameters(base, definition) {
  const expected = parameterKeys.get(base);
  if (!expected) return null;
  if (!definition || typeof definition.name !== 'string' || !normalizeLabel(definition.name)) return null;
  const options = definition.configOptions;
  if (!Array.isArray(options) || !sameKeys(options.map(option => option?.id), expected)) return null;
  const parameters = [];
  for (const parameter of options) {
    if (parameter.type !== 'select' || typeof parameter.name !== 'string' || !normalizeLabel(parameter.name)) return null;
    if (!Array.isArray(parameter.options) || !parameter.options.length) return null;
    const values = new Map();
    for (const option of parameter.options) {
      if (typeof option?.value !== 'string' || !/^[^\s=,\[\]]+$/u.test(option.value) || typeof option.name !== 'string'
        || !normalizeLabel(option.name) || values.has(option.value)) return null;
      values.set(option.value, option.name);
    }
    if (parameter.id === 'fast' && !sameKeys([...values.keys()], ['false', 'true'])) return null;
    parameters.push({ ...parameter, values });
  }
  return parameters;
}

function variantLabel(parsed, definition) {
  const expected = parameterKeys.get(parsed.base);
  if (!expected || !sameKeys([...parsed.parameters.keys()], expected)) return null;
  const parameters = definitionParameters(parsed.base, definition);
  if (!parameters) return null;
  const parts = [definition.name];
  for (const parameter of parameters) {
    const value = parsed.parameters.get(parameter.id);
    if (!parameter.values.has(value)) return null;
    if (parameter.id === 'fast') {
      // ACP lowers Cursor's known boolean fast parameter to a select. Its native
      // formatter omits false and uses the parameter name for true, never "Off".
      if (value === 'true') parts.push(parameter.name);
    } else {
      parts.push(parameter.values.get(value));
    }
  }
  return normalizeLabel(parts.join(' '));
}

function inspectModels(models, modelDefinitions) {
  if (!Array.isArray(models) || !Array.isArray(modelDefinitions)) {
    throw new TypeError('Cursor models and modelDefinitions must be arrays');
  }
  const definitions = new Map();
  const variants = [];
  const taintedFamilies = new Set();
  for (const definition of modelDefinitions) {
    if (typeof definition?.value !== 'string') continue;
    if (!definitions.has(definition.value)) definitions.set(definition.value, []);
    definitions.get(definition.value).push(definition);
  }

  for (const model of models) {
    if (typeof model?.model !== 'string' || !model.model) continue;
    const id = model.model;
    const parsed = parseModelId(id);
    const base = parsed?.base ?? /^([^\s[\]]+)(?=[\[\]]|$)/u.exec(id)?.[1];
    const candidates = definitions.get(base);
    const definition = candidates?.length === 1 ? candidates[0] : null;
    const label = parsed ? variantLabel(parsed, definition) : null;
    if (parameterKeys.has(base) && !label) taintedFamilies.add(base);
    variants.push({ model, id, parsed, base, definition, label });
  }
  return { variants, taintedFamilies };
}

/** Expand only complete known families using the official parameter choices. */
export function expandModelVariants({ models, modelDefinitions = [] } = {}) {
  const { variants, taintedFamilies } = inspectModels(models, modelDefinitions);
  const expanded = [];
  const ids = new Set();
  const signatures = new Set();
  for (const { model, id, parsed } of variants) {
    if (ids.has(id)) continue;
    expanded.push(model);
    ids.add(id);
    if (parsed) signatures.add(signature(parsed));
  }
  const seenFamilies = new Set();
  for (const { base, definition } of variants) {
    if (seenFamilies.has(base) || taintedFamilies.has(base)) continue;
    seenFamilies.add(base);
    const parameters = definitionParameters(base, definition);
    if (!parameters) continue;
    let combinations = [[]];
    for (const parameter of parameters) {
      combinations = combinations.flatMap(entries => [...parameter.values.keys()]
        .map(value => [...entries, [parameter.id, value]]));
    }
    for (const entries of combinations) {
      const parsed = { base, parameters: new Map(entries) };
      const key = signature(parsed);
      if (signatures.has(key)) continue;
      const id = `${base}[${entries.map(([name, value]) => `${name}=${value}`).join(',')}]`;
      expanded.push({ model: id, displayName: `Cursor · ${variantLabel(parsed, definition)}` });
      ids.add(id);
      signatures.add(key);
    }
  }
  return expanded;
}

/** Match native Cursor labels without guessing display names from model slugs. */
export function createModelCatalog({ models, modelDefinitions = [] } = {}) {
  const expanded = expandModelVariants({ models, modelDefinitions });
  const { variants, taintedFamilies } = inspectModels(expanded, modelDefinitions);
  const ids = new Set();
  const signatures = new Map();
  const labels = new Map();
  const aliases = new Map();
  for (const { model, id, parsed, base, definition } of variants) {
    ids.add(id);
    if (parsed) addCandidate(signatures, signature(parsed), id);
    if (parameterKeys.has(base)) {
      // Every catalog variant counts against an alias, including variants whose
      // hidden or incomplete parameters prevent a trustworthy native label.
      addCandidate(aliases, base, id);
      addCandidate(aliases, definition?.name, id);
      addCandidate(aliases, model.displayName, id);
    }
  }
  for (const { id, base, label } of variants) {
    // An unexplained variant may render the same visible footer while carrying
    // hidden parameters. The whole family then needs explicit identification.
    if (label && !taintedFamilies.has(base)) addCandidate(labels, label, id);
  }

  function input(value, kind) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Unknown Cursor model ${kind}: ${JSON.stringify(value)}`);
    }
    return value.trim();
  }

  return {
    infer(label) {
      return onlyCandidate(labels.get(normalizeLabel(input(label, 'label'))), label, 'label');
    },
    resolve(request) {
      const value = input(request, 'request');
      if (ids.has(value)) return value;
      const parsed = parseModelId(value);
      if (value.includes('[') || value.includes(']')) {
        return onlyCandidate(parsed && signatures.get(signature(parsed)), request, 'request');
      }
      const label = normalizeLabel(value);
      if (labels.has(label)) return onlyCandidate(labels.get(label), request, 'request');
      return onlyCandidate(aliases.get(label), request, 'request');
    },
  };
}
