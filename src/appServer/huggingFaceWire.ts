import { createHash } from 'node:crypto';
import { array, object, string, type JsonObject } from '../core/types';

/** Keep Codex's tool identities while exposing ordinary function tools to HF. */
export function huggingFaceRequest(raw: JsonObject): { body: JsonObject; restore: (value: unknown) => unknown } {
  const names = new Map<string, { name: string; namespace: string }>();
  const directNames = new Set(array(raw.tools).map(object).filter(tool => tool.type === 'function').map(tool => tool.name));
  const functionName = (name: string, namespace: string): string => {
    const hash = createHash('sha256').update(JSON.stringify([namespace, name])).digest('hex').slice(0, 20);
    const flat = `${namespace}__${name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 42) + '_' + hash;
    if (directNames.has(flat)) throw new Error('HF用のツール名が重複しています。');
    names.set(flat, { name, namespace });
    return flat;
  };
  const call = (value: unknown): unknown => {
    const item = object(value);
    if (item.type !== 'function_call' || !item.namespace || typeof item.name !== 'string') return value;
    const { namespace, ...rest } = item;
    return { ...rest, name: functionName(item.name, string(namespace)) };
  };
  const body = { ...raw };
  if (Array.isArray(raw.tools)) body.tools = raw.tools.flatMap(value => {
    const tool = object(value);
    if (tool.type !== 'namespace') return [tool];
    return array(tool.tools).map(value => {
      const fn = object(value);
      if (fn.type !== 'function' || typeof fn.name !== 'string') throw new Error('HFではこの形式の名前空間ツールを使用できません。');
      return { ...fn, name: functionName(fn.name, string(tool.name)),
        description: [tool.description, fn.description].filter(value => typeof value === 'string' && value).join('\n\n') };
    });
  });
  // HF's Responses input schema does not accept the reasoning items it returns.
  if (Array.isArray(raw.input)) body.input = raw.input.filter(item => object(item).type !== 'reasoning').map(call);
  const choice = object(raw.tool_choice);
  if (choice.type === 'function' && typeof choice.namespace === 'string' && typeof choice.name === 'string') {
    const { namespace, ...rest } = choice;
    body.tool_choice = { ...rest, name: functionName(choice.name, namespace) };
  }
  // HF presets use the model's default effort, not the host's OpenAI effort setting.
  delete body.reasoning;
  const restore = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(restore);
    if (!value || typeof value !== 'object') return value;
    const item = object(value);
    const result = Object.fromEntries(Object.entries(item).map(([key, value]) => [key, restore(value)]));
    const original = item.type === 'function_call' ? names.get(string(item.name)) : undefined;
    return original ? { ...result, ...original } : result;
  };
  return { body, restore };
}
