import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskManager, CONTINUE_MESSAGE, readTaskRecords, type TaskStore } from '../src/core/taskManager';
import type { TaskRecord, Thread, Turn } from '../src/core/types';
import { FakeGateway, deferred, thread, usage } from './helpers';

function setup(store?: TaskStore, records?: TaskRecord[]) {
  const gateway = new FakeGateway();
  const saved: TaskRecord[][] = [];
  const manager = new TaskManager(gateway, store ?? { async save(records) { saved.push(structuredClone(records)); } }, records, { schedule: false, now: () => 1000 });
  const value = thread(); gateway.threads.set(value.id, value);
  const task = records?.length ? manager.get(records[0]!.id) : manager.adoptThread(value);
  return { gateway, manager, task, saved };
}
function waitForUsage(state: ReturnType<typeof setup>, turnId = 'stopped') {
  state.manager.setAutoResume(state.task.id, true);
  state.gateway.finish(state.task.threadId!, turnId);
}

test('new tasks are listed immediately and stay listed after completion; closing never interrupts', async () => {
  const { manager, gateway } = setup();
  const task = manager.create('/project');
  assert.equal(task.threadId, undefined);
  assert.ok(manager.openTasks.includes(task));
  await manager.send(task.id, 'hello');
  const id = task.activeTurnId!;
  manager.close(task.id);
  assert.ok(!manager.openTasks.includes(task));
  assert.deepEqual(gateway.interrupted, []);
  gateway.finish(task.threadId!, id, 'completed');
  const reopened = manager.openThread(task.threadId!);
  assert.equal(reopened, task);
  assert.equal(reopened.status, 'idle');
  assert.ok(manager.openTasks.includes(task));
});

test('only completed answers become unread and acknowledgements are scoped to the task and turn', async () => {
  const { manager, gateway, task, saved } = setup();
  const other = manager.adoptThread(thread('other'));
  await manager.send(task.id, 'hello');
  const turnId = task.activeTurnId!;
  gateway.events.emit({ type: 'item', threadId: task.threadId!, turnId, item: { id: 'answer', kind: 'agentMessage', data: { text: 'done' } }, completed: true });
  assert.equal(task.unreadTurnId, undefined, 'an item completion is not a turn completion');
  gateway.finish(task.threadId!, turnId, 'completed');
  assert.equal(task.unreadTurnId, turnId);
  assert.equal(other.unreadTurnId, undefined);
  manager.open(task.id);
  manager.markRead(other.id, turnId);
  manager.markRead(task.id, 'stale-turn');
  assert.equal(task.unreadTurnId, turnId, 'opening alone or acknowledging another answer must not mark this answer read');
  await manager.flush();
  assert.equal(saved.at(-1)?.find(record => record.id === task.id)?.unreadTurnId, turnId);
  manager.markRead(task.id, turnId);
  gateway.finish(task.threadId!, turnId, 'completed');
  assert.equal(task.unreadTurnId, undefined, 'duplicate completion notifications must not make a read answer unread again');
  await manager.flush();
  assert.equal(saved.at(-1)?.find(record => record.id === task.id)?.unreadTurnId, undefined);
  gateway.finish(task.threadId!, 'next', 'completed');
  manager.markRead(task.id, turnId);
  assert.equal(task.unreadTurnId, 'next', 'a delayed acknowledgement must not clear a newer answer');
  await manager.send(task.id, 'follow up');
  assert.equal(task.unreadTurnId, undefined, 'starting another turn removes the completion badge');
  manager.dispose();
});

test('interrupted, failed, and usage-limited turns do not become unread', () => {
  const { manager, gateway, task } = setup();
  for (const [status, kind] of [['interrupted', ''], ['failed', 'serverError'], ['failed', 'usageLimitExceeded']]) {
    gateway.finish(task.threadId!, `${status}-${kind}`, status, kind);
    assert.equal(task.unreadTurnId, undefined);
  }
  manager.dispose();
});

