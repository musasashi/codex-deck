import test from 'node:test';
import assert from 'node:assert/strict';
import { huggingFaceChatRequest, HuggingFaceChatResponse } from '../src/appServer/huggingFaceChat';
import { array, object } from '../src/core/types';

test('Chat requests retain reasoning with parallel tool calls and their matching results', () => {
  const body = huggingFaceChatRequest({ model: 'org/model', instructions: 'System instruction', stream: true,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Test' }] },
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'Use two tools.' }], summary: [] },
      { type: 'function_call', call_id: 'one', name: 'first', arguments: '{}' },
      { type: 'function_call', call_id: 'two', name: 'second', arguments: '{}' },
      { type: 'function_call_output', call_id: 'two', output: 'Second result' },
      { type: 'function_call_output', call_id: 'one', output: 'First result' },
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'Both done.' }], summary: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] },
      { type: 'message', role: 'user', content: 'Next' },
    ] });
  const messages = array(body.messages).map(object);
  assert.equal(messages[0]!.role, 'system');
  assert.equal(messages[2]!.reasoning_content, 'Use two tools.');
  assert.deepEqual(array(messages[2]!.tool_calls).map(call => object(call).id), ['one', 'two']);
  assert.equal(messages[3]!.tool_call_id, 'two'); assert.equal(messages[4]!.tool_call_id, 'one');
  assert.equal(messages[5]!.reasoning_content, 'Both done.');
  assert.equal(messages[6]!.role, 'user');
  assert.deepEqual(body.stream_options, { include_usage: true });
});

test('Chat requests map function selection, schemas and multimodal tool results without forwarding Codex metadata', () => {
  const fn = { type: 'function', name: 'echo', parameters: { type: 'object' }, strict: false };
  const format = { type: 'json_schema', name: 'title', strict: true, schema: { type: 'object' } };
  const body = huggingFaceChatRequest({ model: 'org/model', tools: [fn], tool_choice: { type: 'function', name: 'echo' },
    max_output_tokens: 64, text: { format }, client_metadata: { private: 'not sent' },
    input: [{ type: 'function_call_output', call_id: 'image', output: [{ type: 'input_text', text: 'Result' }, { type: 'input_image', image_url: 'data:image/png;base64,fixture' }] }] });
  assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'echo', parameters: { type: 'object' }, strict: false } }]);
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'echo' } });
  assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'title', strict: true, schema: { type: 'object' } } });
  assert.equal(body.max_tokens, 64); assert.equal(body.client_metadata, undefined);
  assert.deepEqual(object(array(body.messages)[0]).content, [{ type: 'text', text: 'Result' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }]);
  assert.throws(() => huggingFaceChatRequest({ input: [{ type: 'compaction', encrypted_content: 'opaque' }] }), /履歴形式/);
});

test('Chat streams preserve reasoning, fragmented parallel functions and usage after the finish marker', () => {
  const response = new HuggingFaceChatResponse('org/model');
  const events = [
    ...response.push({ choices: [{ index: 0, delta: { reasoning_content: 'Think ' } }] }),
    ...response.push({ choices: [{ index: 0, delta: { reasoning_content: 'once.', tool_calls: [
      { index: 0, id: 'one', function: { name: 'fir', arguments: '{' } }, { index: 1, id: 'two', function: { name: 'second', arguments: '{}' } },
    ] } }] }),
    ...response.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'st', arguments: '}' } }] }, finish_reason: 'tool_calls' }] }),
    ...response.push({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } } }),
    ...response.finish(),
  ];
  const done = object(events.at(-1)!.response);
  const output = array(done.output).map(object);
  assert.equal(object(array(output[0]!.content)[0]).text, 'Think once.');
  assert.deepEqual(output.filter(item => item.type === 'function_call').map(({ name, call_id, arguments: args }) => ({ name, call_id, args })),
    [{ name: 'first', call_id: 'one', args: '{}' }, { name: 'second', call_id: 'two', args: '{}' }]);
  assert.deepEqual(done.usage, { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } });
  assert.equal(events.filter(event => event.type === 'response.completed').length, 1);
  assert.throws(() => response.finish(), /完了前/);
});

test('Chat text streams and JSON responses retain text, while interrupted or limited streams cannot report success', () => {
  const response = new HuggingFaceChatResponse('org/model');
  const first = response.push({ choices: [{ delta: { content: '日本' } }] });
  const next = response.push({ choices: [{ delta: { content: '語' }, finish_reason: 'stop' }] });
  assert.equal(first.find(event => event.type === 'response.output_text.delta')?.delta, '日本');
  assert.equal(next[0]?.delta, '語');
  const done = object(response.finish().at(-1)?.response);
  assert.equal(object(array(object(array(done.output)[0]).content)[0]).text, '日本語');
  const json = HuggingFaceChatResponse.fromJson({ choices: [{ message: { content: '{"title":"Test"}', reasoning_content: 'Make a title.' }, finish_reason: 'stop' }] }, 'org/model');
  assert.equal(array(json.output).length, 2);
  const interrupted = new HuggingFaceChatResponse('org/model');
  interrupted.push({ choices: [{ delta: { content: 'Partial' } }] });
  assert.throws(() => interrupted.finish(), /完了前/);
  const limited = new HuggingFaceChatResponse('org/model');
  limited.push({ choices: [{ delta: { content: 'Partial' }, finish_reason: 'length' }] });
  assert.equal(limited.finish().at(-1)?.type, 'response.incomplete');
});
