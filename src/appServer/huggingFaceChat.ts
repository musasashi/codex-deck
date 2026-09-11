import { randomUUID } from 'node:crypto';
import { array, object, string, type JsonObject } from '../core/types';

function content(value: unknown): unknown {
  if (typeof value === 'string') return value;
  return array(value).map(value => {
    const part = object(value);
    if (part.type === 'input_text' || part.type === 'output_text') return { type: 'text', text: string(part.text) };
    if (part.type === 'input_image') return { type: 'image_url', image_url: { url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) } };
    throw new Error('HFに送信できない入力形式です。');
  });
}

/** HF's Chat API preserves reasoning_content across tool calls; its Responses API drops it. */
export function huggingFaceChatRequest(raw: JsonObject): JsonObject {
  const messages: JsonObject[] = [];
  let assistant: JsonObject | undefined;
  const current = () => assistant ??= { role: 'assistant', content: '', reasoning_content: '' };
  const flush = () => { if (assistant) messages.push(assistant); assistant = undefined; };
  if (raw.instructions) messages.push({ role: 'system', content: raw.instructions });
  const input = typeof raw.input === 'string' ? [{ type: 'message', role: 'user', content: raw.input }] : array(raw.input);
  for (const value of input) {
    const item = object(value);
    if (item.type === 'reasoning') {
      const parts = array(item.content).length ? array(item.content) : array(item.summary);
      current().reasoning_content = string(current().reasoning_content) + parts.map(part => string(object(part).text)).join('');
    } else if (item.type === 'function_call') {
      const message = current();
      message.tool_calls = [...array(message.tool_calls), { id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } }];
    } else if (item.type === 'function_call_output') {
      flush(); messages.push({ role: 'tool', tool_call_id: item.call_id, content: content(item.output) });
    } else if (item.type === 'message' || !item.type && item.role) {
      if (item.role === 'assistant') current().content = content(item.content);
      else { flush(); messages.push({ role: item.role === 'developer' ? 'system' : item.role, content: content(item.content) }); }
    } else throw new Error(`HFに送信できない履歴形式です: ${string(item.type)}`);
  }
  flush();
  const body: JsonObject = { model: raw.model, messages, stream: raw.stream === true };
  if (body.stream) body.stream_options = { include_usage: true };
  if (raw.tools) body.tools = array(raw.tools).map(value => {
    const { type, ...fn } = object(value);
    if (type !== 'function') throw new Error('HFでは関数形式のツールを使用してください。');
    return { type, function: fn };
  });
  if (raw.tool_choice) {
    const choice = object(raw.tool_choice);
    body.tool_choice = choice.type === 'function' ? { type: 'function', function: { name: choice.name } } : raw.tool_choice;
  }
  for (const key of ['parallel_tool_calls', 'temperature', 'top_p'] as const) if (raw[key] !== undefined) body[key] = raw[key];
  if (raw.max_output_tokens !== undefined) body.max_tokens = raw.max_output_tokens;
  const format = object(object(raw.text).format);
  if (format.type === 'json_schema') { const { type, ...schema } = format; body.response_format = { type, json_schema: schema }; }
  else if (format.type === 'json_object') body.response_format = { type: 'json_object' };
  return body;
}

/** Convert a Chat stream to the Responses events consumed by the Codex CLI. */
export class HuggingFaceChatResponse {
  private readonly id = `resp_${randomUUID()}`;
  private readonly created = Math.floor(Date.now() / 1000);
  private items: JsonObject[] = [];
  private reasoning?: JsonObject;
  private message?: JsonObject;
  private calls = new Map<number, JsonObject>();
  private finishReason = '';
  private usage: JsonObject = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  private started = false;
  private ended = false;
  constructor(private readonly model: string) {}
  private response(status: string): JsonObject { return { id: this.id, object: 'response', created_at: this.created, model: this.model, status, output: this.items, usage: this.usage }; }
  private index(item: JsonObject): number { return this.items.indexOf(item); }