test('unread and read answers retain their state when stored tasks are restored', async () => {
  const original = setup();
  original.gateway.finish(original.task.threadId!, 'answer', 'completed');
  for (const read of [false, true]) {
    if (read) original.manager.markRead(original.task.id, 'answer');
    const records = readTaskRecords(JSON.parse(JSON.stringify({ version: 1, tasks: original.manager.records() })));
    const restored = setup(undefined, records);
    restored.gateway.threads.set(original.task.threadId!, structuredClone(original.gateway.threads.get(original.task.threadId!)!));
    assert.equal(restored.task.unreadTurnId, read ? undefined : 'answer');
    await restored.manager.restore(restored.task.id);
    assert.equal(restored.task.unreadTurnId, read ? undefined : 'answer');
    restored.manager.dispose();
  }
  original.manager.dispose();
});

test('restoring detects newly completed work without marking old history unread', async () => {
  const original = setup();
  await original.manager.send(original.task.id, 'hello');
  const turnId = original.task.activeTurnId!;
  const records = original.manager.records();
  original.manager.dispose();
  original.gateway.finish(original.task.threadId!, turnId, 'completed');
  const snapshot = original.gateway.threads.get(original.task.threadId!)!;
  const restored = setup(undefined, records);
  restored.gateway.threads.set(snapshot.id, structuredClone(snapshot));
  await restored.manager.restore(restored.task.id);
  assert.equal(restored.task.unreadTurnId, turnId);
  const historical = restored.manager.adoptThread({ ...structuredClone(snapshot), id: 'history' });
  assert.equal(historical.unreadTurnId, undefined);
  restored.manager.dispose();
});

test('clipboard images support image-only new turns, removal and follow-up input', async () => {
  const { manager, gateway } = setup();
  const task = manager.create('/project');
  const input = { type: 'image' as const, url: 'data:image/png;base64,YQ==' };
  manager.attach(task.id, { id: 'image', label: '貼り付けた画像', input });
  manager.attach(task.id, { id: 'removed', label: '削除する画像', input });
  manager.removeAttachment(task.id, 'removed');
  await manager.send(task.id, '');
  assert.deepEqual(gateway.sent[0]?.input, [input]);
  assert.deepEqual(task.attachments, []);
  manager.attach(task.id, { id: 'follow-up', label: '貼り付けた画像', input });
  await manager.send(task.id, 'この画像も確認してください。');
  assert.deepEqual(gateway.steered[0]?.input, [{ type: 'text', text: 'この画像も確認してください。' }, input]);
  assert.deepEqual(task.attachments, []);
  manager.dispose();
});

test('sending a captured attachment selection leaves later attachments for the next draft', async () => {
  const { manager, gateway } = setup();
  const task = manager.create('/project');
  const first = { id: 'first', label: 'first', input: { type: 'image' as const, url: 'data:image/png;base64,YQ==' } };
  const next = { id: 'next', label: 'next', input: { type: 'image' as const, url: 'data:image/png;base64,Yg==' } };
  manager.attach(task.id, first); manager.attach(task.id, next);
  gateway.turnStarter = async () => { throw new Error('send failed'); };
  await assert.rejects(manager.send(task.id, 'first', [], { clientId: 'first-send', attachmentIds: [first.id] }), /send failed/);
  assert.deepEqual(task.attachments, [first, next]);
  gateway.turnStarter = undefined;
  await manager.send(task.id, 'retry', [], { clientId: 'retry-send', attachmentIds: [first.id] });
  assert.equal(gateway.sent.at(-1)?.clientId, 'retry-send');
  assert.deepEqual(gateway.sent.at(-1)?.input, [{ type: 'text', text: 'retry' }, first.input]);
  assert.deepEqual(task.attachments, [next]);
  await manager.send(task.id, 'text only', [], { attachmentIds: [] });
  assert.deepEqual(gateway.steered.at(-1)?.input, [{ type: 'text', text: 'text only' }]);
  assert.deepEqual(task.attachments, [next]);
  await assert.rejects(manager.send(task.id, 'missing', [], { attachmentIds: ['missing'] }), /添付ファイル/);
  manager.dispose();
});

