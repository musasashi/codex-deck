import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { AppServerClient, decodeThread } from '../src/appServer/client';
import { JsonRpcPeer } from '../src/appServer/rpc';
import { deleteThreadHistory } from '../src/core/threadDeletion';
import type { JsonObject } from '../src/core/types';

for (const scenario of ['approve', 'cancel', 'running', 'unreadable', 'missing-root-rollout'] as const) test(`persisted references include hidden forks before deletion: ${scenario}`, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'codex-deck-deletion-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const records = [
    { id: 'root', name: '元のチャット', archived: true },
    { id: 'fork', name: '参照するチャット', archived: true, forked_from_id: 'root' },
    { id: 'hidden', name: '一覧に出ない分岐', archived: false, forked_from_id: 'fork' },
    { id: 'unrelated', name: '無関係なチャット', archived: false },
  ];
  for (const record of records) {
    if (scenario === 'missing-root-rollout' && record.id === 'root') continue;
    const directory = join(folder, record.archived ? 'archived_sessions' : 'sessions/2026/09/25');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `rollout-${record.id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: record }) + '\n');
  }
  const input = new PassThrough(), output = new PassThrough();
  const requests: { method: string; params: JsonObject }[] = [];
  const deleted: string[] = [];
  let codexHome: string | undefined = folder;
  output.on('data', chunk => {
    for (const line of String(chunk).trim().split('\n')) {
      const request = JSON.parse(line);
      requests.push(request);
      if (request.id === undefined) continue;
      let result: unknown = {}, error: unknown;
      const id = request.params?.threadId;
      if (request.method === 'initialize') result = { codexHome };
      else if (request.method === 'thread/list') {
        // The real server omits hidden forks and returns null ancestry on list responses.
        result = { data: records.filter(record => record.id !== 'hidden' && record.archived === request.params.archived)
          .map(record => ({ id: record.id, name: record.name, forkedFromId: null, parentThreadId: null })), nextCursor: null };
      } else if (request.method === 'thread/read') {
        const record = records.find(record => record.id === id)!;
        if (scenario === 'unreadable' && id === 'hidden') error = { code: -32603, message: 'metadata unavailable' };
        else result = { thread: { id, name: record.name, forkedFromId: record.forked_from_id,
          status: { type: (scenario === 'running' && id === 'hidden') || (scenario === 'missing-root-rollout' && id === 'root') ? 'active' : 'notLoaded' } } };
      } else if (request.method === 'thread/delete') {
        if (records.some(record => record.forked_from_id === id && !deleted.includes(record.id))) error = { code: -32603, message: 'forked history still references it' };
        else deleted.push(id);
      } else assert.fail(`Unexpected request: ${request.method}`);
      input.write(JSON.stringify({ id: request.id, ...(error ? { error } : { result }) }) + '\n');
    }
  });
  const client = new AppServerClient(), peer = new JsonRpcPeer(input, output);
  t.after(() => { client.detach(); peer.close(); });
  await client.connect(peer);
  const root = (await client.listThreads(undefined, true)).threads.find(thread => thread.id === 'root')!;
  assert.equal(root.forkedFromId, undefined);
  let confirmations = 0;
  const work = deleteThreadHistory(root, {
    list: () => client.listThreadsForDeletion(root), validate() {}, delete: thread => client.deleteThread(thread.id),
  }, async threads => {
    confirmations++;
    assert.deepEqual(threads.map(thread => thread.title), ['元のチャット', '一覧に出ない分岐', '参照するチャット']);
    assert.deepEqual(deleted, []);
    return scenario === 'approve';
  });
  if (scenario === 'running' || scenario === 'unreadable' || scenario === 'missing-root-rollout') {
    await assert.rejects(work, scenario === 'running' ? /一覧に出ない分岐.*停止/ : scenario === 'missing-root-rollout' ? /元のチャット.*停止/ : /metadata unavailable/);
    assert.equal(confirmations, 0);
  } else {
    assert.deepEqual(await work, { deletedIds: scenario === 'approve' ? ['hidden', 'fork', 'root'] : [] });
    assert.equal(confirmations, 1);
  }
  assert.deepEqual(deleted, scenario === 'approve' ? ['hidden', 'fork', 'root'] : []);
  const reads = requests.filter(request => request.method === 'thread/read');
  assert.ok(reads.every(request => request.params.includeTurns === false && request.params.threadId !== 'unrelated'));
  assert.ok(reads.some(request => request.params.threadId === 'hidden'));
  // A reconnect must not reuse the previous server's local store when its home is unavailable.
  codexHome = undefined;
  await client.connect(peer);
  await assert.rejects(client.listThreadsForDeletion(decodeThread({ id: 'root' })), /保存先がありません/);
});