  push(raw: unknown): JsonObject[] {
    if (this.ended) throw new Error('HFストリームは完了しています。');
    const chunk = object(raw);
    if (chunk.error) throw new Error(string(object(chunk.error).message, 'HFでの推論に失敗しました。'));
    const events: JsonObject[] = [];
    if (!this.started) { this.started = true; events.push({ type: 'response.created', response: { ...this.response('in_progress'), output: [] } }); }
    const usage = object(chunk.usage);
    if (typeof usage.prompt_tokens === 'number') this.usage = { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens, input_tokens_details: { cached_tokens: object(usage.prompt_tokens_details).cached_tokens ?? 0 },
      output_tokens_details: { reasoning_tokens: object(usage.completion_tokens_details).reasoning_tokens ?? 0 } };
    for (const rawChoice of array(chunk.choices)) {
      const choice = object(rawChoice);
      if (choice.index !== undefined && choice.index !== 0) continue;
      const delta = object(choice.delta);
      const reasoning = string(delta.reasoning_content) || string(delta.reasoning);
      if (reasoning) {
        if (!this.reasoning) {
          this.reasoning = { type: 'reasoning', id: `rs_${randomUUID()}`, summary: [], content: [{ type: 'reasoning_text', text: '' }], encrypted_content: null };
          this.items.push(this.reasoning);
          events.push({ type: 'response.output_item.added', output_index: this.index(this.reasoning), item: structuredClone(this.reasoning) });
        }
        const part = object(array(this.reasoning.content)[0]); part.text = string(part.text) + reasoning;
        events.push({ type: 'response.reasoning_text.delta', item_id: this.reasoning.id, output_index: this.index(this.reasoning), content_index: 0, delta: reasoning });
      }
      const text = string(delta.content) || string(delta.refusal);
      if (text) {
        if (!this.message) {
          this.message = { type: 'message', id: `msg_${randomUUID()}`, role: 'assistant', status: 'in_progress', content: [{ type: 'output_text', text: '', annotations: [] }] };
          this.items.push(this.message);
          events.push({ type: 'response.output_item.added', output_index: this.index(this.message), item: { ...this.message, content: [] } },
            { type: 'response.content_part.added', item_id: this.message.id, output_index: this.index(this.message), content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        }
        const part = object(array(this.message.content)[0]); part.text = string(part.text) + text;
        events.push({ type: 'response.output_text.delta', item_id: this.message.id, output_index: this.index(this.message), content_index: 0, delta: text });
      }
      for (const rawCall of array(delta.tool_calls)) {
        const call = object(rawCall); const index = typeof call.index === 'number' ? call.index : 0;
        let item = this.calls.get(index);
        if (!item) { item = { type: 'function_call', id: `fc_${randomUUID()}`, call_id: '', name: '', arguments: '' }; this.calls.set(index, item); this.items.push(item); }
        if (call.id) item.call_id = call.id;
        const fn = object(call.function);
        item.name = string(item.name) + string(fn.name); item.arguments = string(item.arguments) + string(fn.arguments);
      }
      if (choice.finish_reason) this.finishReason = string(choice.finish_reason);
    }
    return events;
  }

  finish(): JsonObject[] {
    if (this.ended || !this.finishReason) throw new Error('HFストリームが応答の完了前に終了しました。');
    this.ended = true;
    const events: JsonObject[] = [];
    for (const item of this.items) {
      const index = this.index(item);
      if (item.type === 'function_call') {
        if (!item.call_id || !item.name) throw new Error('HFから不完全なツール呼び出しを受信しました。');
        events.push({ type: 'response.output_item.added', output_index: index, item: { ...item, arguments: '' } },
          { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: index, delta: item.arguments },
          { type: 'response.function_call_arguments.done', item_id: item.id, output_index: index, arguments: item.arguments });
      } else if (item.type === 'message') {
        item.status = 'completed'; const part = array(item.content)[0];
        events.push({ type: 'response.output_text.done', item_id: item.id, output_index: index, content_index: 0, text: object(part).text },
          { type: 'response.content_part.done', item_id: item.id, output_index: index, content_index: 0, part });
      }
      events.push({ type: 'response.output_item.done', output_index: index, item });
    }
    const incomplete = this.finishReason === 'length' || this.finishReason === 'content_filter';
    const response = this.response(incomplete ? 'incomplete' : 'completed');
    if (incomplete) response.incomplete_details = { reason: this.finishReason === 'length' ? 'max_output_tokens' : 'content_filter' };
    events.push({ type: incomplete ? 'response.incomplete' : 'response.completed', response });
    return events;
  }

  static fromJson(raw: unknown, model: string): JsonObject {
    const value = object(raw); const choice = object(array(value.choices)[0]); const message = object(choice.message);
    const response = new HuggingFaceChatResponse(model);
    response.push({ usage: value.usage, choices: [{ index: 0, finish_reason: choice.finish_reason,
      delta: { ...message, tool_calls: array(message.tool_calls).map((value, index) => ({ ...object(value), index })) } }] });
    return object(response.finish().at(-1)?.response);
  }
}