test('failed image sends keep attachments and successful sends keep images pasted during the request', async () => {
  const { manager, gateway, task } = setup();
  const first = { id: 'first', label: '貼り付けた画像', input: { type: 'image' as const, url: 'data:image/png;base64,YQ==' } };
  manager.attach(task.id, first);
  gateway.turnStarter = async () => { throw new Error('send failed'); };
  await assert.rejects(manager.send(task.id, ''), /send failed/);
  assert.deepEqual(task.attachments, [first]);
  const entered = deferred<void>();
  const response = deferred<Turn>();
  gateway.turnStarter = async () => { entered.resolve(); return response.promise; };
  const sending = manager.send(task.id, '');
  await entered.promise;
  const next = { ...first, id: 'next' };
  manager.attach(task.id, next);
  response.resolve({ id: 'image-turn', status: 'inProgress', items: [] });
  await sending;
  assert.deepEqual(gateway.sent.at(-1)?.input, [first.input]);
  assert.deepEqual(task.attachments, [next]);
  manager.dispose();
});

test('parallel task streams and approvals stay scoped by thread ID', async () => {
  const { manager, gateway, task } = setup();
  gateway.threads.set('other', thread('other'));
  const other = manager.adoptThread(thread('other'));
  await Promise.all([manager.send(task.id, 'one'), manager.send(other.id, 'two')]);
  const request = { id: 'number:1', threadId: other.threadId!, turnId: other.activeTurnId, kind: 'approval' as const, title: 'approval', detail: '', choices: ['accept'], blocking: true };
  gateway.events.emit({ type: 'request', request });
  gateway.events.emit({ type: 'delta', threadId: task.threadId!, turnId: task.activeTurnId!, itemId: 'agent', kind: 'agentMessage', field: 'text', text: 'first task only' });
  assert.equal(task.requests.length, 0);
  assert.equal(other.requests.length, 1);
  assert.equal(task.turns.at(-1)!.items.at(-1)!.data.text, 'first task only');
  assert.ok(!other.turns.at(-1)!.items.some(item => item.id === 'agent'));
  assert.throws(() => manager.answer(task.id, request.id, { choice: 0 }));
  manager.answer(other.id, request.id, { choice: 0 });
  assert.equal(gateway.answered[0]?.threadId, 'other');
});

test('turn timing survives completion payloads and late start acknowledgements', () => {
  const { manager, gateway, task } = setup();
  const start: Turn = { id: 'timed', status: 'inProgress', items: [], startedAt: 10_000 };
  gateway.events.emit({ type: 'turn', threadId: task.threadId!, turn: start, completed: false });
  gateway.events.emit({ type: 'turn', threadId: task.threadId!, turn: { id: 'timed', status: 'completed', items: [], completedAt: 72_000 }, completed: true });
  assert.equal(task.turns[0]?.startedAt, 10_000);
  assert.equal(task.turns[0]?.completedAt, 72_000);
  gateway.events.emit({ type: 'turn', threadId: task.threadId!, turn: { id: 'timed', status: 'completed', items: [], durationMs: 61_500 }, completed: true });
  gateway.events.emit({ type: 'turn', threadId: task.threadId!, turn: start, completed: false });
  assert.equal(task.turns[0]?.status, 'completed');
  assert.equal(task.turns[0]?.completedAt, 72_000);
  assert.equal(task.turns[0]?.durationMs, 61_500);
  manager.dispose();
});

test('skill mentions apply only to the submitted input and are not retained as attachments after a failed send', async () => {
  const { manager, gateway, task } = setup();
  const skill = { type: 'skill' as const, name: 'sample', path: '/skills/SKILL.md' };
  gateway.turnStarter = async () => { throw new Error('failure'); };
  await assert.rejects(manager.send(task.id, '$sample を使用', [skill]), /failure/);
  assert.deepEqual(gateway.sent[0]?.input, [{ type: 'text', text: '$sample を使用' }, skill]);
  assert.deepEqual(task.attachments, []);
  gateway.turnStarter = undefined;
  await manager.send(task.id, '通常の入力');
  assert.deepEqual(gateway.sent[1]?.input, [{ type: 'text', text: '通常の入力' }]);
  await manager.send(task.id, '$sample を使用', [skill]);
  assert.deepEqual(gateway.steered[0]?.input, [{ type: 'text', text: '$sample を使用' }, skill]);
  manager.dispose();
});

