const start = '\n\n<codex_deck_reference>\n';
const end = '\n</codex_deck_reference>';

export function taskReferenceText(link: string, filename: string): string {
  return `${start}参照会話: ${link}\nスナップショット: ${JSON.stringify(filename)}\n必要に応じてスナップショットを読んでください。${end}`;
}

export function taskReferenceBody(text: string): string | undefined {
  return text.startsWith(start) && text.endsWith(end) ? text.slice(start.length, -end.length) : undefined;
}
