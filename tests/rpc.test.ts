import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { AppServerClient, decodeThread } from '../src/appServer/client';
import { JsonRpcPeer, RpcError } from '../src/appServer/rpc';
import { TaskManager } from '../src/core/taskManager';
import { DEFAULT_PRESET } from '../src/core/settings';
import { object } from '../src/core/types';
import { deferred } from './helpers';

function harness() {
  const input = new PassThrough(); const output = new PassThrough();
  const messages: Record<string, unknown>[] = [];
  output.on('data', chunk => { for (const line of String(chunk).trim().split('\n')) messages.push(JSON.parse(line) as Record<string, unknown>); });
  const peer = new JsonRpcPeer(input, output, 1000);
  const send = (value: unknown) => input.write(`${JSON.stringify(value)}\n`);
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  return { peer, input, output, messages, send, tick };
}

test('reset credit redemption uses only the explicitly selected ID and preserves its idempotency key over in-memory RPC', async () => {
  // PassThrough streams cannot contact Codex or an account; no real ticket can be consumed.
  const h = harness(); const client = new AppServerClient();
  const connecting = client.connect(h.peer); h.send({ id: h.messages[0]!.id, result: {} }); await connecting;
  try {
    const reading = client.readUsage();
    assert.equal(h.messages.at(-1)!.method, 'account/rateLimits/read');
    h.send({ id: h.messages.at(-1)!.id, result: { rateLimitResetCredits: { availableCount: 1, credits: null } } });
    assert.equal((await reading).resetCredits?.availableCount, 1);
    assert.equal(h.messages.filter(message => message.method === 'account/rateLimitResetCredit/consume').length, 0);
    for (const outcome of ['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed']) {
      const consuming = client.consumeResetCredit('fake-credit', 'fake-idempotency-key');
      const request = h.messages.at(-1)!;
      assert.equal(request.method, 'account/rateLimitResetCredit/consume');
      assert.deepEqual(request.params, { creditId: 'fake-credit', idempotencyKey: 'fake-idempotency-key' });
      h.send({ id: request.id, result: { outcome } }); assert.equal(await consuming, outcome);
    }
    const unknown = client.consumeResetCredit('fake-credit', 'fake-idempotency-key');
    h.send({ id: h.messages.at(-1)!.id, result: { outcome: 'future' } });
    await assert.rejects(unknown, /使用結果を確認できません/);
  } finally { client.detach(); h.peer.close(); }
});

test('JSONL correlates out-of-order responses, preserves UTF-8 framing and omits the jsonrpc header', async () => {
  const h = harness();
  const first = h.peer.request('first'); const second = h.peer.request('second');
  assert.ok(!('jsonrpc' in h.messages[0]!));
  const data = Buffer.from(`${JSON.stringify({ id: h.messages[1]!.id, result: { message: '日本語' } })}\n`);
  const offset = data.indexOf(Buffer.from('日')) + 1;
  h.input.write(data.subarray(0, offset)); h.input.write(data.subarray(offset));
  h.send({ id: h.messages[0]!.id, result: { message: 'first' } });
  assert.deepEqual(await first, { message: 'first' }); assert.deepEqual(await second, { message: '日本語' }); h.peer.close();
});

test('unknown server requests return -32601; unknown notifications do not stop the connection', async () => {
  const h = harness();
  h.send({ id: 'future', method: 'future/request', params: {} });
  h.send({ method: 'future/notification', params: { newField: true } });
  await h.tick();
  assert.equal(object(h.messages[0]!.error).code, -32601);
  const pending = h.peer.request('still/works'); const id = h.messages.at(-1)!.id;
  h.send({ id, result: {} }); await pending; h.peer.close();
});

test('broken framing, disconnection and RPC errors reject outstanding requests', async () => {
  const h = harness();
  const pending = h.peer.request('read');
  h.send({ id: h.messages[0]!.id, error: { code: 42, message: 'failure', data: { extra: true } } });
  await assert.rejects(pending, error => error instanceof RpcError && error.code === 42);
  const broken = h.peer.request('read'); h.input.write('not-json\n');
  await assert.rejects(broken, /JSON/);
  await assert.rejects(h.peer.request('late'), /接続/);
});