test('usage recovery continues once in the same conversation, with a persisted automatic marker', async () => {
  const state = setup(); waitForUsage(state);
  assert.equal(state.task.status, 'waiting');
  state.gateway.limits = usage(100);
  await state.manager.checkUsage();
  assert.equal(state.gateway.sent.length, 0);
  state.gateway.limits = usage(5);
  await Promise.all([state.manager.checkUsage(), state.manager.checkUsage()]);
  assert.equal(state.gateway.sent.length, 1);
  assert.equal(state.gateway.sent[0]?.threadId, state.task.threadId);
  assert.deepEqual(state.gateway.sent[0]?.input, [{ type: 'text', text: CONTINUE_MESSAGE }]);
  assert.equal(state.task.claims[0]?.turnId, state.task.activeTurnId);
  assert.ok(state.saved.some(records => records[0]?.claims[0]?.clientId === state.gateway.sent[0]?.clientId && !records[0]?.claims[0]?.turnId));
});

test('a second quota stop creates a new reservation and normal completion does not', async () => {
  const state = setup(); waitForUsage(state);
  await state.manager.checkUsage();
  const secondTurn = state.task.activeTurnId!;
  state.gateway.finish(state.task.threadId!, secondTurn);
  assert.equal(state.task.status, 'waiting');
  await state.manager.checkUsage();
  assert.equal(state.gateway.sent.length, 2);
  state.gateway.finish(state.task.threadId!, state.task.activeTurnId!, 'completed');
  await state.manager.checkUsage();
  assert.equal(state.gateway.sent.length, 2);
  assert.equal(state.task.status, 'idle');
});

test('OFF, normal errors, API throttling, and interruption never auto-continue', async () => {
  for (const kind of ['usageLimitExceeded', 'rateLimitExceeded', 'unauthorized', 'other', 'sessionBudgetExceeded']) {
    const state = setup();
    if (kind !== 'usageLimitExceeded') state.manager.setAutoResume(state.task.id, true);
    state.gateway.finish(state.task.threadId!, 'stopped', 'failed', kind);
    await state.manager.checkUsage();
    assert.equal(state.gateway.sent.length, 0, kind);
  }
  const state = setup(); state.manager.setAutoResume(state.task.id, true);
  state.gateway.finish(state.task.threadId!, 'stopped', 'interrupted');
  await state.manager.checkUsage(); assert.equal(state.gateway.sent.length, 0);
});

test('enabling after a usage stop starts waiting', async () => {
  const state = setup(); state.gateway.finish(state.task.threadId!, 'stopped');
  assert.equal(state.task.status, 'limited');
  state.manager.setAutoResume(state.task.id, true);
  await state.manager.checkUsage(); assert.equal(state.gateway.sent.length, 1);
});

test('OFF, close and stop invalidate an in-flight usage read', async () => {
  for (const action of ['off', 'close', 'stop']) {
    const state = setup(); waitForUsage(state);
    const response = deferred<ReturnType<typeof usage>>(); state.gateway.usageReader = () => response.promise;
    const checking = state.manager.checkUsage();
    if (action === 'off') state.manager.setAutoResume(state.task.id, false);
    else if (action === 'close') state.manager.close(state.task.id);
    else await state.manager.stop(state.task.id);
    response.resolve(usage(1)); await checking;
    assert.equal(state.gateway.sent.length, 0, action);
    assert.equal(state.task.autoResume, false);
    assert.equal(state.task.waiting, undefined);
  }
});

test('manual input wins over a pending automatic continuation', async () => {
  const state = setup(); waitForUsage(state);
  const response = deferred<Thread>(); state.gateway.threadReader = () => response.promise;
  const checking = state.manager.checkUsage();
  await new Promise(resolve => setImmediate(resolve));
  await state.manager.send(state.task.id, 'my new input');
  response.resolve(thread()); await checking;
  assert.equal(state.gateway.sent.length, 1);
  assert.equal(state.gateway.sent[0]?.input[0]?.text, 'my new input');
});

test('manual input while a turn is active uses steer and the expected turn ID', async () => {
  const state = setup(); await state.manager.send(state.task.id, 'start');
  const turnId = state.task.activeTurnId;
  await state.manager.send(state.task.id, 'follow up');
  assert.equal(state.gateway.sent.length, 1);
  assert.equal(state.gateway.steered[0]?.turnId, turnId);
});

test('pending approvals and a newly active server turn prevent continuation', async () => {
  const state = setup(); waitForUsage(state);
  state.gateway.threads.get(state.task.threadId!)!.status = 'active';
  await state.manager.checkUsage();
  assert.equal(state.gateway.sent.length, 0);
  assert.equal(state.task.waiting, undefined);
  assert.equal(state.task.status, 'running');
});

