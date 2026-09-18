import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { AppServerClient } from '../src/appServer/client';
import { JsonRpcPeer } from '../src/appServer/rpc';
import { TaskManager, readTaskRecords } from '../src/core/taskManager';
import { object, type JsonObject, type SettingsPreset } from '../src/core/types';

const presets: SettingsPreset[] = [
  { model: 'gpt-5.6-terra', effort: 'high', mode: 'auto-review' },
  { model: 'gpt-5.6-sol', effort: 'xhigh', mode: 'auto-review' },
  { model: 'gpt-6-astra', effort: 'max', mode: 'auto-review' },
];

for (const scenario of ['selected preset', 'fork', 'saved task without overrides', 'history', 'pending preset change'] as const) {
  test(`${scenario} retains its model across a restart with a different Codex default`, async () => {
    const input = new PassThrough(), output = new PassThrough();
    const peer = new JsonRpcPeer(input, output, 1000), server = new JsonRpcPeer(output, input, 1000);
    const client = new AppServerClient();
    let manager = new TaskManager(client, { async save() {} }, [], { schedule: false });
    const stored = new Map<string, JsonObject>();
    const resumes: JsonObject[] = [];
    const warnings: string[] = [];
    let sequence = 0;
    const selected = presets[1]!, defaults = presets[2]!;
    client.generateTitle = async () => 'Preset restoration';
    server.handleRequest = async ({ method, params: raw }) => {
      const params = object(raw);
      if (method === 'initialize' || method === 'thread/name/set') return {};
      if (method === 'model/list') return { data: presets.map(preset => ({ model: preset.model,
        supportedReasoningEfforts: [{ reasoningEffort: preset.effort }], defaultReasoningEffort: preset.effort,
        isDefault: preset === defaults })) };
      if (method === 'thread/start' || method === 'thread/fork') {
        const source = stored.get(String(params.threadId));
        const thread = { ...structuredClone(source), id: `thread-${++sequence}`, cwd: '/project', modelProvider: 'openai',
          model: params.model ?? defaults.model, reasoningEffort: object(params.config).model_reasoning_effort ?? defaults.effort,
          status: { type: 'idle' }, turns: source?.turns ?? [] };
        stored.set(thread.id, thread);
        return { thread, model: thread.model, reasoningEffort: thread.reasoningEffort };
      }
      const thread = stored.get(String(params.threadId))!;
      if (method === 'thread/read') return { thread: structuredClone(thread) };
      if (method === 'thread/resume') {
        resumes.push(params);
        // Codex uses config.toml when the provider is overridden without a model override.
        const model = params.model ?? (params.modelProvider ? defaults.model : thread.model);
        if (model !== thread.model) {
          const message = `This session was recorded with model \`${thread.model}\` but is resuming with \`${model}\`.`;
          warnings.push(message);
          server.notify('warning', { threadId: thread.id, message });
        }
        return { thread: structuredClone(thread), model,
          reasoningEffort: object(params.config).model_reasoning_effort ?? (params.modelProvider ? defaults.effort : thread.reasoningEffort) };
      }
      if (method === 'turn/start') {
        thread.model = params.model ?? thread.model;
        thread.reasoningEffort = params.effort ?? thread.reasoningEffort;
        const turn = { id: `turn-${++sequence}`, status: 'completed', items: [] };
        thread.turns = [...thread.turns as JsonObject[], turn];
        return { turn };
      }
      throw new Error(`Unexpected request: ${method}`);
    };
    try {
      await client.connect(peer);
      const source = manager.create('/project', presets[0]!);
      manager.updateSettings(source.id, selected);
      await manager.send(source.id, 'Run with preset 2');
      const task = scenario === 'fork' ? await manager.fork(source.id) : source;
      if (scenario === 'fork') await manager.send(task.id, 'Continue in the fork');
      const expected = scenario === 'pending preset change' ? presets[0]! : selected;
      if (scenario === 'pending preset change') manager.updateSettings(task.id, expected);
      await manager.flush();
      const records = readTaskRecords(JSON.parse(JSON.stringify({ version: 1, tasks: manager.records() })));
      if (scenario === 'saved task without overrides') records.find(record => record.id === task.id)!.settings = { mode: 'default' };
      manager.dispose();
      client.detach();
      await client.connect(peer);
      manager = new TaskManager(client, { async save() {} }, scenario === 'history' ? [] : records, { schedule: false });
      const restored = scenario === 'history' ? manager.openThread(task.threadId!) : manager.get(task.id);
      await manager.restore(restored.id);

      assert.equal(resumes.at(-1)?.model, expected.model, 'resume must pin the selected or recorded model');
      assert.equal(object(resumes.at(-1)?.config).model_reasoning_effort, expected.effort);
      assert.equal(warnings.length, scenario === 'pending preset change' ? 1 : 0);
      assert.equal(restored.effectiveModel, expected.model);
      assert.equal(restored.effectiveEffort, expected.effort);
      assert.equal(restored.settings.model, expected.model);
      assert.equal(restored.settings.effort, expected.effort);
      if (scenario === 'selected preset' || scenario === 'fork' || scenario === 'pending preset change') assert.deepEqual(restored.settings, expected);
      assert.equal(manager.records().find(record => record.id === restored.id)?.settings.model, expected.model);
      await manager.send(restored.id, 'Continue after restart');
      assert.equal(stored.get(restored.threadId!)?.model, expected.model);
      assert.equal(stored.get(restored.threadId!)?.reasoningEffort, expected.effort);
    } finally { manager.dispose(); await manager.flush(); client.detach(); peer.close(); server.close(); }
  });
}
