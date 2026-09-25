import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRolloutReferences } from '../src/appServer/rolloutMetadata';
import { threadDeletionOrder } from '../src/core/threadDeletion';

test('rollout metadata discovers forks, spawned children and history bases across both stores using only the header', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'codex-deck-metadata-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const active = join(folder, 'sessions', '2026', '09', '25'), archived = join(folder, 'archived_sessions');
  await mkdir(active, { recursive: true }); await mkdir(archived);
  const headers = [
    [archived, { id: 'root' }],
    [archived, { id: 'fork', forked_from_id: 'root' }],
    [active, { id: 'hidden', forked_from_id: 'fork', base_instructions: { text: '日本語'.repeat(30_000) } }],
    [active, { id: 'child', source: { subagent: { thread_spawn: { parent_thread_id: 'root' } } } }],
    [active, { id: 'history', forked_from_id: 'unrelated', history_base: { thread_id: 'child', end_ordinal_exclusive: 5 } }],
  ] as const;
  for (const [directory, payload] of headers) await writeFile(join(directory, `rollout-${payload.id}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload })}\nThis is not a JSON record and must not be read.\n`);
  await writeFile(join(active, 'unrelated.jsonl'), 'not a rollout');
  const references = await readRolloutReferences(folder);
  assert.equal(references.length, 5);
  assert.equal(references.find(value => value.id === 'hidden')!.forkedFromId, 'fork');
  assert.equal(references.find(value => value.id === 'child')!.parentThreadId, 'root');
  assert.equal(references.find(value => value.id === 'history')!.historyBaseThreadId, 'child');
  const ordered = threadDeletionOrder({ id: 'root' }, references).map(value => value.id);
  for (const [child, parent] of [['hidden', 'fork'], ['fork', 'root'], ['history', 'child'], ['child', 'root']] as const) {
    assert.ok(ordered.indexOf(child) < ordered.indexOf(parent));
  }
});

test('absent history directories are empty but malformed metadata prevents a partial dependency graph', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'codex-deck-metadata-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  assert.deepEqual(await readRolloutReferences(folder), []);
  await mkdir(join(folder, 'sessions'));
  const file = join(folder, 'sessions', 'rollout-broken.jsonl');
  for (const content of ['', '{unfinished', '{"type":"event_msg","payload":{"id":"wrong-record"}}', '{"type":"session_meta","payload":{"id":"child","forked_from_id":42}}']) {
    await writeFile(file, content);
    await assert.rejects(readRolloutReferences(folder), /参照関係を読み取れませんでした.*rollout-broken/);
  }
});

test('conflicting duplicate rollout headers stop deletion planning', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'codex-deck-metadata-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  for (const [directory, parent] of [['sessions', 'first'], ['archived_sessions', 'second']] as const) {
    await mkdir(join(folder, directory));
    await writeFile(join(folder, directory, 'rollout-fork.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'fork', forked_from_id: parent } }));
  }
  await assert.rejects(readRolloutReferences(folder), /参照関係が重複/);
});
