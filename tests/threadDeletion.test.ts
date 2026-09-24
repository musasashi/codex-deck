import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteThreadHistory, threadDeletionOrder } from '../src/core/threadDeletion';
import type { Thread } from '../src/core/types';
import { thread } from './helpers';

function family(): Thread[] {
  return [
    { ...thread('root'), title: '元のチャット' },
    { ...thread('fork'), title: '参照するチャット', forkedFromId: 'root' },
    { ...thread('nested'), title: 'さらに分岐したチャット', forkedFromId: 'fork' },
    { ...thread('child'), title: '子チャット', parentThreadId: 'root', forkedFromId: 'root' },
    { ...thread('child-fork'), title: '子チャットからの分岐', forkedFromId: 'child' },
    thread('unrelated'),
  ];
}

test('deletion includes transitive forks and spawned children once, before their sources', () => {
  const threads = family();
  assert.deepEqual(threadDeletionOrder(threads[0]!, threads).map(thread => thread.id), ['nested', 'fork', 'child-fork', 'child', 'root']);
  assert.deepEqual(threadDeletionOrder(threads[1]!, threads).map(thread => thread.id), ['nested', 'fork']);
  assert.throws(() => threadDeletionOrder(threads[0]!, [{ ...threads[0]!, forkedFromId: 'nested' }, ...threads.slice(1)]), /循環/);
});

for (const approve of [false, true]) test(`deletion ${approve ? 'removes' : 'retains'} exactly the chats whose titles were confirmed`, async () => {
  const threads = family(), deleted: string[] = [];
  let confirmations = 0;
  const result = await deleteThreadHistory(threads[0]!, {
    list: async () => threads, validate() {},
    async delete(thread) { assert.equal(confirmations, 1); deleted.push(thread.id); },
  }, async targets => {
    confirmations++;
    assert.equal(targets[0]!.title, '元のチャット');
    assert.deepEqual(new Set(targets.map(thread => thread.title)), new Set(threads.slice(0, 5).map(thread => thread.title)));
    assert.equal(deleted.length, 0);
    return approve;
  });
  assert.equal(confirmations, 1);
  assert.deepEqual(result, { deletedIds: approve ? ['nested', 'fork', 'child-fork', 'child', 'root'] : [] });
  assert.deepEqual(deleted, result.deletedIds);
});

test('a single archived chat can be deleted without any related chats', async () => {
  const root = thread('single');
  const deleted: string[] = [];
  const result = await deleteThreadHistory(root, {
    list: async () => [root, thread('unrelated')], validate() {}, async delete(thread) { deleted.push(thread.id); },
  }, async targets => { assert.deepEqual(targets, [root]); return true; });
  assert.deepEqual(deleted, ['single']);
  assert.deepEqual(result, { deletedIds: ['single'] });
});

test('partial failures retain the source and report the failed title and completed deletions', async () => {
  const threads = family(), attempted: string[] = [];
  const result = await deleteThreadHistory(threads[0]!, {
    list: async () => threads, validate() {},
    async delete(thread) { attempted.push(thread.id); if (thread.id === 'fork') throw new Error('forked history still references it'); },
  }, async () => true);
  assert.deepEqual(attempted, ['nested', 'fork']);
  assert.deepEqual(result.deletedIds, ['nested']);
  assert.match(result.error!.message, /参照するチャット.*1件は削除済み.*forked history/);
});

test('planning failures and running related chats do not delete any history', async () => {
  for (const reason of ['list', 'running', 'became-busy'] as const) {
    const threads = family();
    if (reason === 'running') threads[1]!.status = 'active';
    let approved = false;
    await assert.rejects(deleteThreadHistory(threads[0]!, {
      list: async () => { if (reason === 'list') throw new Error('list failed'); return threads; },
      validate() { if (reason === 'became-busy' && approved) throw new Error('busy'); },
      async delete() { assert.fail('history must be retained'); },
    }, async () => { approved = true; return true; }), reason === 'list' ? /list failed/ : reason === 'running' ? /参照するチャット.*停止/ : /busy/);
  }
});
