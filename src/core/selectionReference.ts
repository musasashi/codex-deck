export function selectionReference(text: string, source: string): string {
  const quote = text.split(/\r\n|\r|\n/).map(line => `> ${line}`).join('\n');
  return `> 参照元: ${source.replace(/[\r\n]+/g, ' ')}\n>\n${quote}\n\n`;
}
