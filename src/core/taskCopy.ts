import { array, object, string, type Item, type Task } from './types';

function imageMarkdown(source: string): string {
  return source ? `![添付画像](<${source.replace(/[\s<>\\]/g, encodeURIComponent)}>)` : '（添付画像）';
}

export function messageMarkdown(item: Item): string | undefined {
  switch (item.kind) {
    case 'userMessage':
      return array(item.data.content).map(value => {
        const input = object(value);
        switch (input.type) {
          case 'text': return string(input.text);
          case 'image': return imageMarkdown(string(input.url));
          case 'localImage': return imageMarkdown(string(input.path));
          case 'skill': return `$${string(input.name)}`;
          default: return '';
        }
      }).filter(Boolean).join('\n\n');
    case 'agentMessage': case 'plan': return string(item.data.text);
    case 'exitedReviewMode': return string(item.data.review);
    default: return undefined;
  }
}

export function taskMarkdown(task: Pick<Task, 'title' | 'turns'>): string {
  const title = task.title.replace(/[\r\n]+/g, ' ').replace(/([\\`*_\[\]<>])/g, '\\$1');
  const sections = [`# ${title}`];
  for (const turn of task.turns) {
    for (const item of turn.items) {
      const text = messageMarkdown(item);
      if (text) sections.push(`## ${item.kind === 'userMessage' ? 'ユーザー' : 'Codex'}\n\n${text}`);
    }
  }
  return sections.join('\n\n') + '\n';
}
