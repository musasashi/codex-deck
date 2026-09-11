import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { AppServerClient } from '../src/appServer/client';
import { JsonRpcPeer } from '../src/appServer/rpc';
import { TaskManager } from '../src/core/taskManager';
import { HF_PROVIDER, huggingFaceModel, modelRequest, withHuggingFaceModels } from '../src/core/huggingFace';
import { DEFAULT_PRESET, latestModel, readPresets, resolveRunSettings, taskPresets, validatePreset, validateTitleModel } from '../src/core/settings';
import { object, string, type JsonObject, type RunSettings, type TitleRequest } from '../src/core/types';
import { FakeGateway } from './helpers';

const hfModel = 'hf:deepseek-ai/DeepSeek-V4-Flash:deepinfra';
const hfPreset = { model: hfModel, effort: 'default', mode: 'workspace-write', pricing: { input: 0.09, output: 0.18 } } as const;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('HF presets preserve routing suffixes and work without an OpenAI model catalog', () => {
  assert.deepEqual(validatePreset(hfPreset, []), hfPreset);
  assert.equal(validateTitleModel(hfModel, []), hfModel);
  assert.deepEqual(resolveRunSettings(hfPreset, []), { ...hfPreset, effort: undefined });
  assert.equal(readPresets([{ ...hfPreset, effort: 'max' }])[0]!.effort, 'default');
  assert.deepEqual(modelRequest(hfModel), { model: 'deepseek-ai/DeepSeek-V4-Flash:deepinfra', modelProvider: HF_PROVIDER });
  assert.deepEqual(modelRequest('gpt-model'), { model: 'gpt-model' });
  assert.equal(huggingFaceModel('hf:org/model:cheapest')?.label, 'HF · org/model:cheapest');
  for (const id of ['hf:', 'hf:latest', 'hf:org/model:', 'hf:org/model:one:two', 'hf:org/model\n', 'hf:https://example.com/model']) {
    assert.equal(huggingFaceModel(id), undefined);
    assert.throws(() => modelRequest(id), /HFのモデルID/);
    assert.throws(() => validatePreset({ ...hfPreset, model: id }, []), /モデル/);
  }
  assert.throws(() => validatePreset({ ...hfPreset, effort: 'high' }, []), /推論強度/);
  assert.equal(withHuggingFaceModels([], [hfModel, hfModel]).length, 1);
  assert.equal(latestModel(withHuggingFaceModels([], [hfModel])), undefined, 'HF models must not replace the OpenAI latest alias');
});

