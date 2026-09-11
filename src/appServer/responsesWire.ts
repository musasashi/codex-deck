import { createHash } from 'node:crypto';
import { array, object, string, type JsonObject } from '../core/types';

export interface ResponsesWireOptions { discardReasoning?: boolean; discardReasoningInput?: boolean; stateless?: boolean; images?: boolean; structuredOutput?: boolean }

/** Preserve Codex's tool identities while exposing standard function tools. */
export function responsesRequest(raw: JsonObject, options: ResponsesWireOptions = {}): { body: JsonObject; restore: (value: unknown) => unknown } {
  const names = new Map<string, { name: string; namespace: string }>();
  const directNames = new Set(array(raw.tools).map(object).filter(tool => tool.type === 'function').map(tool => tool.name));
  const functionName = (name: string, namespace: string): string => {
    const hash = createHash('sha256').update(JSON.stringify([namespace, name])).digest('hex').slice(0, 20);
    const flat = `${namespace}__${name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 42) + '_' + hash;
    if (directNames.has(flat)) throw new Error('API用のツール名が重複しています。');
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
      if (fn.type !== 'function' || typeof fn.name !== 'string') throw new Error('この形式の名前空間ツールを使用できません。');
      return { ...fn, name: functionName(fn.name, string(tool.name)),
        description: [tool.description, fn.description].filter(value => typeof value === 'string' && value).join('\n\n') };
    });
  });
  if (Array.isArray(raw.input)) body.input = raw.input.filter(item => !options.discardReasoningInput || object(item).type !== 'reasoning').map(call);
  const choice = object(raw.tool_choice);
  if (choice.type === 'function' && typeof choice.namespace === 'string' && typeof choice.name === 'string') {
    const { namespace, ...rest } = choice;
    body.tool_choice = { ...rest, name: functionName(choice.name, namespace) };
  }
  if (options.discardReasoning) delete body.reasoning;
  if (options.stateless) {
    if (raw.previous_response_id || raw.conversation) throw new Error('会話履歴をinputに含めて送信してください。');
    body.store = false;
  }
  const hasImage = (value: unknown): boolean => Array.isArray(value) ? value.some(hasImage)
    : !!value && typeof value === 'object' && (object(value).type === 'input_image' || Object.values(object(value)).some(hasImage));
  if (options.images === false && hasImage(body.input)) throw new Error('このモデルの画像入力は無効です。接続先設定を確認してください。');
  if (options.structuredOutput === false && ['json_schema', 'json_object'].includes(string(object(object(body.text).format).type)))
    throw new Error('このモデルの構造化出力は無効です。接続先設定を確認してください。');
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
