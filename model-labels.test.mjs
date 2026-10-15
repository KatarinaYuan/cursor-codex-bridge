import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCatalog, expandModelVariants } from './model-labels.mjs';

const fast = {
  id: 'fast', name: 'Fast', type: 'select',
  options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'Fast' }],
};
const definitions = [
  { value: 'composer-2.5', name: 'Composer 2.5', configOptions: [fast] },
  {
    value: 'claude-opus-5-5', name: 'Claude Opus 5.5', configOptions: [
      {
        id: 'context', name: 'Context', type: 'select',
        options: [{ value: '300k', name: '300K' }, { value: '1m', name: '1M' }],
      },
      {
        id: 'effort', name: 'Effort', type: 'select',
        options: [
          { value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' }, { value: 'xhigh', name: 'Extra High' },
          { value: 'max', name: 'Max' },
        ],
      }, fast,
    ],
  },
];
const composer = value => `composer-2.5[fast=${value}]`;
const opus = (context = '300k', effort = 'medium', value = 'false') =>
  `claude-opus-5-5[context=${context},effort=${effort},fast=${value}]`;
const catalog = (ids, modelDefinitions = definitions) => createModelCatalog({
  models: ids.map(model => ({ model, displayName: `Cursor · ${model.split('[')[0]}` })),
  modelDefinitions,
});

test('native Composer labels preserve the known boolean fast identity', () => {
  const models = catalog([composer('false'), composer('true')]);
  assert.equal(models.infer('Composer 2.5'), composer('false'));
  assert.equal(models.infer(' Composer\t2.5   Fast\n'), composer('true'));
  assert.throws(() => models.infer('Composer 2.5 Off'), /Unknown/u);
});

test('an ACP selected fast variant can infer the independently selected native false variant', () => {
  const models = catalog([composer('true')]);
  assert.equal(models.infer('Composer 2.5'), composer('false'));
  assert.equal(models.resolve(composer('false')), composer('false'));
  assert.equal(models.infer('Composer 2.5 Fast'), composer('true'));
});

test('official choices expand to every complete variant and preserve original entries', () => {
  const original = [
    { model: composer('true'), displayName: 'Selected Composer', original: true },
    { model: opus(), displayName: 'Selected Opus' },
    { model: 'unsupported[hidden=true]', displayName: 'Other' },
  ];
  const before = structuredClone(original);
  const expanded = expandModelVariants({ models: original, modelDefinitions: definitions });
  assert.deepEqual(original, before);
  assert.deepEqual(expanded.slice(0, original.length), original);
  assert.equal(expanded[0], original[0]);
  assert.equal(expanded.length, 2 + 2 * 5 * 2 + 1);
  assert.equal(new Set(expanded.map(model => model.model)).size, expanded.length);
  assert.deepEqual(expanded.find(model => model.model === opus('1m', 'xhigh', 'true')), {
    model: opus('1m', 'xhigh', 'true'), displayName: 'Cursor · Claude Opus 5.5 1M Extra High Fast',
  });
  assert.deepEqual(expandModelVariants({ models: expanded, modelDefinitions: definitions }), expanded);
});

test('expansion does not introduce absent families or duplicate original IDs', () => {
  const original = { model: composer('true'), displayName: 'Original' };
  const expanded = expandModelVariants({ models: [original, { ...original, displayName: 'Duplicate' }], modelDefinitions: definitions });
  assert.equal(expanded.length, 2);
  assert.equal(expanded[0], original);
  assert.equal(expanded.some(model => model.model.startsWith('claude-opus-5-5')), false);
});

test('reordered original canonical IDs keep their identity without equivalent generated IDs', () => {
  const id = 'claude-opus-5-5[fast=false,effort=medium,context=300k]';
  const original = [{ model: id, displayName: 'Original' }];
  const expanded = expandModelVariants({ models: original, modelDefinitions: definitions });
  assert.equal(expanded.length, 20);
  assert.equal(expanded.some(model => model.model === opus()), false);
  const models = createModelCatalog({ models: original, modelDefinitions: definitions });
  assert.equal(models.infer('Claude Opus 5.5 300K Medium'), id);
  assert.equal(models.resolve(opus()), id);
});

test('original catalog IDs with the same signature remain ambiguous', () => {
  const reordered = 'claude-opus-5-5[fast=false,effort=medium,context=300k]';
  const models = catalog([opus(), reordered]);
  assert.throws(() => models.infer('Claude Opus 5.5 300K Medium'), /Ambiguous/u);
  assert.equal(models.resolve(opus()), opus());
  assert.equal(models.resolve(reordered), reordered);
});

test('Opus native labels use every enum option and omit only false fast', () => {
  const ids = [opus(), opus('1m', 'xhigh', 'true'), opus('300k', 'max')];
  const models = catalog(ids);
  assert.equal(models.infer('Claude Opus 5.5 300K Medium'), ids[0]);
  assert.equal(models.infer('Claude Opus 5.5 1M Extra High Fast'), ids[1]);
  assert.equal(models.infer('Claude Opus 5.5 300K Max'), ids[2]);
  assert.throws(() => models.infer('Claude Opus 5.5'), /Unknown/u);
  assert.throws(() => models.infer('Claude Opus 5.5 300K Medium Off'), /Unknown/u);
  assert.throws(() => models.infer('claude-opus-5-5'), /Unknown/u);
});

test('unique aliases resolve to the catalog canonical ID', () => {
  const id = opus();
  const models = catalog([id]);
  for (const request of ['Cursor · claude-opus-5-5', 'Claude Opus 5.5 300K Medium']) {
    assert.equal(models.resolve(request), id);
  }
  assert.throws(() => models.resolve('claude-opus-5-5'), /Ambiguous/u);
  assert.throws(() => models.resolve('Claude Opus 5.5'), /Ambiguous/u);
  assert.equal(models.resolve('Cursor · Claude Opus 5.5 1M Medium'), opus('1m'));
});

test('same-family variants make base and family-name aliases ambiguous', () => {
  const models = catalog([opus(), opus('1m')]);
  assert.throws(() => models.resolve('claude-opus-5-5'), /Ambiguous/u);
  assert.throws(() => models.resolve('Claude Opus 5.5'), /Ambiguous/u);
  assert.throws(() => models.resolve('Cursor · claude-opus-5-5'), /Ambiguous/u);
  assert.equal(models.resolve('Claude Opus 5.5 1M Medium'), opus('1m'));
  assert.equal(models.resolve(opus()), opus());
});

test('a hidden variant prevents footer inference for its whole family', () => {
  const hidden = 'claude-opus-5-5[context=300k,effort=medium,fast=false,hidden=true]';
  const models = catalog([opus(), hidden, composer('false')]);
  assert.throws(() => models.resolve('claude-opus-5-5'), /Ambiguous/u);
  assert.throws(() => models.resolve('Claude Opus 5.5'), /Ambiguous/u);
  assert.throws(() => models.infer('Claude Opus 5.5 300K Medium'), /Unknown/u);
  assert.throws(() => models.resolve('Claude Opus 5.5 300K Medium'), /Unknown/u);
  assert.equal(models.resolve(opus()), opus());
  assert.equal(models.resolve(hidden), hidden);
  assert.equal(models.infer('Composer 2.5'), composer('false'));
  const expanded = expandModelVariants({
    models: [opus(), hidden].map(model => ({ model, displayName: model })), modelDefinitions: definitions,
  });
  assert.equal(expanded.length, 2);
});

test('bare, omitted, unknown, or malformed variants prevent family inference', () => {
  for (const invalid of [
    'claude-opus-5-5',
    'claude-opus-5-5[context=300k,effort=medium]',
    'claude-opus-5-5[context=2m,effort=medium,fast=false]',
    'claude-opus-5-5[context=300k,effort=medium,fast=false,fast=false]',
  ]) {
    const models = catalog([opus(), invalid, composer('false')]);
    assert.throws(() => models.infer('Claude Opus 5.5 300K Medium'), /Unknown/u);
    assert.equal(models.resolve(opus()), opus());
    assert.equal(models.resolve(invalid), invalid);
    assert.equal(models.infer('Composer 2.5'), composer('false'));
  }
});

test('exact canonical IDs take precedence over ambiguous aliases', () => {
  const id = 'composer-2.5';
  const models = catalog([id, composer('false'), composer('true')]);
  assert.equal(models.resolve(id), id);
  assert.equal(models.resolve(composer('true')), composer('true'));
});

test('bracket parameter order may change without losing any keys or values', () => {
  const models = catalog([opus()]);
  assert.equal(models.resolve('claude-opus-5-5[fast=false, context=300k, effort=medium]'), opus());
  assert.equal(models.resolve('claude-opus-5-5[context=1m,effort=high,fast=false]'), opus('1m', 'high'));
  for (const request of [
    'claude-opus-5-5[context=2m,effort=high,fast=false]',
    'claude-opus-5-5[context=300k,effort=medium]',
    'claude-opus-5-5[context=300k,effort=medium,fast=false,hidden=true]',
    'claude-opus-5-5[context=300k,effort=medium,fast=false,fast=false]',
    'claude-opus-5-5[context=300k,effort=medium,fast=false,]',
  ]) assert.throws(() => models.resolve(request), /Unknown/u);
});

test('variants with identical complete labels fail closed', () => {
  const duplicateLabels = structuredClone(definitions);
  duplicateLabels[1].configOptions[0].options[1].name = '300K';
  const models = catalog([opus(), opus('1m')], duplicateLabels);
  assert.throws(() => models.infer('Claude Opus 5.5 300K Medium'), /Ambiguous/u);
  assert.throws(() => models.resolve('Claude Opus 5.5 300K Medium'), /Ambiguous/u);
  assert.equal(models.resolve(opus('1m')), opus('1m'));
});

test('unsupported, extra, omitted, or unknown parameter values cannot create labels', () => {
  const cases = [
    'other-model[fast=false]', 'composer-2.5', 'composer-2.5[fast=false,hidden=false]',
    'composer-2.5[fast=off]',
    'claude-opus-5-5[context=300k,fast=false]',
    'claude-opus-5-5[context=300k,effort=medium,fast=false,thinking=true]',
    'claude-opus-5-5[context=2m,effort=medium,fast=false]',
  ];
  for (const id of cases) {
    const models = catalog([id]);
    assert.throws(() => models.infer('Composer 2.5'), /Unknown/u);
    assert.throws(() => models.infer('Claude Opus 5.5 300K Medium'), /Unknown/u);
    assert.equal(models.resolve(id), id);
  }
});

test('missing, duplicate, or expanded definitions cannot authorize a footer label', () => {
  const expanded = structuredClone(definitions);
  expanded[1].configOptions.push({ ...fast, id: 'hidden' });
  const invalidFast = structuredClone(definitions);
  invalidFast[1].configOptions[2].options.push({ value: 'auto', name: 'Auto' });
  for (const modelDefinitions of [[], [...definitions, definitions[1]], expanded, invalidFast]) {
    assert.throws(() => catalog([opus()], modelDefinitions).infer('Claude Opus 5.5 300K Medium'), /Unknown/u);
  }
});

test('malformed definition entries fail closed', () => {
  for (const malformed of [null, { id: 'fast', name: 'Fast', type: 'select', options: [null] }]) {
    const modelDefinitions = [{ ...definitions[0], configOptions: [malformed] }];
    assert.throws(() => catalog([composer('false')], modelDefinitions).infer('Composer 2.5'), /Unknown/u);
  }
});

test('definition order and names determine the complete label', () => {
  const reordered = structuredClone(definitions);
  reordered[1].configOptions.reverse();
  reordered[1].configOptions[0].name = 'Quick';
  const models = catalog([opus('1m', 'high', 'true')], reordered);
  assert.equal(models.infer('Claude Opus 5.5 Quick High 1M'), opus('1m', 'high', 'true'));
  assert.throws(() => models.infer('Claude Opus 5.5 1M High Fast'), /Unknown/u);
});
