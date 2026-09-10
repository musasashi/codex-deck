import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRESET, presetEffortOptions, latestModel, nextPresetIndex, readPresets, readTitleEffort, readTitleModel, resolveRunSettings, resolveTitleEffort, titleEffortOptions, validatePreset, validatePresets, validateTitleEffort, validateTitleModel } from '../src/core/settings';
import { TaskManager } from '../src/core/taskManager';
import type { Model, RunSettings, SettingsPreset } from '../src/core/types';
import { deferred, FakeGateway } from './helpers';

function model(id: string, extra: Partial<Model> = {}): Model {
  return { id, label: id, description: '', efforts: ['low', 'medium', 'high'].map(id => ({ id, description: id })), defaultEffort: 'medium', isDefault: false, inputModalities: ['text'], ...extra };
}

test('title models default to latest and validate an independent live catalog selection', () => {
  const models = [model('general', { isDefault: true }), model('fast-title')];
  assert.equal(readTitleModel(undefined), 'latest');
  assert.equal(readTitleModel('  fast-title  '), 'fast-title');
  assert.equal(validateTitleModel('fast-title', models), 'fast-title');
  assert.equal(validateTitleModel('latest', models), 'latest');
  assert.throws(() => validateTitleModel('missing', models), /要約に使うモデル/);
  assert.throws(() => validateTitleModel('', models), /要約に使うモデル/);
});

test('title effort defaults to the lowest supported level regardless of catalog order', () => {
  assert.equal(readTitleEffort(undefined), 'lowest');
  assert.equal(readTitleEffort('  '), 'lowest');
  assert.equal(readTitleEffort('  high  '), 'high');
  const selected = model('title', { efforts: ['high', 'low', 'medium'].map(id => ({ id, description: '' })) });
  assert.equal(resolveTitleEffort('lowest', selected), 'low');
  assert.equal(resolveTitleEffort('high', selected), 'high');
  assert.equal(resolveTitleEffort('default', selected), 'medium');
  assert.equal(resolveTitleEffort('unavailable', selected), 'low');
  selected.efforts.push({ id: 'minimal', description: '' });
  assert.equal(resolveTitleEffort('lowest', selected), 'minimal');
  selected.efforts.push({ id: 'none', description: '' });
  assert.equal(resolveTitleEffort('lowest', selected), 'none');
  assert.equal(resolveTitleEffort('lowest', model('no-low', { efforts: [{ id: 'high', description: '' }, { id: 'medium', description: '' }] })), 'medium');
  assert.equal(resolveTitleEffort('lowest', model('no-options', { efforts: [] })), 'medium');
  assert.equal(resolveTitleEffort('lowest', model('no-reasoning', { efforts: [], defaultEffort: '' })), undefined);
});

test('title effort accepts live catalog choices and rejects unsupported values before saving', () => {
  const selected = model('title', { efforts: [{ id: 'future-effort', description: '' }], defaultEffort: 'future-effort' });
  assert.deepEqual(titleEffortOptions(selected), [
    { id: 'lowest', label: '最低 (future-effort)' }, { id: 'default', label: 'モデルの既定値' }, { id: 'future-effort', label: 'future-effort' },
  ]);
  for (const effort of ['lowest', 'default', 'future-effort']) {
    assert.equal(validateTitleEffort(effort, selected), effort);
    assert.equal(resolveTitleEffort(effort, selected), 'future-effort');
  }
  assert.throws(() => validateTitleEffort('high', selected), /推論強度/);
  assert.throws(() => validateTitleEffort('', selected), /推論強度/);
});

test('latest model follows the catalog recommendation and available upgrades without sorting model names', () => {
  const models = [model('z-specialized'), model('recommended', { isDefault: true, upgrade: 'next' }), model('next', { upgrade: 'current' }), model('current')];
  assert.equal(latestModel(models)?.id, 'current');
  assert.equal(latestModel([model('available', { isDefault: true, upgrade: 'unavailable' })])?.id, 'available');
  assert.equal(latestModel([model('first', { upgrade: 'second' }), model('second', { upgrade: 'first' })])?.id, 'second');
  assert.equal(latestModel([]), undefined);
});

test('task defaults resolve to high and auto-review, while explicit settings remain selected', () => {
  const models = [model('selected'), model('recommended', { isDefault: true })];
  assert.deepEqual(resolveRunSettings(DEFAULT_PRESET, models), { model: 'recommended', effort: 'high', mode: 'auto-review' });
  const selected: RunSettings = { model: 'selected', effort: 'low', mode: 'read-only' };
  assert.deepEqual(resolveRunSettings(selected, models), selected);
  assert.deepEqual(resolveRunSettings({ mode: 'default' }, models), { mode: 'default' });
  assert.deepEqual(resolveRunSettings({ ...selected, effort: 'unsupported' }, models), { ...selected, effort: 'medium' });
  assert.throws(() => resolveRunSettings(DEFAULT_PRESET, []), /利用できるモデル/);
  assert.throws(() => resolveRunSettings({ ...selected, model: 'unavailable' }, models), /unavailable/);
});

test('default settings accept live catalog choices and reject unsupported models, efforts, and permissions', () => {
  const models = [model('dynamic-model', { isDefault: true, efforts: [{ id: 'future-effort', description: 'From the server' }] })];
  assert.deepEqual(presetEffortOptions(models[0]), [{ id: 'default', label: 'モデルの既定値' }, { id: 'future-effort', label: 'future-effort' }]);
  const settings = { model: 'dynamic-model', effort: 'future-effort', mode: 'auto-review' };
  assert.deepEqual(validatePreset(settings, models), settings);
  assert.deepEqual(validatePreset({ ...settings, model: 'latest', effort: 'default' }, models), { ...settings, model: 'latest', effort: 'default' });
  assert.throws(() => validatePreset({ ...settings, model: 'missing' }, models), /モデル/);
  assert.throws(() => validatePreset({ ...settings, effort: 'high' }, models), /推論強度/);
  assert.throws(() => validatePreset({ ...settings, mode: 'unknown' }, models), /権限/);
});

