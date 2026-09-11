import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { canonicalProvider, displayModel, externalModelConfig, modelRequest, providerId, providerModels, responsesModelId, sameTaskProvider, validateProviders } from '../src/core/providers';
import { latestModel, resolveRunSettings, taskPresets, validatePreset } from '../src/core/settings';
import { AppServerClient } from '../src/appServer/client';
import { JsonRpcPeer } from '../src/appServer/rpc';
import { TaskManager } from '../src/core/taskManager';
import { object, string, type JsonObject } from '../src/core/types';

const providers = validateProviders([
  { id: 'one', name: 'First API', baseUrl: 'https://first.example/v1/', apiKeyEnv: 'FIRST_KEY', models: [{ id: 'org/model:tag', reasoningEfforts: ['low', 'high'], images: true, structuredOutput: true }] },
  { id: 'two', name: 'Local API', baseUrl: 'http://localhost:11434/v1', models: [{ id: 'org/model:tag' }] },
]);
const model = responsesModelId('one', 'org/model:tag'), other = responsesModelId('two', 'org/model:tag');
const preset = { model, effort: 'high', mode: 'read-only' } as const;

test('provider identity and model capabilities are independent of model IDs and the native latest alias', () => {
  assert.equal(providers[0]!.baseUrl, 'https://first.example/v1');
  assert.deepEqual(modelRequest(model), { model: 'org/model:tag', modelProvider: providerId('one') });
  assert.equal(displayModel('org/model:tag', providerId('one')), model);
  assert.equal(displayModel(model, providerId('one')), model);
  assert.equal(canonicalProvider('huggingface'), 'codex_deck_huggingface');
  const catalog = providerModels(providers);
  assert.deepEqual(catalog[0]!.inputModalities, ['text', 'image']);
  assert.equal(catalog[0]!.structuredOutput, true);
  assert.deepEqual(catalog[1]!.efforts, []);
  assert.equal(latestModel(catalog), undefined);
  assert.deepEqual(validatePreset(preset, catalog), preset, 'pricing is optional');
  assert.equal(resolveRunSettings({ ...preset, effort: 'default' }, catalog).effort, undefined);
  assert.throws(() => validatePreset({ ...preset, model: other }, catalog), /推論強度/);
  assert.equal(externalModelConfig(model, providers, 'high').model_reasoning_effort, 'high');
  assert.equal(externalModelConfig(other, providers, 'high').model_reasoning_effort, undefined);
});

test('invalid endpoints, credentials, duplicated identities and malformed models are rejected', () => {
  const base = providers[0]!;
  for (const patch of [{ id: 'invalid.id' }, { name: '' }, { apiKeyEnv: 'KEY;echo oops' },
    { baseUrl: 'file:///tmp/model' }, { baseUrl: 'https://user:secret@example.com' }, { baseUrl: 'ftp://remote.example/v1' },
    { baseUrl: 'https://example.com/v1?key=secret' }, { models: [] }, { models: [{ id: 'model with spaces' }] }]) {
    assert.throws(() => validateProviders([{ ...base, ...patch }]));
  }
  assert.throws(() => validateProviders([base, base]), /接続先ID/);
  assert.throws(() => validateProviders([{ ...base, models: [base.models[0], base.models[0]] }]), /モデルID/);
  assert.throws(() => modelRequest('responses:bad'), /モデルID/);
});

