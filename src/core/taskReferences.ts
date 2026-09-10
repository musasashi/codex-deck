import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taskMarkdown } from './taskCopy';
import { taskReferenceText } from './taskReferenceText';
import { messageOf, type Input, type Task, type Thread } from './types';

export function taskDeepLink(task: Pick<Task, 'threadId'>): string {
  if (!task.threadId) throw new Error('最初のメッセージを送信してからディープリンクをコピーしてください。');
  return `codex://threads/${encodeURIComponent(task.threadId)}`;
}

export function linkedThreadId(value: string): string | undefined {
  const match = /^codex:\/\/threads\/([a-z\d_-]+)$/i.exec(value);
  return match?.[1] && match[1].toLowerCase() !== 'new' ? match[1] : undefined;
}

export async function referencedTaskInput(text: string, read: (threadId: string) => Promise<Thread>, temporaryRoot = tmpdir()): Promise<Input[]> {
  const ids = new Set<string>();
  for (const match of text.matchAll(/(?<![a-z\d+./:-])codex:\/\/threads\/[^\s<>"'`()\[\]{},;|、。）」』】]+/gi)) {
    const id = linkedThreadId(match[0].replace(/[)\]}.,!?;:、。）」』】]+$/g, ''));
    if (id) ids.add(id);
  }
  const results = await Promise.allSettled([...ids].map(async id => {
    try {
      const thread = await read(id);
      if (thread.id !== id) throw new Error('会話IDが一致しません。');
      const link = taskDeepLink({ threadId: id });
      await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
      const directory = await mkdtemp(join(temporaryRoot, 'codex-deck-reference-'));
      const filename = join(directory, 'conversation.md');
      await writeFile(filename, `参照元: ${link}\n\n${taskMarkdown(thread)}`, { flag: 'wx', mode: 0o600 });
      return { type: 'text' as const, text: taskReferenceText(link, filename) };
    } catch (error) {
      throw new Error(`参照先の会話を取得できません (${id}): ${messageOf(error)}`);
    }
  }));
  return results.map(result => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}