test('duplicate completion and stale starts cannot rerun a claimed stop or regress a newer turn', async () => {
  const state = setup(); waitForUsage(state);
  const stopped = structuredClone(state.task.lastTurn!);
  await state.manager.checkUsage();
  state.gateway.events.emit({ type: 'turn', threadId: state.task.threadId!, turn: { ...stopped, items: [] }, completed: true });
  await state.manager.checkUsage();
  assert.equal(state.gateway.sent.length, 1);
  const active = state.task.activeTurnId!;
  state.gateway.finish(state.task.threadId!, active, 'completed');
  state.gateway.events.emit({ type: 'turn', threadId: state.task.threadId!, turn: { id: active, status: 'inProgress', items: [] }, completed: false });
  assert.equal(state.task.status, 'idle');
});

test('restore re-reads execution and usage before resuming the saved reservation', async () => {
  const original = setup(); waitForUsage(original);
  const restored = setup(undefined, original.manager.records());
  restored.gateway.threads.set(original.task.threadId!, structuredClone(original.gateway.threads.get(original.task.threadId!)!));
  await restored.manager.checkUsage(); assert.equal(restored.gateway.sent.length, 0);
  await restored.manager.restore(restored.task.id);
  await restored.manager.checkUsage(); assert.equal(restored.gateway.sent.length, 1);
});

test('restore never replays a send whose result was lost during a crash', async () => {
  const original = setup(); waitForUsage(original);
  original.task.claims.push({ stoppedTurnId: 'stopped', clientId: 'committed-before-crash' });
  const restored = setup(undefined, original.manager.records());
  restored.gateway.threads.set(original.task.threadId!, structuredClone(original.gateway.threads.get(original.task.threadId!)!));
  await restored.manager.restore(restored.task.id); await restored.manager.checkUsage();
  assert.equal(restored.gateway.sent.length, 0);
  assert.equal(restored.task.waiting, undefined);
});

test('a failed durable write prevents the automatic RPC', async () => {
  let fail = false;
  const state = setup({ async save() { if (fail) throw new Error('disk full'); } });
  waitForUsage(state); await state.manager.flush(); fail = true;
  await state.manager.checkUsage();
  assert.equal(state.gateway.sent.length, 0);
  assert.equal(state.task.status, 'error');
});

test('close between durable claim and send cancels the RPC', async () => {
  const saving = deferred<void>(); let block = false;
  const state = setup({ async save(records) { if (block && records[0]?.claims.length) await saving.promise; } });
  waitForUsage(state); await state.manager.flush(); block = true;
  const checking = state.manager.checkUsage();
  await new Promise(resolve => setImmediate(resolve));
  state.manager.close(state.task.id);
  saving.resolve(); await checking;
  assert.equal(state.gateway.sent.length, 0);
});

test('resume hydration replays live events after history to preserve streamed text', async () => {
  const state = setup();
  state.task.hydrated = false;
  const result = deferred<Thread>(); state.gateway.resumeThread = () => result.promise;
  const restoring = state.manager.restore(state.task.id);
  state.gateway.events.emit({ type: 'delta', threadId: state.task.threadId!, turnId: 'active', itemId: 'agent', kind: 'agentMessage', field: 'text', text: 'new' });
  const snapshot = thread(); snapshot.status = 'active'; snapshot.turns = [{ id: 'active', status: 'inProgress', items: [{ id: 'agent', kind: 'agentMessage', data: { text: 'old ' } }] }];
  result.resolve(snapshot); await restoring;
  assert.equal(state.task.turns[0]?.items[0]?.data.text, 'old new');
});

test('failed or sparse usage reads retain waiting without sending', async () => {
  const state = setup(); waitForUsage(state);
  state.gateway.limits = { buckets: [] };
  await state.manager.checkUsage(); assert.equal(state.gateway.sent.length, 0);
  state.gateway.usageReader = async () => { throw new Error('offline'); };
  await state.manager.checkUsage(); assert.equal(state.task.status, 'waiting');
});