test('custom tasks route, restore and fork independently and cannot switch to another provider with the same model ID', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const peer = new JsonRpcPeer(input, output, 1000), server = new JsonRpcPeer(output, input, 1000);
  const client = new AppServerClient(() => providers, async id => ({ model_providers: { [modelRequest(id).modelProvider!]: { base_url: 'http://127.0.0.1:1234/v1', wire_api: 'responses' } } }));
  const manager = new TaskManager(client, { async save() {} }, [], { schedule: false });
  const calls: { method: string; params: JsonObject }[] = [], stored = new Map<string, JsonObject>();
  let n = 0;
  server.handleRequest = async ({ method, params: raw }) => {
    const params = object(raw); calls.push({ method, params });
    if (method === 'initialize') return {};
    if (method === 'model/list') throw new Error('Native model catalog unavailable');
    if (method === 'thread/start') {
      const thread = { id: `t${++n}`, cwd: '/project', turns: [], status: { type: 'idle' }, modelProvider: params.modelProvider };
      stored.set(thread.id, { thread, model: params.model, reasoningEffort: 'high' }); return stored.get(thread.id);
    }
    const value = stored.get(string(params.threadId))!;
    if (method === 'thread/read') return { thread: value.thread };
    if (method === 'thread/resume') return value;
    if (method === 'thread/fork') {
      const copy = structuredClone(value); object(copy.thread).id = `f${++n}`; stored.set(string(object(copy.thread).id), copy); return copy;
    }
    if (method === 'turn/start') return { turn: { id: `turn${++n}`, status: 'completed', items: [] } };
    throw new Error(`Unexpected: ${method}`);
  };
  try {
    await client.connect(peer);
    const one = manager.create('/project', preset), two = manager.create('/project', { ...preset, model: other, effort: 'default' });
    await manager.send(one.id, 'first'); await manager.send(two.id, 'second');
    assert.equal(one.status, 'idle'); assert.equal(two.status, 'idle');
    assert.equal(one.effectiveModel, model); assert.equal(two.effectiveModel, other);
    assert.ok(sameTaskProvider(one, model)); assert.ok(!sameTaskProvider(one, other));
    assert.deepEqual(taskPresets(one, [preset, { ...preset, model: other }]), [preset]);
    assert.throws(() => manager.updateSettings(one.id, { ...preset, model: other }), /接続先/);
    const count = calls.length;
    await assert.rejects(client.startTurn(one.threadId!, [], { ...preset, model: other }, 'bad'), /接続先/);
    await assert.rejects(client.forkThread(one.threadId!, { settings: { ...preset, model: other } }), /接続先/);
    assert.equal(calls.length, count);
    const started = calls.find(c => c.method === 'thread/start')!.params;
    assert.equal(started.serviceTier, null);
    assert.equal(object(started.config).model_reasoning_effort, 'high');
    assert.ok(object(object(started.config).model_providers)[providerId('one')]);
    const switched = calls.length;
    await client.startTurn(one.threadId!, [], { ...preset, effort: 'low' }, 'lower-effort');
    assert.deepEqual(calls.slice(switched).map(call => call.method), ['thread/resume', 'turn/start']);
    assert.equal(object(calls[switched]!.params.config).model_reasoning_effort, 'low');
    assert.equal(calls[switched + 1]!.params.effort, 'low');
    const repeated = calls.length;
    await client.startTurn(one.threadId!, [], { ...preset, effort: 'low' }, 'same-effort');
    assert.deepEqual(calls.slice(repeated).map(call => call.method), ['turn/start']);
    await client.startTurn(one.threadId!, [], { ...preset, effort: undefined }, 'default-effort');
    assert.equal(calls.at(-1)!.params.effort, null);
    assert.equal(object(calls.at(-2)!.params.config).model_reasoning_effort, undefined);
    server.notify('thread/tokenUsage/updated', { threadId: one.threadId, turnId: 'cost', tokenUsage: { total: { inputTokens: 10, outputTokens: 5 }, last: { inputTokens: 10, outputTokens: 5 } } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(one.cost?.unpricedTokens, 15);
    manager.setAutoResume(one.id, true); assert.equal(one.autoResume, false);
    await client.resumeThread(one.threadId!);
    const resumed = calls.findLast(c => c.method === 'thread/resume')!.params;
    assert.equal(resumed.modelProvider, providerId('one'));
    assert.ok(object(object(resumed.config).model_providers)[providerId('one')]);
    const fork = await manager.fork(one.id);
    assert.equal(fork.modelProvider, one.modelProvider); assert.equal(fork.settings.model, model); assert.equal(fork.settings.effort, 'high');
    const defaultFork = await manager.fork(two.id);
    assert.equal(defaultFork.settings.effort, undefined); assert.equal(defaultFork.effectiveEffort, undefined);
    assert.equal(object(calls.findLast(call => call.method === 'thread/fork')!.params.config).model_reasoning_effort, undefined);
  } finally { manager.dispose(); await manager.flush(); client.detach(); peer.close(); server.close(); }
});