test('initialization completes before initialized and enables collaboration mode fields', async () => {
  const h = harness(); const client = new AppServerClient();
  const connecting = client.connect(h.peer);
  const initialize = h.messages[0]!;
  assert.equal(initialize.method, 'initialize'); assert.deepEqual(object(initialize.params).capabilities, { experimentalApi: true });
  assert.equal(h.messages.length, 1);
  h.send({ id: initialize.id, result: { userAgent: 'fake', future: true } });
  await connecting;
  assert.equal(h.messages[1]!.method, 'initialized'); assert.equal(client.connected, true);
  h.peer.close(); assert.equal(client.connected, false); client.detach();
});

test('stream errors expose retry state, turn identity and upstream details before completion', async () => {
  const h = harness(); const client = new AppServerClient();
  const events: import('../src/core/types').ServerEvent[] = [];
  const connecting = client.connect(h.peer); h.send({ id: h.messages[0]!.id, result: {} }); await connecting;
  client.events.subscribe(event => events.push(event));
  const error = { message: 'Reconnecting... 1/5', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } }, additionalDetails: 'stream disconnected before completion; request ID fixture-request' };
  try {
    h.send({ method: 'error', params: { threadId: 'one', turnId: 'turn', willRetry: true, error } });
    assert.deepEqual(events, [{ type: 'error', threadId: 'one', turnId: 'turn', willRetry: true,
      error: { message: `${error.message}\n${error.additionalDetails}`, kind: 'responseStreamDisconnected' } }]);
    const fatal = { ...error, message: 'Retries exhausted', codexErrorInfo: 'other' };
    h.send({ method: 'error', params: { threadId: 'one', turnId: 'turn', willRetry: false, error: fatal } });
    h.send({ method: 'turn/completed', params: { threadId: 'one', turn: { id: 'turn', status: 'failed', error: fatal, items: [] } } });
    assert.deepEqual(events[1], { type: 'error', threadId: 'one', turnId: 'turn', willRetry: false,
      error: { message: `${fatal.message}\n${fatal.additionalDetails}`, kind: 'other' } });
    const finished = events[2];
    assert.ok(finished?.type === 'turn');
    assert.equal(finished.turn.error?.message, `${fatal.message}\n${fatal.additionalDetails}`);
    assert.equal(finished.turn.status, 'failed');
  } finally { h.peer.close(); client.detach(); }
});