test('a completed notification before turn/start response remains authoritative', async () => {
  const state = setup();
  state.gateway.turnStarter = async threadId => {
    const turn: Turn = { id: 'fast', status: 'inProgress', items: [] };
    state.gateway.finish(threadId, turn.id, 'completed'); return turn;
  };
  await state.manager.send(state.task.id, 'fast turn');
  assert.equal(state.task.status, 'idle');
  assert.equal(state.task.activeTurnId, undefined);
});

test('visible idle tasks refresh usage on open, notifications, resets and reconnect without auto-resume', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const gateway = new FakeGateway();
  const manager = new TaskManager(gateway, { async save() {} });
  t.after(() => manager.dispose());
  let reads = 0;
  gateway.usageReader = async () => usage(++reads * 10, 5000);
  const task = manager.create('/project');
  const tick = async (milliseconds: number) => { t.mock.timers.tick(milliseconds); await new Promise(resolve => setImmediate(resolve)); };
  await tick(0);
  assert.equal(manager.usage?.buckets[0]?.windows[0]?.usedPercent, 10);
  assert.equal(task.autoResume, false);
  gateway.events.emit({ type: 'usage' });
  await tick(0);
  assert.equal(manager.usage?.buckets[0]?.windows[0]?.usedPercent, 20);
  await tick(5000);
  assert.equal(reads, 3, 'reset times refresh a partially used window too');
  manager.close(task.id);
  await tick(600_000);
  assert.equal(reads, 3);
  manager.open(task.id);
  await tick(0);
  assert.equal(reads, 4);
  gateway.connected = false;
  gateway.events.emit({ type: 'connection', connected: false });
  assert.equal(manager.usage, undefined);
  await tick(600_000);
  assert.equal(reads, 4);
  gateway.connected = true;
  gateway.events.emit({ type: 'connection', connected: true });
  await tick(0);
  assert.equal(reads, 5);
  assert.equal(gateway.sent.length, 0);
});

test('account changes discard in-flight usage and read failures clear displayed balances', async () => {
  const { manager, gateway } = setup();
  const old = deferred<ReturnType<typeof usage>>();
  gateway.usageReader = () => old.promise;
  const first = manager.checkUsage();
  gateway.events.emit({ type: 'account' });
  gateway.usageReader = async () => usage(40);
  const next = manager.checkUsage();
  old.resolve(usage(90));
  await Promise.all([first, next]);
  assert.equal(manager.usage?.buckets[0]?.windows[0]?.usedPercent, 40);
  gateway.usageReader = async () => { throw new Error('offline'); };
  await manager.checkUsage();
  assert.equal(manager.usage, undefined);
  manager.dispose();
});

test('waiting uses notifications, reset times and ten-minute polling; closing clears the timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const gateway = new FakeGateway();
  const manager = new TaskManager(gateway, { async save() {} });
  t.after(() => manager.dispose());
  gateway.threads.set('timer', thread('timer'));
  const task = manager.adoptThread(thread('timer'));
  manager.setAutoResume(task.id, true);
  let reads = 0;
  gateway.usageReader = async () => { reads++; return usage(100, 5000); };
  gateway.finish('timer', 'stopped');
  t.mock.timers.tick(0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  t.mock.timers.tick(4999);
  assert.equal(reads, 1);
  t.mock.timers.tick(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 2, 'read again just after the reported reset');
  t.mock.timers.tick(600_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 3, 'poll every ten minutes even if usage stays exhausted');
  gateway.events.emit({ type: 'usage' });
  t.mock.timers.tick(0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 4, 'notifications trigger a fresh read');
  manager.close(task.id);
  t.mock.timers.tick(600_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 4);
});

test('an uncertain automatic send is rehydrated before the next manual input', async () => {
  const state = setup(); waitForUsage(state);
  state.gateway.turnStarter = async (threadId, input, clientId) => {
    state.gateway.threads.get(threadId)!.turns.push({ id: 'accepted-with-lost-response', status: 'inProgress', items: [{ id: 'user', kind: 'userMessage', data: { clientId, content: input } }] });
    state.gateway.threads.get(threadId)!.status = 'active';
    throw new Error('timeout');
  };
  await state.manager.checkUsage();
  assert.equal(state.task.hydrated, false);
  await state.manager.send(state.task.id, 'new manual instruction');
  assert.equal(state.gateway.sent.length, 1);
  assert.equal(state.gateway.steered[0]?.turnId, 'accepted-with-lost-response');
});
