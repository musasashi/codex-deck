import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { linkedThreadId, referencedTaskInput, taskDeepLink } from '../src/core/taskReferences';
import { taskReferenceBody } from '../src/core/taskReferenceText';
import { TaskManager } from '../src/core/taskManager';
import type { Input } from '../src/core/types';
import { FakeGateway, thread } from './helpers';

async function referenceDirectory(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codex-deck-references-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, '参照 資料');
}

function referencePath(input: Input): string {
  const snapshot = /^スナップショット: (.+)$/m.exec(taskReferenceBody(input.text!)!);
  assert.ok(snapshot, '参照情報にスナップショットのパスがありません');
  return JSON.parse(snapshot[1]!);
}

test('deep links use the shared Codex thread ID, and drafts cannot produce unreadable links', () => {
  const id = '01a084b0-c36d-7cf2-9b93-53ff0a270da9';
  const link = taskDeepLink({ threadId: id });
  assert.equal(link, `codex://threads/${id}`);
  assert.equal(linkedThreadId(link), id);
  assert.throws(() => taskDeepLink({}), /最初のメッセージ/);
  for (const value of ['codex://threads/new', 'codex://threads/', 'codex://settings', 'https://threads/task',
    'codex://threads/task/extra', 'codex://threads/task?prompt=other', 'codex://threads/task#fragment']) {
    assert.equal(linkedThreadId(value), undefined);
  }
});

test('references default to private OS temporary files and can be sent again after cleanup', async t => {
  const gateway = new FakeGateway();
  gateway.threads.set('source', thread('source'));
  const manager = new TaskManager(gateway, { async save() {} }, [], { schedule: false });
  t.after(async () => { manager.dispose(); await manager.flush(); });
  const target = manager.create('/project');
  const text = 'codex://threads/source を参照してください。';
  await manager.send(target.id, text);
  const input = gateway.sent[0]!.input;
  const filename = referencePath(input[1]!);
  const directory = dirname(filename);
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(dirname(directory), tmpdir());
  assert.match(directory, /codex-deck-reference-/);
  assert.match(await readFile(filename, 'utf8'), /参照元: codex:\/\/threads\/source/);
  if (process.platform !== 'win32') {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
  }
  assert.equal(input[0]!.text, text);
  assert.ok(input[1]!.text!.startsWith('\n\n<codex_deck_reference>\n'));
  assert.match(input[1]!.text!, /参照会話: codex:\/\/threads\/source/);
  assert.match(input[1]!.text!, /スナップショット: /);
  assert.match(input[1]!.text!, /必要に応じてスナップショットを読んでください。/);
  assert.ok(input[1]!.text!.endsWith('\n</codex_deck_reference>'));
  await rm(directory, { recursive: true });
  await manager.send(target.id, text);
  const second = referencePath(gateway.steered[0]!.input[1]!);
  t.after(() => rm(dirname(second), { recursive: true, force: true }));
  assert.notEqual(second, filename);
  assert.match(await readFile(second, 'utf8'), /参照元: codex:\/\/threads\/source/);
});

