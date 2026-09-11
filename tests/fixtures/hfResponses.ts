import type { ServerResponse } from 'node:http';
import { array, object, string, type JsonObject } from '../../src/core/types';

export const hfUsage = { input_tokens: 100, output_tokens: 12, total_tokens: 112 };
export const hfMessage = (text: string): JsonObject => ({ type: 'message', id: 'msg_fixture', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
export const hfReasoning: JsonObject = { type: 'reasoning', id: 'rs_fixture', summary: [], content: [{ type: 'reasoning_text', text: 'Run the connectivity test.' }] };

export function hfEvents(output: JsonObject[], usage: JsonObject = hfUsage): JsonObject[] {
  const response = { id: 'resp_fixture', object: 'response', created_at: 1, status: 'in_progress', model: 'fixture/model', output: [] };
  const events: JsonObject[] = [{ type: 'response.created', response }];
  for (const [output_index, item] of output.entries()) {
    events.push({ type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress', ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }) } });
    if (item.type === 'function_call') {
      events.push({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index, delta: item.arguments });
      events.push({ type: 'response.function_call_arguments.done', item_id: item.id, output_index, arguments: item.arguments });
    }
    for (const [content_index, part] of array(item.content).map(object).entries()) {
      events.push({ type: 'response.content_part.added', item_id: item.id, output_index, content_index, part: { ...part, text: '' } });
      const type = part.type === 'reasoning_text' ? 'response.reasoning_text' : 'response.output_text';
      events.push({ type: `${type}.delta`, item_id: item.id, output_index, content_index, delta: part.text });
      events.push({ type: `${type}.done`, item_id: item.id, output_index, content_index, text: part.text });
      events.push({ type: 'response.content_part.done', item_id: item.id, output_index, content_index, part });
    }
    events.push({ type: 'response.output_item.done', output_index, item });
  }
  events.push({ type: 'response.completed', response: { ...response, status: 'completed', output, usage } });
  return events.map((event, sequence_number) => ({ ...event, sequence_number }));
}

export function sendHfResponse(res: ServerResponse, output: JsonObject[], usage: JsonObject = hfUsage): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(hfEvents(output, usage).map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}

export function hfEchoCall(name: unknown): JsonObject {
  return { type: 'function_call', id: 'fc_fixture', status: 'completed', call_id: 'call_fixture', name: string(name), arguments: '{"text":"test"}' };
}
