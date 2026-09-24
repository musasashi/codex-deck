import { messageOf, type Thread } from './types';

export interface ThreadDeletionResult { deletedIds: string[]; error?: Error }
export type ConfirmThreadDeletion = (threads: Thread[]) => Promise<boolean>;
interface ThreadDeletionHost {
  list(): Promise<Thread[]>;
  validate(threads: Thread[]): void;
  delete(thread: Thread): Promise<void>;
}

/** Delete forks and spawned children before the history they depend on. */
export function threadDeletionOrder(root: Thread, threads: Thread[]): Thread[] {
  const byId = new Map(threads.map(thread => [thread.id, thread]));
  if (!byId.has(root.id)) byId.set(root.id, root);
  const dependents = new Map<string, Thread[]>();
  for (const thread of byId.values()) {
    for (const parent of new Set([thread.forkedFromId, thread.parentThreadId])) {
      if (!parent) continue;
      const children = dependents.get(parent) ?? [];
      children.push(thread); dependents.set(parent, children);
    }
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const ordered: Thread[] = [];
  function visit(thread: Thread): void {
    if (visiting.has(thread.id)) throw new Error('チャットの参照関係が循環しているため削除できません。');
    if (visited.has(thread.id)) return;
    visiting.add(thread.id);
    for (const child of dependents.get(thread.id) ?? []) visit(child);
    visiting.delete(thread.id); visited.add(thread.id); ordered.push(thread);
  }
  visit(byId.get(root.id)!);
  return ordered;
}

export async function deleteThreadHistory(root: Thread, host: ThreadDeletionHost, confirm: ConfirmThreadDeletion): Promise<ThreadDeletionResult> {
  const ordered = threadDeletionOrder(root, await host.list());
  const validate = (): void => {
    const running = ordered.find(thread => thread.status === 'active');
    if (running) throw new Error(`「${running.title}」の実行を停止してから削除してください。`);
    host.validate(ordered);
  };
  validate();
  const deletedIds: string[] = [];
  // Show the selected chat first, followed by every chat included in the deletion.
  if (!await confirm([ordered.at(-1)!, ...ordered.slice(0, -1)])) return { deletedIds };
  validate();
  for (const thread of ordered) {
    try {
      await host.delete(thread);
      deletedIds.push(thread.id);
    } catch (error) {
      const progress = deletedIds.length ? `（${deletedIds.length}件は削除済み）` : '';
      return { deletedIds, error: new Error(`「${thread.title}」を削除できませんでした${progress}：${messageOf(error)}`) };
    }
  }
  return { deletedIds };
}
