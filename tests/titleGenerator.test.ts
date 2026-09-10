import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { TitleGenerator } from '../src/appServer/titleGenerator';
import { JsonRpcPeer } from '../src/appServer/rpc';
import { object, type JsonObject, type Model } from '../src/core/types';
import { deferred } from './helpers';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const request = { cwd: '/project', model: 'title-model', effort: 'lowest', input: '{"request":"ログインエラーを修正して"}' };
const models: Model[] = [{ id: 'title-model', label: 'Title model', description: '', efforts: [{ id: 'low', description: '' }], defaultEffort: 'high', isDefault: true, inputModalities: ['text'] }];

function harness(timeoutMs = 1000, catalog = models) {
  const input = new PassThrough(); const output = new PassThrough();
  const peer = new JsonRpcPeer(input, output, 1000);
  const server = new JsonRpcPeer(output, input, 1000);
  const generator = new TitleGenerator(peer, async () => catalog, timeoutMs);
  const calls: { method: string; params: JsonObject }[] = [];
  let handle: (method: string, params: JsonObject) => Promise<unknown> = async method => {
    if (method === 'config/read') return { config: { mcp_servers: { sample: { command: 'server', required: true } } } };
    if (method === 'thread/start') return { thread: { id: 'title-thread' } };
    if (method === 'turn/start') return { turn: { id: 'title-turn', status: 'inProgress', items: [] } };
    return {};
  };
  server.handleRequest = ({ method, params }) => { calls.push({ method, params: object(params) }); return handle(method, object(params)); };
  return { generator, calls, server, peer, setHandler: (next: typeof handle) => { handle = next; },
    dispose: () => { generator.dispose(); peer.close(); server.close(); } };
}

test('titles use an ephemeral read-only thread, bounded structured output, and the selected model at low effort', async () => {
  const h = harness();
  try {
    const result = h.generator.generate(request, new AbortController().signal); await tick();
    const start = h.calls.find(call => call.method === 'thread/start')!.params;
    assert.equal(start.model, 'title-model'); assert.equal(start.ephemeral, true);
    assert.equal(start.sandbox, 'read-only'); assert.equal(start.approvalPolicy, 'never');
    assert.equal(object(start.config).model_reasoning_effort, 'low');
    assert.equal(object(start.config)['features.hooks'], false);
    assert.equal(object(start.config)['features.apps'], false);
    assert.equal(object(start.config)['features.shell_tool'], false);
    assert.deepEqual(object(start.config).mcp_servers, { sample: { enabled: false, required: false } });
    const turn = h.calls.find(call => call.method === 'turn/start')!.params;
    assert.equal(object(turn.outputSchema).additionalProperties, false);
    assert.equal(object(object(object(turn.outputSchema).properties).title).maxLength, 40);
    h.server.notify('item/completed', { threadId: 'another-task', item: { id: 'other', type: 'agentMessage', text: '{"title":"Wrong"}' } });
    h.server.notify('item/completed', { threadId: 'title-thread', item: { id: 'title', type: 'agentMessage', text: '{"title":"ログインエラーを修正"}' } });
    h.server.notify('turn/completed', { threadId: 'title-thread', turn: { id: 'title-turn', status: 'completed', items: [] } });
    assert.equal(await result, 'ログインエラーを修正'); await tick();
    assert.equal(h.calls.filter(call => call.method === 'thread/unsubscribe').length, 1);
    assert.equal(h.calls.filter(call => call.method === 'turn/interrupt').length, 0);
    assert.equal(h.generator.threadIds.size, 0);
  } finally { h.dispose(); }
});

test('selected title effort and the lowest effort of the latest model reach the title thread', async () => {
  const catalog = [{ ...models[0]!, upgrade: 'latest-title' }, { ...models[0]!, id: 'latest-title', isDefault: false,
    efforts: ['high', 'minimal', 'low'].map(id => ({ id, description: '' })), defaultEffort: 'high' }];
  for (const [effort, expected] of [['lowest', 'minimal'], ['high', 'high'], ['default', 'high'], ['unsupported', 'minimal']]) {
    const h = harness(1000, catalog);
    try {
      const result = h.generator.generate({ ...request, model: 'latest', effort: effort! }, new AbortController().signal); await tick();
      const start = h.calls.find(call => call.method === 'thread/start')!.params;
      assert.equal(start.model, 'latest-title');
      assert.equal(object(start.config).model_reasoning_effort, expected);
      h.server.notify('turn/completed', { threadId: 'title-thread', turn: { id: 'title-turn', status: 'completed', items: [
        { id: 'answer', type: 'agentMessage', text: '{"title":"Selected effort"}' },
      ] } });
      assert.equal(await result, 'Selected effort');
    } finally { h.dispose(); }
  }
});

