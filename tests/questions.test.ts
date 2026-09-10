import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeItem, decodeTurn } from '../src/appServer/client';
import { TaskManager } from '../src/core/taskManager';
import type { TaskRecord } from '../src/core/types';
import { FakeGateway, deferred, thread } from './helpers';

const questionItem = (id = 'question') => decodeItem({ type: 'agentMessage', id,
  text: 'AかBどちらにしますか？\n- A\n- B', phase: 'final_answer', delivery: 'async',
  questions: [{ title: 'AかBどちらにしますか？', options: ['A', 'B'] }] });

function setup(status = 'inProgress', records: TaskRecord[] = []) {
  const gateway = new FakeGateway();
  const value = thread();
  value.status = status === 'inProgress' ? 'active' : 'idle';
  value.turns = [decodeTurn({ id: 'turn', status, items: [
    { type: 'userMessage', id: 'user', content: [{ type: 'text', text: '選択UIを表示してください。' }] },
    questionItem().data,
    { type: 'agentMessage', id: 'final', text: '選択用のUIを表示しました。', phase: 'final_answer', delivery: null, questions: null },
  ] })];
  gateway.threads.set(value.id, value);
  const manager = new TaskManager(gateway, { async save() {} }, records, { schedule: false });
  const task = records.length ? manager.get(records[0]!.id) : manager.adoptThread(structuredClone(value));
  return { gateway, manager, task };
}

test('async message questions from history and live events remain visible after completion', () => {
  const { gateway, manager, task } = setup();
  const other = manager.adoptThread(thread('other'));
  const request = task.requests[0]!;
  assert.equal(request.source, 'agentMessage');
  assert.equal(request.blocking, false);
  assert.deepEqual(request.questions?.[0]?.options.map(option => option.label), ['A', 'B']);
  assert.equal(task.status, 'running');
  gateway.events.emit({ type: 'item', threadId: task.threadId!, turnId: 'turn', item: questionItem(), completed: true });
  assert.equal(task.requests.length, 1, 'duplicate items must not duplicate the card');
  assert.equal(other.requests.length, 0);
  gateway.events.emit({ type: 'turn', threadId: task.threadId!, turn: { id: 'turn', status: 'completed', items: [] }, completed: true });
  assert.equal(task.activeTurnId, undefined);
  assert.equal(task.status, 'input');
  assert.equal(task.requests[0]?.id, request.id);
  manager.close(task.id); manager.open(task.id);
  assert.equal(task.requests[0]?.id, request.id);
  manager.dispose();
});

test('a streamed async question is decoded without a server request or experimental capabilities', () => {
  const { gateway, manager, task } = setup();
  let attention = 0;
  manager.attention.subscribe(() => attention++);
  gateway.events.emit({ type: 'item', threadId: task.threadId!, turnId: 'turn', item: questionItem('second'), completed: true });
  assert.equal(task.requests.length, 2);
  assert.equal(attention, 1);
  gateway.events.emit({ type: 'item', threadId: task.threadId!, turnId: 'turn', item: questionItem('second'), completed: true });
  assert.equal(attention, 1);
  manager.dispose();
});

test('answering an async question steers its task without sending composer attachments', async () => {
  const { gateway, manager, task } = setup();
  const request = task.requests[0]!;
  manager.attach(task.id, { id: 'draft', label: 'draft.png', input: { type: 'image', url: 'data:image/png;base64,YQ==' } });
  assert.throws(() => manager.answer(manager.adoptThread(thread('other')).id, request.id, { answers: { '0': ['B'] } }));
  await manager.answer(task.id, request.id, { answers: { '0': ['B'] } });
  assert.deepEqual(gateway.steered, [{ threadId: task.threadId, turnId: 'turn', input: [{ type: 'text', text: 'AかBどちらにしますか？\nB' }] }]);
  assert.equal(gateway.sent.length, 0);
  assert.equal(gateway.answered.length, 0);
  assert.equal(task.attachments.length, 1);
  assert.equal(task.requests.length, 0);
  gateway.events.emit({ type: 'item', threadId: task.threadId!, turnId: 'turn', item: questionItem(), completed: true });
  assert.equal(task.requests.length, 0, 'late notifications must not reopen an answered question');
  assert.deepEqual(manager.records()[0]?.resolvedQuestionIds, [request.id]);
  manager.dispose();
});