test('title generation uses the shared connection without exposing its turns or errors as task events', async () => {
  const h = harness(); const client = new AppServerClient();
  const server = new JsonRpcPeer(h.output, h.input);
  const events: import('../src/core/types').ServerEvent[] = [];
  client.events.subscribe(event => events.push(event));
  server.handleRequest = async ({ method }) => {
    if (method === 'model/list') return { data: [{ model: 'title-model', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' }], nextCursor: null };
    if (method === 'thread/start') return { thread: { id: 'title-thread' } };
    if (method === 'turn/start') return { turn: { id: 'title-turn', status: 'inProgress' } };
    return {};
  };
  try {
    await client.connect(h.peer);
    const generated = client.generateTitle({ cwd: '/project', input: '{"request":"Fix login"}', model: 'title-model', effort: 'lowest' }, new AbortController().signal);
    await h.tick();
    server.notify('turn/started', { threadId: 'title-thread', turn: { id: 'title-turn', status: 'inProgress' } });
    server.notify('item/agentMessage/delta', { threadId: 'title-thread', itemId: 'title-answer', delta: '{"title":"Fix login"}' });
    server.notify('warning', { threadId: 'title-thread', message: 'Internal title warning' });
    server.notify('error', { threadId: 'title-thread', turnId: 'title-turn', willRetry: true, error: { message: 'Internal title retry' } });
    server.notify('turn/started', { threadId: 'real-task', turn: { id: 'real-turn', status: 'inProgress' } });
    server.notify('turn/completed', { threadId: 'title-thread', turn: { id: 'title-turn', status: 'completed', items: [] } });
    assert.equal(await generated, 'Fix login');
    assert.equal(events.filter(event => 'threadId' in event && event.threadId === 'title-thread').length, 0);
    assert.ok(events.some(event => event.type === 'turn' && event.threadId === 'real-task'));
  } finally { client.detach(); h.peer.close(); server.close(); }
});

test('approval choices are scoped, explicit, validated and sent to the matching server request', async () => {
  const h = harness(); const client = new AppServerClient();
  const connecting = client.connect(h.peer); h.send({ id: h.messages[0]!.id, result: {} }); await connecting;
  const requests: string[] = [];
  client.events.subscribe(event => { if (event.type === 'request') requests.push(event.request.id); });
  h.send({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'one', turnId: 'turn', command: 'npm test', availableDecisions: ['decline', 'accept'] } });
  h.send({ id: '7', method: 'item/fileChange/requestApproval', params: { threadId: 'two', turnId: 'turn', reason: 'edit' } });
  await h.tick();
  assert.deepEqual(requests, ['number:7', 'string:7']);
  assert.throws(() => client.answerRequest('number:7', 'two', { choice: 1 }));
  assert.throws(() => client.answerRequest('number:7', 'one', { choice: 8 }));
  client.answerRequest('number:7', 'one', { choice: 1 });
  client.answerRequest('string:7', 'two', { choice: 2 });
  await h.tick();
  assert.deepEqual(h.messages.find(value => value.id === 7)?.result, { decision: 'accept' });
  assert.deepEqual(h.messages.find(value => value.id === '7')?.result, { decision: 'decline' });
  h.peer.close(); client.detach();
});

test('tool questions validate all answers, preserve nonblocking input, and allow explicit skip', async () => {
  const h = harness(); const client = new AppServerClient();
  const connecting = client.connect(h.peer); h.send({ id: h.messages[0]!.id, result: {} }); await connecting;
  const requests: import('../src/core/types').PendingRequest[] = [];
  client.events.subscribe(event => { if (event.type === 'request') requests.push(event.request); });
  try {
    const params = { threadId: 'one', turnId: 'turn', itemId: 'tool', isBlocking: false, autoResolutionMs: null, questions: [
      { id: 'direction', header: '方針', question: 'AかB？', isSecret: false, isOther: true, options: [{ label: 'A', description: '案A' }, { label: 'B', description: '案B' }] },
      { id: 'detail', header: '補足', question: '補足は？', isSecret: true, isOther: false, options: null },
    ] };
    h.send({ id: 11, method: 'item/tool/requestUserInput', params }); await h.tick();
    assert.equal(requests[0]?.blocking, false);
    assert.equal(requests[0]?.questions?.[1]?.secret, true);
    assert.deepEqual(requests[0]?.questions?.[1]?.options, []);
    assert.throws(() => client.answerRequest('number:11', 'two', { skip: true }));
    assert.throws(() => client.answerRequest('number:11', 'one', { answers: { direction: ['A'] } }), /すべての質問/);
    client.answerRequest('number:11', 'one', { answers: { direction: ['B'], detail: ['補足の回答'] } }); await h.tick();
    assert.deepEqual(h.messages.find(message => message.id === 11)?.result, { answers: { direction: { answers: ['B'] }, detail: { answers: ['補足の回答'] } } });
    h.send({ id: 'skip', method: 'item/tool/requestUserInput', params }); await h.tick();
    client.answerRequest('string:skip', 'one', { skip: true }); await h.tick();
    assert.deepEqual(h.messages.find(message => message.id === 'skip')?.result, { answers: {} });
    h.send({ id: 'expired', method: 'item/tool/requestUserInput', params }); await h.tick();
    h.send({ method: 'serverRequest/resolved', params: { threadId: 'one', requestId: 'expired' } }); await h.tick();
    assert.throws(() => client.answerRequest('string:expired', 'one', { skip: true }), /解決済み/);
  } finally { h.peer.close(); client.detach(); }
});

test('models and reasoning options are obtained across pages without fixed names', async () => {
  const h = harness(); const client = new AppServerClient();
  const connecting = client.connect(h.peer); h.send({ id: h.messages[0]!.id, result: {} }); await connecting;
  const listing = client.listModels();
  h.send({ id: h.messages.at(-1)!.id, result: { data: [{ model: 'future-model', displayName: 'Future', supportedReasoningEfforts: [{ reasoningEffort: 'new-effort', description: 'new' }], upgrade: 'another-new-model', isDefault: true, extra: 123 }], nextCursor: 'page2' } });
  await h.tick();
  assert.equal(object(h.messages.at(-1)!.params).cursor, 'page2');
  h.send({ id: h.messages.at(-1)!.id, result: { data: [{ model: 'another-new-model', supportedReasoningEfforts: [] }], nextCursor: null } });
  const models = await listing;
  assert.equal(models.length, 2); assert.equal(models[0]?.efforts[0]?.id, 'new-effort');
  assert.equal(models[0]?.isDefault, true); assert.equal(models[0]?.upgrade, 'another-new-model');
  h.peer.close(); client.detach();
});

test('first sends share the background model request and reuse the loaded catalog across tasks', async () => {
  const h = harness(); const client = new AppServerClient();
  const server = new JsonRpcPeer(h.output, h.input);
  const manager = new TaskManager(client, { async save() {} }, [], { schedule: false });
  const catalog = deferred<unknown>();
  let threadCount = 0;
  server.handleRequest = async ({ method, params }) => {
    if (method === 'initialize') return {};
    if (method === 'model/list') return catalog.promise;
    if (method === 'thread/start') return { thread: { id: `thread-${++threadCount}`, cwd: '/project', turns: [] } };
    if (method === 'turn/start') return { turn: { id: `turn-${threadCount}`, status: 'completed', items: [
      { id: `user-${threadCount}`, type: 'userMessage', clientId: object(params).clientUserMessageId, content: object(params).input },
    ] } };
    throw new Error(`Unexpected request: ${method}`);
  };
  try {
    await client.connect(h.peer);
    const background = client.listModels();
    const first = manager.create('/project', DEFAULT_PRESET);
    const sending = manager.send(first.id, 'first', [], { clientId: 'webview-first-send' });
    await h.tick();
    assert.equal(h.messages.filter(message => message.method === 'model/list').length, 1);
    assert.equal(threadCount, 0);
    catalog.resolve({ data: [{ model: 'shared-model', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' }], nextCursor: null });
    await Promise.all([background, sending]);
    assert.equal(first.turns[0]?.items[0]?.data.clientId, 'webview-first-send');
    await manager.send(manager.create('/project', DEFAULT_PRESET).id, 'second');
    assert.equal(threadCount, 2);
    assert.equal(h.messages.filter(message => message.method === 'model/list').length, 1, 'sending must not refetch the displayed catalog');
    assert.ok(h.messages.filter(message => message.method === 'turn/start').every(message => object(message.params).model === 'shared-model'));
  } finally { manager.dispose(); server.close(); h.peer.close(); client.detach(); }
});

test('model refresh supersedes an older in-flight request and account changes invalidate the cache', async () => {
  const h = harness(); const client = new AppServerClient();
  const connecting = client.connect(h.peer); h.send({ id: h.messages[0]!.id, result: {} }); await connecting;
  const result = (model: string) => ({ data: [{ model, supportedReasoningEfforts: [] }], nextCursor: null });
  try {
    const old = client.listModels(); const oldId = h.messages.at(-1)!.id;
    const refreshed = client.listModels(true); const newId = h.messages.at(-1)!.id;
    const concurrent = client.listModels();
    assert.notEqual(oldId, newId);
    h.send({ id: newId, result: result('new') });
    assert.equal((await refreshed)[0]?.id, 'new');
    h.send({ id: oldId, result: result('old') });
    assert.equal((await old)[0]?.id, 'new');
    assert.equal((await concurrent)[0]?.id, 'new');
    assert.equal((await client.listModels())[0]?.id, 'new');
    assert.equal(h.messages.filter(message => message.method === 'model/list').length, 2);
    for (const notification of ['account/updated', 'account/login/completed']) {
      h.send({ method: notification, params: { success: true } });
      const listing = client.listModels();
      h.send({ id: h.messages.at(-1)!.id, result: result(notification) });
      assert.equal((await listing)[0]?.id, notification);
    }
    assert.equal(h.messages.filter(message => message.method === 'model/list').length, 4);
  } finally { h.peer.close(); client.detach(); }
});

test('failed model loads can retry, empty catalogs are cached, and reconnects discard the cache', async () => {
  const h = harness(); const next = harness(); const client = new AppServerClient();
  const connecting = client.connect(h.peer); h.send({ id: h.messages[0]!.id, result: {} }); await connecting;
  try {
    const failed = client.listModels();
    h.send({ id: h.messages.at(-1)!.id, error: { code: -1, message: 'temporary error' } });
    await assert.rejects(failed, /temporary error/);
    const retry = client.listModels();
    h.send({ id: h.messages.at(-1)!.id, result: { data: [], nextCursor: null } });
    assert.deepEqual(await retry, []);
    assert.deepEqual(await client.listModels(), []);
    assert.equal(h.messages.filter(message => message.method === 'model/list').length, 2);
    h.peer.close();
    await assert.rejects(client.listModels(), /接続/);
    const reconnecting = client.connect(next.peer); next.send({ id: next.messages[0]!.id, result: {} }); await reconnecting;
    const listing = client.listModels();
    next.send({ id: next.messages.at(-1)!.id, result: { data: [{ model: 'reconnected' }], nextCursor: null } });
    assert.equal((await listing)[0]?.id, 'reconnected');
    assert.equal(next.messages.filter(message => message.method === 'model/list').length, 1);
  } finally { h.peer.close(); next.peer.close(); client.detach(); }
});

test('history pages use the state database and preserve cursors and archived filtering', async () => {
  const h = harness(); const client = new AppServerClient();
  const connecting = client.connect(h.peer); h.send({ id: h.messages[0]!.id, result: {} }); await connecting;
  try {
    const listing = client.listThreads();
    assert.equal(h.messages.at(-1)!.method, 'thread/list');
    assert.deepEqual(h.messages.at(-1)!.params, { limit: 50, archived: false, useStateDbOnly: true });
    h.send({ id: h.messages.at(-1)!.id, result: { data: [{ id: 'recent', name: 'Recent chat', cwd: '/project', updatedAt: 123 }], nextCursor: 'next-page' } });
    const page = await listing;
    assert.equal(page.threads[0]?.title, 'Recent chat');
    assert.equal(page.threads[0]?.cwd, '/project');
    assert.equal(page.cursor, 'next-page');

    const archived = client.listThreads(page.cursor, true);
    assert.deepEqual(h.messages.at(-1)!.params, { limit: 50, archived: true, useStateDbOnly: true, cursor: 'next-page' });
    h.send({ id: h.messages.at(-1)!.id, result: { data: [], nextCursor: null } });
    assert.deepEqual(await archived, { threads: [], cursor: undefined });
  } finally { h.peer.close(); client.detach(); }
});

test('permanent deletion sends the thread ID and handles deletion notifications', async () => {
  const h = harness(); const client = new AppServerClient();
  const connecting = client.connect(h.peer); h.send({ id: h.messages[0]!.id, result: {} }); await connecting;
  try {
    const events: unknown[] = [];
    client.events.subscribe(event => events.push(event));
    const deleting = client.deleteThread('root');
    assert.equal(h.messages.at(-1)!.method, 'thread/delete');
    assert.deepEqual(h.messages.at(-1)!.params, { threadId: 'root' });
    h.send({ id: h.messages.at(-1)!.id, result: {} }); await deleting;
    h.send({ method: 'thread/deleted', params: { threadId: 'root' } });
    h.send({ method: 'thread/archived', params: { threadId: 'other' } });
    assert.deepEqual(events, [{ type: 'deleted', threadId: 'root' }, { type: 'archived', threadId: 'other' }]);
  } finally { client.detach(); h.peer.close(); }
});

test('a new paginated thread sends the first user message before requesting stored history', async () => {
  const h = harness(); const client = new AppServerClient();
  const server = new JsonRpcPeer(h.output, h.input);
  const manager = new TaskManager(client, { async save() {} }, [], { schedule: false });
  let turnCount = 0;
  server.handleRequest = async ({ method, params }) => {
    if (method === 'initialize') return {};
    if (method === 'model/list') return {
      data: [{ model: 'test-model', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' }], nextCursor: null,
    };
    if (method === 'thread/start') {
      assert.deepEqual(params, { cwd: '/project', model: 'test-model', config: { model_reasoning_effort: 'high' }, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' });
      return {
        thread: { id: 'new-thread', cwd: '/project', status: { type: 'idle' }, historyMode: 'paginated', turns: [] },
        model: 'test-model', reasoningEffort: 'high', instructionSources: ['/project/AGENTS.md'],
        sandbox: { type: 'workspaceWrite' }, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review',
      };
    }
    if (method === 'turn/start') {
      assert.equal(object(params).threadId, 'new-thread');
      assert.equal(object(params).model, 'test-model'); assert.equal(object(params).effort, 'high');
      assert.equal(object(params).approvalsReviewer, 'auto_review');
      return { turn: { id: `turn-${++turnCount}`, status: 'completed', items: [{ id: `user-${turnCount}`, type: 'userMessage', content: object(params).input }] } };
    }
    if (method === 'thread/turns/list') throw new RpcError(-32600, 'thread new-thread is not materialized yet; thread/turns/list is unavailable before first user message');
    throw new RpcError(-32601, `Unexpected request: ${method}`);
  };
  try {
    await client.connect(h.peer);
    const task = manager.create('/project', DEFAULT_PRESET);
    await manager.send(task.id, 'test');
    assert.equal(task.threadId, 'new-thread');
    assert.equal(task.title, 'test');
    assert.equal(task.status, 'idle');
    assert.equal(task.error, undefined);
    assert.equal(task.hydrated, true);
    assert.equal(task.effectiveModel, 'test-model');
    assert.equal(task.effectiveEffort, 'high');
    assert.equal(task.effectivePermissionMode, 'auto-review');
    assert.deepEqual(task.instructionSources, ['/project/AGENTS.md']);
    assert.deepEqual(task.turns[0]?.items[0]?.data.content, [{ type: 'text', text: 'test', text_elements: [] }]);
    await manager.send(task.id, 'follow-up');
    assert.equal(task.turns.length, 2);
    assert.deepEqual(h.messages.map(message => message.method), ['initialize', 'initialized', 'model/list', 'thread/start', 'turn/start', 'turn/start']);
  } finally { manager.dispose(); await manager.flush(); client.detach(); h.peer.close(); server.close(); }
});

test('message forks request history through the selected turn while ordinary forks keep all history', async () => {
  const h = harness(); const client = new AppServerClient();
  const server = new JsonRpcPeer(h.output, h.input);
  server.handleRequest = async ({ method, params }) => {
    if (method === 'initialize') return {};
    if (method === 'thread/read') return { thread: { id: 'source' } };
    assert.equal(method, 'thread/fork');
    assert.equal(object(params).threadId, 'source');
    const lastTurnId = object(params).lastTurnId;
    assert.deepEqual(params, { threadId: 'source', ...(lastTurnId ? { lastTurnId: 'earlier' } : {}) });
    return { thread: { id: 'forked', status: { type: 'idle' }, turns: (lastTurnId ? ['earlier'] : ['earlier', 'later']).map(id => ({ id, status: 'completed', items: [] })) } };
  };
  try {
    await client.connect(h.peer);
    const forked = await client.forkThread('source', { lastTurnId: 'earlier' });
    assert.equal(forked.id, 'forked');
    assert.deepEqual(forked.turns.map(turn => turn.id), ['earlier']);
    assert.deepEqual((await client.forkThread('source')).turns.map(turn => turn.id), ['earlier', 'later']);
  } finally { client.detach(); h.peer.close(); server.close(); }
});

for (const method of ['resumeThread', 'readThread', 'forkThread'] as const) {
  test(`${method} loads all pages of an existing thread even when its inline turns are empty`, async () => {
    const h = harness(); const client = new AppServerClient();
    const server = new JsonRpcPeer(h.output, h.input);
    server.handleRequest = async ({ method: request, params }) => {
      if (request === 'initialize') return {};
      if (request === 'thread/turns/list') {
        const cursor = object(params).cursor;
        assert.deepEqual(params, { threadId: 'stored-thread', sortDirection: 'asc', itemsView: 'full', limit: 100, ...(cursor ? { cursor: 'next-page' } : {}) });
        const id = cursor ? 'newer-turn' : 'older-turn';
        return { data: [{ id, status: 'completed', items: [{ id: `${id}-agent`, type: 'agentMessage', text: id }] }], nextCursor: cursor ? null : 'next-page' };
      }
      return { thread: { id: 'stored-thread', status: { type: 'idle' }, historyMode: 'paginated', turns: [] } };
    };
    try {
      await client.connect(h.peer);
      const thread = await client[method]('stored-thread');
      assert.deepEqual(thread.turns.map(turn => turn.id), ['older-turn', 'newer-turn']);
      assert.deepEqual(thread.turns.map(turn => turn.items[0]?.data.text), ['older-turn', 'newer-turn']);
      assert.equal(h.messages.filter(message => message.method === 'thread/turns/list').length, 2);
    } finally { client.detach(); h.peer.close(); server.close(); }
  });
}

test('new thread fields and item kinds are tolerated; usage errors use structured codes', () => {
  const thread = decodeThread({ id: 'one', status: { type: 'idle', new: true }, arbitraryField: true, turns: [{ id: 'turn', status: 'failed', error: { message: 'Any localized message', codexErrorInfo: 'usageLimitExceeded', future: true }, items: [{ id: 'new', type: 'futureItem', futureField: true }] }] });
  assert.equal(thread.turns[0]?.error?.kind, 'usageLimitExceeded');
  assert.equal(thread.turns[0]?.items[0]?.kind, 'futureItem');
});

test('turn history retains server timing in milliseconds and reply phases without inventing missing durations', () => {
  const thread = decodeThread({ id: 'timed', turns: [
    { id: 'known', status: 'completed', startedAt: 1000, completedAt: 1712, durationMs: 712345, items: [{ id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'Done' }] },
    { id: 'unknown', status: 'completed', startedAt: null, completedAt: null, durationMs: null },
    { id: 'invalid', status: 'completed', startedAt: '1000', completedAt: Infinity, durationMs: -1 },
  ] });
  const known = thread.turns[0]!;
  assert.equal(known.startedAt, 1_000_000);
  assert.equal(known.completedAt, 1_712_000);
  assert.equal(known.durationMs, 712345);
  assert.equal(known.items[0]?.data.phase, 'final_answer');
  for (const turn of thread.turns.slice(1)) {
    assert.equal(turn.startedAt, undefined);
    assert.equal(turn.completedAt, undefined);
    assert.equal(turn.durationMs, undefined);
  }
});

test('explicit skill input carries the documented text mention and preserves dynamic model settings', async () => {
  const h = harness(); const client = new AppServerClient();
  const connecting = client.connect(h.peer); h.send({ id: h.messages[0]!.id, result: {} }); await connecting;
  const sending = client.startTurn('thread', [{ type: 'text', text: 'Use this skill' }, { type: 'skill', name: 'sample', path: '/skills/sample/SKILL.md' }], { mode: 'default', model: 'new-model', effort: 'new-effort' }, 'client-id');
  const params = object(h.messages.at(-1)!.params);
  assert.equal(params.model, 'new-model'); assert.equal(params.effort, 'new-effort');
  assert.equal(params.sandboxPolicy, undefined);
  assert.deepEqual(params.input, [{ type: 'text', text: 'Use this skill', text_elements: [] }, { type: 'skill', name: 'sample', path: '/skills/sample/SKILL.md' }, { type: 'text', text: '$sample', text_elements: [] }]);
  h.send({ id: h.messages.at(-1)!.id, result: { turn: { id: 'turn', status: 'inProgress', items: [] } } });
  await sending; h.peer.close(); client.detach();
});

test('clipboard image data reaches both turn/start and turn/steer unchanged', async () => {
  const h = harness(); const client = new AppServerClient();
  const connecting = client.connect(h.peer); h.send({ id: h.messages[0]!.id, result: {} }); await connecting;
  const input = [{ type: 'image' as const, url: 'data:image/png;base64,YQ==' }];
  const starting = client.startTurn('thread', input, { mode: 'default' }, 'image-message');
  assert.equal(h.messages.at(-1)?.method, 'turn/start');
  assert.deepEqual(object(h.messages.at(-1)!.params).input, input);
  h.send({ id: h.messages.at(-1)!.id, result: { turn: { id: 'turn', status: 'inProgress', items: [] } } });
  await starting;
  const steering = client.steerTurn('thread', 'turn', input);
  assert.equal(h.messages.at(-1)?.method, 'turn/steer');
  assert.deepEqual(object(h.messages.at(-1)!.params).input, input);
  h.send({ id: h.messages.at(-1)!.id, result: {} });
  await steering; h.peer.close(); client.detach();
});

test('plan and default modes use built-in instructions and preserve the resumed model, effort, and permissions', async () => {
  const h = harness(); const client = new AppServerClient();
  const server = new JsonRpcPeer(h.output, h.input);
  server.handleRequest = async ({ method }) => {
    if (method === 'thread/read') return { thread: { id: 'thread', modelProvider: 'openai' } };
    if (method === 'thread/resume') return { thread: { id: 'thread', turns: [] }, model: 'session-model', reasoningEffort: 'high' };
    if (method === 'turn/start') return { turn: { id: 'turn', status: 'completed', items: [] } };
    return {};
  };
  try {
    await client.connect(h.peer);
    await client.resumeThread('thread');
    for (const collaborationMode of ['plan', 'default'] as const) {
      await client.startTurn('thread', [{ type: 'text', text: 'Continue' }], { mode: 'auto-review', collaborationMode }, 'message');
      const params = object(h.messages.at(-1)!.params);
      assert.deepEqual(params.collaborationMode, { mode: collaborationMode, settings: {
        model: 'session-model', reasoning_effort: 'high', developer_instructions: null,
      } });
      assert.equal(params.clientUserMessageId, 'message');
      assert.equal(params.approvalsReviewer, 'auto_review');
      assert.equal(params.approvalPolicy, 'on-request');
      assert.equal(object(params.sandboxPolicy).type, 'workspaceWrite');
    }
    await client.startTurn('thread', [], { mode: 'default', model: 'changed-model', effort: 'low', collaborationMode: 'plan' }, 'changed');
    await client.startTurn('thread', [], { mode: 'default', collaborationMode: 'default' }, 'inherited');
    const params = object(h.messages.at(-1)!.params);
    assert.deepEqual(params.collaborationMode, { mode: 'default', settings: { model: 'changed-model', reasoning_effort: 'low', developer_instructions: null } });
    assert.equal(params.sandboxPolicy, undefined);
  } finally { client.detach(); h.peer.close(); server.close(); }
});

test('plan mode uses external provider model IDs without inheriting Codex reasoning effort', async () => {
  const h = harness(); const client = new AppServerClient();
  const server = new JsonRpcPeer(h.output, h.input);
  server.handleRequest = async ({ method }) => method === 'turn/start' ? { turn: { id: 'turn', status: 'completed', items: [] } } : {};
  try {
    await client.connect(h.peer);
    await client.startTurn('hf', [], { mode: 'read-only', model: 'hf:org/model:provider', effort: 'default', collaborationMode: 'plan' }, 'hf');
    assert.deepEqual(object(h.messages.at(-1)!.params).collaborationMode, {
      mode: 'plan', settings: { model: 'org/model:provider', reasoning_effort: null, developer_instructions: null },
    });
  } finally { client.detach(); h.peer.close(); server.close(); }
});

test('registered skills exclude disabled entries and keep distinct paths with the same name; changes invalidate the catalog', async () => {
  const h = harness(); const client = new AppServerClient();
  const connecting = client.connect(h.peer); h.send({ id: h.messages[0]!.id, result: {} }); await connecting;
  try {
    const listing = client.listSkills('/workspace');
    assert.deepEqual(h.messages.at(-1)!.params, { cwds: ['/workspace'], forceReload: false });
    h.send({ id: h.messages.at(-1)!.id, result: { data: [{ cwd: '/workspace', skills: [
      { name: 'sample', path: '/one/SKILL.md', description: 'long', interface: { shortDescription: 'Short' }, scope: 'system', enabled: true },
      { name: 'sample', path: '/two/SKILL.md', description: 'other', scope: 'user', enabled: true },
      { name: 'duplicate', path: '/one/SKILL.md', enabled: true },
      { name: 'disabled', path: '/disabled/SKILL.md', enabled: false },
    ] }] } });
    assert.deepEqual(await listing, [{ name: 'sample', path: '/one/SKILL.md', description: 'Short', scope: 'system' }, { name: 'sample', path: '/two/SKILL.md', description: 'other', scope: 'user' }]);
    let changed = false; client.events.subscribe(event => { if (event.type === 'skills') changed = true; });
    h.send({ method: 'skills/changed' }); await h.tick(); assert.equal(changed, true);
    const search = client.searchFiles('/workspace', 'new file');
    assert.equal(h.messages.at(-1)!.method, 'fuzzyFileSearch');
    assert.deepEqual(h.messages.at(-1)!.params, { roots: ['/workspace'], query: 'new file', cancellationToken: null });
    h.send({ id: h.messages.at(-1)!.id, result: { files: [{ path: 'new file.ts', match_type: 'file' }, { path: 'new folder', match_type: 'directory' }] } });
    assert.deepEqual(await search, [{ path: 'new file.ts', kind: 'file' }, { path: 'new folder', kind: 'directory' }]);
  } finally { h.peer.close(); client.detach(); }
});

test('permission presets route approvals correctly and inherited settings omit overrides', async () => {
  const h = harness(); const client = new AppServerClient();
  const connecting = client.connect(h.peer); h.send({ id: h.messages[0]!.id, result: {} }); await connecting;
  try {
    for (const mode of ['auto-review', 'workspace-write', 'danger-full-access', 'default'] as const) {
      const sending = client.startTurn('thread', [{ type: 'text', text: '$sample を使用' }, { type: 'skill', name: 'sample', path: '/skills/SKILL.md' }], { mode }, 'id');
      const params = object(h.messages.at(-1)!.params);
      assert.equal(params.approvalsReviewer, mode === 'default' ? undefined : mode === 'auto-review' ? 'auto_review' : 'user');
      assert.equal(params.approvalPolicy, mode === 'default' ? undefined : mode === 'danger-full-access' ? 'never' : 'on-request');
      assert.equal(object(params.sandboxPolicy).type, mode === 'default' ? undefined : mode === 'danger-full-access' ? 'dangerFullAccess' : 'workspaceWrite');
      assert.equal((params.input as unknown[]).length, 2, 'do not append a second mention when the user already typed it');
      h.send({ id: h.messages.at(-1)!.id, result: { turn: { id: 'turn', status: 'inProgress', items: [] } } }); await sending;
    }
  } finally { h.peer.close(); client.detach(); }
});
