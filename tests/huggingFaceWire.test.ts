import test from 'node:test';
import assert from 'node:assert/strict';
import { huggingFaceRequest } from '../src/appServer/huggingFaceWire';
import { array, object, string } from '../src/core/types';

const fn = { type: 'function', name: 'search', description: 'Search records.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };
const namespace = (name: string) => ({ type: 'namespace', name, description: `Tools for ${name}.`, tools: [fn] });

test('HF requests omit inherited effort and flatten namespaces without changing function schemas or the original request', () => {
  const raw = { model: 'org/model:provider', reasoning: { effort: 'max' }, tools: [fn, namespace('crm'), namespace('billing')] };
  const snapshot = structuredClone(raw);
  const { body, restore } = huggingFaceRequest(raw);
  assert.equal(body.reasoning, undefined);
  assert.equal(body.model, raw.model);
  const tools = array(body.tools).map(object);
  assert.equal(tools.length, 3);
  assert.deepEqual(tools[0], fn);
  assert.ok(tools.every(tool => tool.type === 'function'));
  assert.notEqual(tools[1]!.name, tools[2]!.name);
  for (const tool of tools.slice(1)) {
    assert.deepEqual(tool.parameters, fn.parameters);
    assert.match(string(tool.name), /^[a-zA-Z0-9_-]{1,64}$/);
    assert.match(string(tool.description), /Search records/);
  }
  assert.deepEqual(restore({ type: 'function_call', name: tools[1]!.name, call_id: 'call', arguments: '{"query":"hello"}' }),
    { type: 'function_call', namespace: 'crm', name: 'search', call_id: 'call', arguments: '{"query":"hello"}' });
  assert.deepEqual(raw, snapshot);
});

test('history and tool choice use stable function names and retain tools that are no longer advertised', () => {
  const original = { type: 'function_call', namespace: 'crm', name: 'search', call_id: 'old-call', arguments: '{}' };
  const { body, restore } = huggingFaceRequest({ tools: [namespace('billing')], input: [original, { type: 'function_call_output', call_id: 'old-call', output: 'data' }],
    tool_choice: { type: 'function', namespace: 'crm', name: 'search' } });
  const history = object(array(body.input)[0]);
  const current = object(array(huggingFaceRequest({ tools: [namespace('crm')] }).body.tools)[0]);
  assert.equal(history.namespace, undefined);
  assert.equal(history.name, current.name);
  assert.equal(object(body.tool_choice).name, current.name);
  assert.equal(object(body.tool_choice).namespace, undefined);
  assert.deepEqual(restore(history), original);
  assert.deepEqual(array(body.input)[1], { type: 'function_call_output', call_id: 'old-call', output: 'data' });
});

test('streaming items and final response outputs restore the same tool identity and preserve text deltas', () => {
  const { body, restore } = huggingFaceRequest({ tools: [namespace('crm')] });
  const item = { type: 'function_call', id: 'item', name: object(array(body.tools)[0]).name, call_id: 'call', arguments: '{}' };
  for (const type of ['response.output_item.added', 'response.output_item.done']) {
    const event = object(restore({ type, item }));
    assert.equal(object(event.item).name, 'search'); assert.equal(object(event.item).namespace, 'crm');
    assert.equal(object(event.item).call_id, 'call'); assert.equal(event.type, type);
  }
  const event = object(restore({ type: 'response.completed', response: { output: [item], usage: { input_tokens: 12, output_tokens: 4 } } }));
  assert.equal(object(array(object(event.response).output)[0]).namespace, 'crm');
  assert.deepEqual(object(event.response).usage, { input_tokens: 12, output_tokens: 4 });
  assert.deepEqual(restore({ type: 'response.output_text.delta', delta: '日本語' }), { type: 'response.output_text.delta', delta: '日本語' });
});

test('long and similarly named namespaces stay distinct; unsupported tools fail explicitly', () => {
  const tools = array(huggingFaceRequest({ tools: [namespace('a'.repeat(100)), namespace('a'.repeat(99) + 'b'), namespace('a__b'),
    { type: 'namespace', name: 'a', tools: [{ ...fn, name: 'b__search' }] }] }).body.tools).map(object);
  assert.equal(new Set(tools.map(tool => tool.name)).size, 4);
  assert.ok(tools.every(tool => string(tool.name).length <= 64));
  assert.throws(() => huggingFaceRequest({ tools: [{ type: 'namespace', name: 'custom', tools: [{ type: 'custom', name: 'patch' }] }] }), /形式/);
  assert.deepEqual(huggingFaceRequest({ reasoning: { effort: 'high', summary: 'concise' } }).body, { reasoning: { summary: 'concise' } });
  assert.deepEqual(huggingFaceRequest({ reasoning: { effort: 'max', summary: 'none' } }).body, {});
});