test('presets retain their order and reject invalid entries and an empty list before saving', () => {
  const models = [model('recommended', { isDefault: true })];
  const presets = [{ model: 'recommended', effort: 'low', mode: 'read-only' }, DEFAULT_PRESET];
  assert.deepEqual(validatePresets(presets, models), presets);
  assert.deepEqual(readPresets(presets), presets);
  assert.deepEqual(readPresets(undefined), [DEFAULT_PRESET]);
  assert.deepEqual(readPresets([null, {}, { model: 'recommended', effort: 'high', mode: 'invalid' }]), [DEFAULT_PRESET]);
  assert.throws(() => validatePresets([], models), /1件以上/);
  assert.throws(() => validatePresets({}, models), /1件以上/);
  assert.throws(() => validatePresets([DEFAULT_PRESET, { ...DEFAULT_PRESET, effort: 'unsupported' }], models), /プリセット2.*推論強度/);
});

test('three presets cycle together, wrap around, and start at the first after unmatched manual settings', () => {
  const models = [model('recommended', { isDefault: true }), model('specialized')];
  const presets: SettingsPreset[] = [DEFAULT_PRESET, { model: 'specialized', effort: 'low', mode: 'read-only' }, { model: 'recommended', effort: 'default', mode: 'workspace-write' }];
  let settings: RunSettings = { mode: 'default' };
  let previous = -1;
  for (const expected of [0, 1, 2, 0, 1]) {
    const index = nextPresetIndex(settings, presets, models, previous);
    assert.equal(index, expected);
    settings = resolveRunSettings(validatePreset(presets[index], models), models);
    assert.deepEqual(settings, resolveRunSettings(presets[expected]!, models));
    previous = index;
  }
  assert.equal(nextPresetIndex({ model: 'specialized', effort: 'high', mode: 'auto-review' }, presets, models, previous), 0);
  assert.equal(nextPresetIndex(DEFAULT_PRESET, presets, models), 1);
  assert.equal(nextPresetIndex(settings, [], models), -1);
  assert.equal(nextPresetIndex(settings, [DEFAULT_PRESET], models), 0);
});

test('cycling remembers duplicate presets, recognizes resolved aliases, and handles changed lists', () => {
  const models = [model('recommended', { isDefault: true })];
  const presets: SettingsPreset[] = [DEFAULT_PRESET, DEFAULT_PRESET, { model: 'recommended', effort: 'default', mode: 'read-only' }];
  const resolved = resolveRunSettings(DEFAULT_PRESET, models);
  assert.equal(nextPresetIndex(resolved, presets, models, 0), 1);
  assert.equal(nextPresetIndex(resolved, presets, models, 1), 2);
  assert.equal(nextPresetIndex(resolveRunSettings(presets[2]!, models), presets, models), 0);
  assert.equal(nextPresetIndex(resolved, [presets[2]!, DEFAULT_PRESET], models, 2), 0);
  assert.equal(nextPresetIndex(resolved, [{ ...DEFAULT_PRESET, model: 'unavailable' }, DEFAULT_PRESET], models), 0);
});

test('first send waits for the model catalog, resolves latest once, and saves the actual run settings', async () => {
  const gateway = new FakeGateway();
  const catalog = deferred<Model[]>();
  gateway.listModels = () => catalog.promise;
  const manager = new TaskManager(gateway, { async save() {} }, [], { schedule: false });
  try {
    const settings: RunSettings = { ...DEFAULT_PRESET };
    const task = manager.create('/project', settings);
    settings.mode = 'read-only';
    assert.equal(task.settings.mode, 'auto-review');
    assert.ok(manager.openTasks.includes(task));
    const sending = manager.send(task.id, 'test');
    assert.equal(task.threadId, undefined);
    assert.equal(gateway.sent.length, 0);
    catalog.resolve([model('current', { isDefault: true })]);
    await sending;
    assert.deepEqual(gateway.sent[0]?.settings, { model: 'current', effort: 'high', mode: 'auto-review' });
    assert.deepEqual(manager.records()[0]?.settings, gateway.sent[0]?.settings);
    gateway.finish(task.threadId!, task.activeTurnId!, 'completed');
    gateway.listModels = async () => { throw new Error('an existing thread must keep its selected model'); };
    await manager.send(task.id, 'follow-up');
    assert.deepEqual(gateway.sent[1]?.settings, gateway.sent[0]?.settings);
  } finally { manager.dispose(); await manager.flush(); }
});

test('a manual model selection during catalog loading wins over automatic defaults', async () => {
  const gateway = new FakeGateway();
  const catalog = deferred<Model[]>();
  gateway.listModels = () => catalog.promise;
  const manager = new TaskManager(gateway, { async save() {} }, [], { schedule: false });
  try {
    const task = manager.create('/project', DEFAULT_PRESET);
    const starting = manager.ensureThread(task);
    manager.updateSettings(task.id, { model: 'manual', effort: 'low', mode: 'workspace-write' });
    catalog.resolve([model('recommended', { isDefault: true }), model('manual')]);
    await starting;
    assert.deepEqual(task.settings, { model: 'manual', effort: 'low', mode: 'workspace-write' });
  } finally { manager.dispose(); await manager.flush(); }
});