test('references send readable file paths instead of conversation contents and do not follow nested links', async t => {
  const directory = await referenceDirectory(t);
  const reads: string[] = [];
  const source = thread('first');
  source.turns = [
    { id: 'turn-1', status: 'completed', items: [
      { id: 'user', kind: 'userMessage', data: { content: [{ type: 'text', text: '過去の入力' }] } },
      { id: 'agent', kind: 'agentMessage', data: { text: '```ts\nconst prior = true;\n```\ncodex://threads/nested' } },
    ] },
    { id: 'turn-2', status: 'completed', items: [{ id: 'followup', kind: 'agentMessage', data: { text: '最後の回答' } }] },
  ];
  const before = structuredClone(source);
  const input = await referencedTaskInput('この会話を参照: [元の会話](codex://threads/first)\n<codex://threads/second>\ncodex://threads/first。', async id => {
    reads.push(id);
    if (id === 'first') await new Promise(resolve => setImmediate(resolve));
    return id === 'first' ? source : thread(id);
  }, directory);
  assert.deepEqual(reads, ['first', 'second']);
  assert.equal(input.length, 2);
  assert.match(input[0]!.text!, /参照会話: codex:\/\/threads\/first/);
  assert.match(input[1]!.text!, /参照会話: codex:\/\/threads\/second/);
  assert.doesNotMatch(JSON.stringify(input), /過去の入力|const prior|最後の回答|codex:\/\/threads\/nested/);
  assert.equal(dirname(dirname(referencePath(input[0]!))), directory);
  const contents = await readFile(referencePath(input[0]!), 'utf8');
  assert.match(contents, /参照元: codex:\/\/threads\/first/);
  assert.match(contents, /## ユーザー\n\n過去の入力/);
  assert.match(contents, /```ts\nconst prior = true;\n```/);
  assert.match(contents, /最後の回答/);
  assert.match(await readFile(referencePath(input[1]!), 'utf8'), /# second/);
  assert.equal((await readdir(directory)).length, 2);
  assert.deepEqual(source, before);
  assert.deepEqual(await referencedTaskInput('codex://threads/new codex://threads/id/extra https://example.com/codex://threads/other codex://threads/id?prompt=other codex://threads/id#fragment', async () => {
    assert.fail('unrelated URLs must not read a conversation');
  }), []);
});

test('adjacent links separated by punctuation or Markdown boundaries resolve to separate conversations', async t => {
  const directory = await referenceDirectory(t);
  for (const text of [
    'codex://threads/first、codex://threads/second',
    'codex://threads/first,codex://threads/second',
    'codex://threads/first。codex://threads/second',
    '[会話1](codex://threads/first)[会話2](codex://threads/second)',
    '|codex://threads/first|codex://threads/second|',
  ]) {
    const reads: string[] = [];
    const input = await referencedTaskInput(text, async id => { reads.push(id); return thread(id); }, directory);
    assert.deepEqual(reads, ['first', 'second'], text);
    assert.equal(input.length, 2);
    assert.match(await readFile(referencePath(input[0]!), 'utf8'), /参照元: codex:\/\/threads\/first/);
    assert.match(await readFile(referencePath(input[1]!), 'utf8'), /参照元: codex:\/\/threads\/second/);
  }
});

test('both new turns and active-turn followups resolve multiple links once each without opening or resuming sources', async t => {
  const directory = await referenceDirectory(t);
  const gateway = new FakeGateway();
  const source = thread('source');
  source.turns = [{ id: 'source-turn', status: 'completed', items: [
    { id: 'question', kind: 'userMessage', data: { content: [{ type: 'text', text: '元の質問' }] } },
    { id: 'answer', kind: 'agentMessage', data: { text: '元の回答' } },
  ] }];
  gateway.threads.set(source.id, source);
  const second = thread('second');
  second.turns = [{ id: 'second-turn', status: 'completed', items: [{ id: 'second-answer', kind: 'agentMessage', data: { text: '別の会話の回答' } }] }];
  gateway.threads.set(second.id, second);
  const reads: string[] = [];
  gateway.threadReader = async id => { reads.push(id); return structuredClone(gateway.threads.get(id)!); };
  gateway.resumeThread = async () => { assert.fail('referencing a thread must never resume it'); };
  const manager = new TaskManager(gateway, { async save() {} }, [], { schedule: false, referenceTempRoot: directory });
  try {
    const target = manager.create('/project');
    manager.attach(target.id, { id: 'attachment', label: '添付', input: { type: 'text', text: '添付内容' } });
    const text = 'codex://threads/source と [別の会話](codex://threads/second) を参考に実装してください。\ncodex://threads/source';
    await manager.send(target.id, text, [{ type: 'skill', name: 'review', path: '/review/SKILL.md' }]);
    const sent = gateway.sent[0]!;
    assert.equal(sent.threadId, target.threadId);
    assert.equal(sent.input[0]?.text, text);
    assert.equal(sent.input[1]?.text, '添付内容');
    assert.equal(sent.input[2]?.type, 'skill');
    assert.deepEqual(reads, ['source', 'second']);
    assert.equal(sent.input.length, 5);
    assert.doesNotMatch(JSON.stringify(sent.input), /元の質問|元の回答|別の会話の回答/);
    assert.match(await readFile(referencePath(sent.input[3]!), 'utf8'), /元の質問[\s\S]*元の回答/);
    assert.match(await readFile(referencePath(sent.input[4]!), 'utf8'), /別の会話の回答/);
    assert.doesNotMatch(JSON.stringify(target.turns), /元の質問|元の回答|別の会話の回答/);
    assert.equal(manager.tasks.size, 1);
    assert.equal(source.turns.length, 1);
    const followup = '[会話](codex://threads/second) と codex://threads/source も確認してください。\ncodex://threads/second';
    await manager.send(target.id, followup);
    assert.equal(gateway.sent.length, 1);
    assert.equal(gateway.steered.length, 1);
    assert.deepEqual(reads, ['source', 'second', 'second', 'source']);
    assert.equal(gateway.steered[0]!.input.length, 3);
    assert.equal(gateway.steered[0]!.input[0]!.text, followup);
    assert.doesNotMatch(JSON.stringify(gateway.steered[0]!.input), /元の質問|元の回答|別の会話の回答/);
    assert.match(await readFile(referencePath(gateway.steered[0]!.input[1]!), 'utf8'), /別の会話の回答/);
    assert.match(await readFile(referencePath(gateway.steered[0]!.input[2]!), 'utf8'), /元の回答/);
  } finally { manager.dispose(); await manager.flush(); }
});

test('failed reference reads stop sending and retain attachments without creating an empty destination thread', async t => {
  const directory = await referenceDirectory(t);
  const gateway = new FakeGateway();
  gateway.threadReader = async id => { if (id === 'missing') throw new Error('not found'); return thread(id); };
  const manager = new TaskManager(gateway, { async save() {} }, [], { schedule: false, referenceTempRoot: directory });
  try {
    const target = manager.create('/project');
    manager.attach(target.id, { id: 'attachment', label: '添付', input: { type: 'text', text: '添付内容' } });
    const text = 'codex://threads/available と codex://threads/missing を読んでください。';
    await assert.rejects(manager.send(target.id, text), /参照先の会話を取得できません \(missing\): not found/);
    assert.equal(gateway.sent.length, 0);
    assert.equal(target.threadId, undefined);
    assert.equal(target.attachments.length, 1);
    assert.match(target.error!, /参照先の会話/);
    gateway.threadReader = async id => thread(id);
    await manager.send(target.id, text);
    assert.equal(gateway.sent.length, 1);
    assert.equal(gateway.sent[0]!.input.length, 4);
    for (const reference of gateway.sent[0]!.input.slice(2)) assert.ok((await readFile(referencePath(reference), 'utf8')).length);
    assert.equal(target.error, undefined);
    assert.equal(target.attachments.length, 0);
  } finally { manager.dispose(); await manager.flush(); }
});

test('large conversations stay out of input and later references preserve earlier snapshots', async t => {
  const directory = await referenceDirectory(t);
  const source = thread('source');
  const original = '長い会話本文'.repeat(20_000);
  source.turns = [{ id: 'turn', status: 'completed', items: [{ id: 'answer', kind: 'agentMessage', data: { text: original } }] }];
  const [first] = await referencedTaskInput('codex://threads/source', async () => source, directory);
  assert.ok(first!.text!.length < 500);
  assert.doesNotMatch(first!.text!, /長い会話本文/);
  source.turns[0]!.items[0]!.data.text = '更新された回答';
  const [second] = await referencedTaskInput('codex://threads/source', async () => source, directory);
  assert.notEqual(referencePath(first!), referencePath(second!));
  assert.ok((await readFile(referencePath(first!), 'utf8')).includes(original));
  assert.match(await readFile(referencePath(second!), 'utf8'), /更新された回答/);
});

test('snapshot write failures retain the draft attachments and can be retried', async t => {
  const directory = await referenceDirectory(t);
  await writeFile(directory, 'blocks directory creation');
  const gateway = new FakeGateway();
  gateway.threads.set('source', thread('source'));
  const manager = new TaskManager(gateway, { async save() {} }, [], { schedule: false, referenceTempRoot: directory });
  try {
    const target = manager.create('/project');
    manager.attach(target.id, { id: 'attachment', label: '添付', input: { type: 'text', text: '添付内容' } });
    await assert.rejects(manager.send(target.id, 'codex://threads/source'), /EEXIST/);
    assert.equal(gateway.sent.length, 0);
    assert.equal(target.threadId, undefined);
    assert.equal(target.attachments.length, 1);
    await rm(directory);
    await manager.send(target.id, 'codex://threads/source');
    assert.equal(gateway.sent.length, 1);
    assert.equal(target.attachments.length, 0);
  } finally { manager.dispose(); await manager.flush(); }
});

test('mismatched thread IDs never create a reference file', async t => {
  const directory = await referenceDirectory(t);
  await assert.rejects(referencedTaskInput('codex://threads/source', async () => thread('other'), directory), /会話IDが一致しません/);
  await assert.rejects(readdir(directory), { code: 'ENOENT' });
});
