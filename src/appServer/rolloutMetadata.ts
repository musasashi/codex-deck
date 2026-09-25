import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { messageOf, object, type ThreadReference } from '../core/types';

async function readReference(file: string): Promise<ThreadReference> {
  try {
    // Only the first JSONL record is needed, even for very large conversations.
    const chunks: Buffer[] = [];
    for await (const data of createReadStream(file)) {
      const chunk = data as Buffer;
      const end = chunk.indexOf(10);
      chunks.push(end < 0 ? chunk : chunk.subarray(0, end));
      if (end >= 0) break;
    }
    const entry = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const meta = object(entry.payload);
    if (entry.type !== 'session_meta' || typeof meta.id !== 'string' || !meta.id) throw new Error('session_metaがありません。');
    const optionalId = (value: unknown): string | undefined => {
      if (value == null) return undefined;
      if (typeof value !== 'string' || !value) throw new Error('参照先のIDが不正です。');
      return value;
    };
    return {
      id: meta.id,
      forkedFromId: optionalId(meta.forked_from_id),
      parentThreadId: optionalId(object(object(object(meta.source).subagent).thread_spawn).parent_thread_id),
      historyBaseThreadId: optionalId(object(meta.history_base).thread_id),
    };
  } catch (error) {
    throw new Error(`チャットの参照関係を読み取れませんでした（${file}）：${messageOf(error)}`);
  }
}

/** thread/list omits some persisted forks and does not populate their ancestry. */
export async function readRolloutReferences(codexHome: string): Promise<ThreadReference[]> {
  const references = new Map<string, ThreadReference>();
  async function visit(directory: string, optional = false): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`チャットの保存先を読み取れませんでした（${directory}）：${messageOf(error)}`);
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        const reference = await readReference(file);
        const previous = references.get(reference.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(reference)) throw new Error(`チャットの参照関係が重複しています：${reference.id}`);
        references.set(reference.id, reference);
      }
    }
  }
  await visit(join(codexHome, 'sessions'), true);
  await visit(join(codexHome, 'archived_sessions'), true);
  return [...references.values()];
}