test('completion notifications before the start response and immediate completed responses are supported', async () => {
  for (const early of [true, false]) {
    const h = harness(); const started = deferred<unknown>();
    h.setHandler(async method => {
      if (method === 'thread/start') return { thread: { id: 'title-thread' } };
      if (method === 'turn/start') return early ? started.promise : { turn: { id: 'title-turn', status: 'completed', items: [
        { id: 'answer', type: 'agentMessage', text: '{"title":"Immediate"}' },
      ] } };
      return {};
    });
    try {
      const result = h.generator.generate(request, new AbortController().signal); await tick();
      if (early) {
        h.server.notify('item/agentMessage/delta', { threadId: 'title-thread', itemId: 'answer', delta: '{"title":' });
        h.server.notify('item/agentMessage/delta', { threadId: 'title-thread', itemId: 'answer', delta: '"Early"}' });
        h.server.notify('turn/completed', { threadId: 'title-thread', turn: { id: 'title-turn', status: 'completed', items: [] } });
        started.resolve({ turn: { id: 'title-turn', status: 'inProgress', items: [] } });
      }
      assert.equal(await result, early ? 'Early' : 'Immediate');
    } finally { h.dispose(); }
  }
});

test('timeouts interrupt only the title turn and unsubscribe without waiting for the task', async () => {
  const h = harness(20);
  try {
    await assert.rejects(h.generator.generate(request, new AbortController().signal), /タイムアウト/);
    await tick();
    assert.deepEqual(h.calls.find(call => call.method === 'turn/interrupt')?.params, { threadId: 'title-thread', turnId: 'title-turn' });
    assert.deepEqual(h.calls.find(call => call.method === 'thread/unsubscribe')?.params, { threadId: 'title-thread' });
  } finally { h.dispose(); }
});

test('late thread and turn creation responses are cleaned up even after the deadline', async () => {
  for (const lateMethod of ['thread/start', 'turn/start']) {
    const h = harness(20); const response = deferred<unknown>();
    h.setHandler(async method => {
      if (method === lateMethod) return response.promise;
      if (method === 'thread/start') return { thread: { id: 'title-thread' } };
      return {};
    });
    try {
      await assert.rejects(h.generator.generate(request, new AbortController().signal), /タイムアウト/);
      response.resolve(lateMethod === 'thread/start' ? { thread: { id: 'title-thread' } } : { turn: { id: 'title-turn', status: 'inProgress' } });
      await tick();
      assert.equal(h.calls.filter(call => call.method === 'thread/unsubscribe').length, 1);
      assert.equal(h.calls.filter(call => call.method === 'turn/interrupt').length, lateMethod === 'turn/start' ? 1 : 0);
      if (lateMethod === 'thread/start') assert.equal(h.calls.filter(call => call.method === 'turn/start').length, 0);
    } finally { h.dispose(); }
  }
});

test('invalid output, failed turns, unavailable models and disconnection reject without retaining a title thread', async () => {
  for (const scenario of ['invalid', 'failed', 'missing-model', 'disconnect']) {
    const h = harness();
    try {
      const generating = h.generator.generate({ ...request, model: scenario === 'missing-model' ? 'unavailable' : request.model }, new AbortController().signal);
      const rejected = assert.rejects(generating);
      await tick();
      if (scenario === 'disconnect') h.peer.close();
      else if (scenario !== 'missing-model') h.server.notify('turn/completed', { threadId: 'title-thread', turn: {
        id: 'title-turn', status: scenario === 'failed' ? 'failed' : 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'not a title object' }],
      } });
      await rejected; await tick();
      assert.equal(h.generator.threadIds.size, 0);
      if (scenario === 'missing-model') assert.equal(h.calls.filter(call => call.method === 'thread/start').length, 0);
    } finally { h.dispose(); }
  }
});