test('completed questions start a new turn and reject blank or duplicate answers', async () => {
  const { gateway, manager, task } = setup('completed');
  const request = task.requests[0]!;
  await assert.rejects(async () => manager.answer(task.id, request.id, { answers: { '0': [' '] } }), /すべての質問/);
  assert.equal(task.requests.length, 1);
  const response = deferred<ReturnType<typeof decodeTurn>>();
  gateway.turnStarter = () => response.promise;
  const sending = manager.answer(task.id, request.id, { answers: { '0': ['自分の案'] } });
  const duplicate = assert.rejects(async () => manager.answer(task.id, request.id, { answers: { '0': ['A'] } }), /解決済み/);
  assert.equal(task.busy, true);
  await new Promise(resolve => setImmediate(resolve));
  response.resolve(decodeTurn({ id: 'next', status: 'inProgress', items: [] }));
  await sending; await duplicate;
  assert.equal(gateway.sent.length, 1);
  assert.deepEqual(gateway.sent[0]?.input, [{ type: 'text', text: 'AかBどちらにしますか？\n自分の案' }]);
  assert.equal(task.activeTurnId, 'next');
  assert.equal(task.requests.length, 0);
  manager.dispose();
});

test('failed async answers stay available for retry and skip persists across restoration', async () => {
  const { gateway, manager, task } = setup('completed');
  const request = task.requests[0]!;
  gateway.turnStarter = async () => { throw new Error('送信失敗'); };
  await assert.rejects(async () => manager.answer(task.id, request.id, { answers: { '0': ['A'] } }), /送信失敗/);
  assert.equal(task.requests.length, 1);
  assert.equal(task.busy, false);
  await manager.answer(task.id, request.id, { skip: true });
  assert.equal(gateway.sent.length, 1, 'skip must not start a turn');
  assert.equal(task.requests.length, 0);
  assert.equal(task.status, 'idle');
  const restored = setup('completed', manager.records());
  await restored.manager.restore(restored.task.id);
  assert.equal(restored.task.requests.length, 0);
  manager.dispose(); restored.manager.dispose();
});

test('history restores only questions after the latest user input, including interrupted turns', () => {
  const { manager, gateway, task } = setup('completed');
  const value = gateway.threads.get(task.threadId!)!;
  value.turns.push(decodeTurn({ id: 'later', status: 'interrupted', items: [
    { type: 'userMessage', id: 'followup', content: [{ type: 'text', text: '選ぶまで表示し続けて' }] },
    { ...questionItem('latest').data, questions: [{ title: '方針は？', options: ['A', 'B', 'C'] }, { title: '補足は？', options: null }] },
  ] }));
  manager.adoptThread(value);
  assert.equal(task.requests.length, 1);
  assert.equal(task.requests[0]?.turnId, 'later');
  assert.equal(task.requests[0]?.questions?.length, 2);
  assert.deepEqual(task.requests[0]?.questions?.[1]?.options, []);
  assert.equal(task.status, 'input');
  manager.dispose();
});

test('ordinary follow-up input resolves existing message questions', async () => {
  const { manager, gateway, task } = setup();
  const requestId = task.requests[0]!.id;
  await manager.send(task.id, 'Bで進めてください。');
  assert.equal(gateway.steered.length, 1);
  assert.equal(task.requests.length, 0);
  assert.deepEqual(task.resolvedQuestionIds, [requestId]);
  manager.dispose();
});