test('HF and OpenAI tasks route independently; restored and forked HF history keeps its provider', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const peer = new JsonRpcPeer(input, output, 1000), server = new JsonRpcPeer(output, input, 1000);
  const client = new AppServerClient();
  const manager = new TaskManager(client, { async save() {} }, [], { schedule: false });
  const calls: { method: string; params: JsonObject }[] = [];
  const stored = new Map<string, { thread: JsonObject; model: string }>();
  let sequence = 0;
  server.handleRequest = async ({ method, params: raw }) => {
    const params = object(raw);
    calls.push({ method, params });
    if (method === 'initialize' || method === 'thread/name/set') return {};
    if (method === 'model/list') return { data: [{ model: 'openai-model', isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] };
    if (method === 'thread/start') {
      const id = `thread-${++sequence}`;
      const value = { thread: { id, cwd: '/project', modelProvider: params.modelProvider ?? 'openai', turns: [], status: { type: 'idle' } }, model: string(params.model), reasoningEffort: 'max' };
      stored.set(id, value); return structuredClone(value);
    }
    const value = stored.get(string(params.threadId))!;
    if (method === 'turn/start') {
      assert.equal(params.model, value.model);
      const turn = { id: `turn-${++sequence}`, status: 'inProgress', items: [] };
      value.thread.turns = [turn]; return { turn };
    }
    if (method === 'thread/read') return { thread: value.thread };
    if (method === 'thread/resume' || method === 'thread/fork') {
      assert.equal(params.modelProvider, value.thread.modelProvider, 'provider must be pinned even when the server default is OpenAI');
      const result = structuredClone(value);
      if (method === 'thread/fork') { result.thread.id = `fork-${++sequence}`; stored.set(string(result.thread.id), result); }
      return result;
    }
    throw new Error(`Unexpected request: ${method}`);
  };
  try {
    await client.connect(peer);
    const hf = manager.create('/project', hfPreset), openai = manager.create('/project', DEFAULT_PRESET);
    await Promise.all([manager.send(hf.id, 'HF task'), manager.send(openai.id, 'OpenAI task')]);
    assert.equal(hf.status, 'running'); assert.equal(openai.status, 'running');
    assert.equal(hf.effectiveModel, hfModel); assert.equal(hf.modelProvider, HF_PROVIDER);
    assert.equal(hf.effectiveEffort, undefined, 'the host effort must not appear as the HF model effort');
    assert.equal(hf.settings.effort, 'default');
    const starts = calls.filter(call => call.method === 'thread/start');
    const hfStart = starts.find(call => call.params.modelProvider === HF_PROVIDER)!.params;
    assert.equal(hfStart.model, 'deepseek-ai/DeepSeek-V4-Flash:deepinfra');
    assert.equal(hfStart.serviceTier, null);
    assert.equal(object(hfStart.config).web_search, 'disabled');
    assert.equal(object(hfStart.config).model_supports_reasoning_summaries, false);
    assert.equal(starts.find(call => call.params.model === 'openai-model')!.params.modelProvider, undefined);
    assert.equal(calls.filter(call => call.method === 'model/list').length, 1);
    const hfTurn = calls.find(call => call.method === 'turn/start' && call.params.threadId === hf.threadId)!.params;
    assert.equal(hfTurn.model, 'deepseek-ai/DeepSeek-V4-Flash:deepinfra');
    assert.equal(hfTurn.modelProvider, undefined, 'turn/start inherits the provider from its thread');
    assert.equal(hfTurn.effort, undefined);

    server.notify('item/agentMessage/delta', { threadId: hf.threadId, turnId: hf.activeTurnId, itemId: 'hf-reply', delta: 'HF response' });
    await tick();
    assert.equal(hf.turns[0]?.items.find(item => item.id === 'hf-reply')?.data.text, 'HF response');
    assert.equal(openai.turns[0]?.items.length, 0);
    const tokenUsage = { total: { inputTokens: 1_000_000, outputTokens: 2_000_000 }, last: { inputTokens: 1_000_000, outputTokens: 2_000_000 } };
    server.notify('thread/tokenUsage/updated', { threadId: hf.threadId, turnId: hf.activeTurnId, tokenUsage });
    server.notify('thread/tokenUsage/updated', { threadId: hf.threadId, turnId: hf.activeTurnId, tokenUsage });
    await tick();
    assert.ok(Math.abs(hf.cost!.usd - 0.45) < 1e-10);
    assert.equal(openai.cost, undefined);
    assert.throws(() => manager.updateSettings(hf.id, { model: 'openai-model', mode: 'default' }), /接続先/);
    const before = calls.length;
    await assert.rejects(client.startTurn(hf.threadId!, [], { model: 'openai-model', mode: 'default' }, 'wrong-provider'), /接続先/);
    assert.equal(calls.length, before, 'a mismatched selection must never reach the model');

    const completed = { id: hf.activeTurnId!, status: 'completed', items: [] };
    stored.get(hf.threadId!)!.thread.turns = [completed];
    server.notify('turn/completed', { threadId: hf.threadId, turn: completed }); await tick();

    const records = manager.records();
    assert.equal(records.find(record => record.id === hf.id)?.modelProvider, HF_PROVIDER);
    // Reconnecting discards in-memory provider knowledge and exercises stored metadata reads.
    manager.dispose(); client.detach(); await client.connect(peer);
    const restored = new TaskManager(client, { async save() {} }, records, { schedule: false });
    try {
      await restored.restore(hf.id);
      const value = restored.get(hf.id);
      assert.equal(value.modelProvider, HF_PROVIDER); assert.equal(value.effectiveModel, hfModel);
      server.notify('thread/tokenUsage/updated', { threadId: value.threadId, turnId: completed.id, tokenUsage }); await tick();
      assert.ok(Math.abs(value.cost!.usd - 0.45) < 1e-10);
      const fork = await restored.fork(hf.id);
      assert.equal(fork.modelProvider, HF_PROVIDER); assert.equal(fork.settings.model, hfModel);
      assert.deepEqual(fork.settings.pricing, hfPreset.pricing); assert.equal(fork.cost?.usd, 0);
      assert.deepEqual(taskPresets(fork, [DEFAULT_PRESET, hfPreset]), [hfPreset]);
      assert.ok(calls.some(call => call.method === 'thread/read' && call.params.includeTurns === false));
    } finally { restored.dispose(); await restored.flush(); }
  } finally { manager.dispose(); await manager.flush(); client.detach(); peer.close(); server.close(); }
});

test('HF tasks use their model for default titles and never resume from OpenAI quota recovery', async () => {
  const gateway = new FakeGateway();
  gateway.listModels = async () => { throw new Error('HF must not require the OpenAI catalog'); };
  const titles: TitleRequest[] = [];
  gateway.generateTitle = async request => { titles.push(request); return 'HF title'; };
  const manager = new TaskManager(gateway, { async save() {} }, [], { schedule: false, titleModel: () => 'latest' });
  try {
    const hf = manager.create('/project', hfPreset);
    manager.setAutoResume(hf.id, true); assert.equal(hf.autoResume, false);
    await manager.send(hf.id, 'HF request'); await tick();
    assert.equal(titles[0]?.model, hfModel);
    assert.deepEqual(titles[0]?.pricing, hfPreset.pricing);
    gateway.finish(hf.threadId!, hf.activeTurnId!, 'failed', 'usageLimitExceeded');
    manager.setAutoResume(hf.id, true);
    assert.equal(hf.status, 'limited'); assert.equal(hf.waiting, undefined);
    await manager.checkUsage(); assert.equal(gateway.sent.length, 1);
    const draft = manager.create('/project', DEFAULT_PRESET);
    manager.updateSettings(draft.id, hfPreset);
    assert.equal(draft.settings.model, hfModel);
    assert.deepEqual(taskPresets(draft, [DEFAULT_PRESET, hfPreset]), [DEFAULT_PRESET, hfPreset]);
  } finally { manager.dispose(); await manager.flush(); }
});
