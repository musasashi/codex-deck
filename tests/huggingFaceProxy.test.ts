import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { HuggingFaceProxy } from '../src/appServer/huggingFaceProxy';
import { hfEvents, hfMessage } from './fixtures/hfResponses';

async function harness(t: TestContext, handle: RequestListener) {
  const upstream = createServer(handle);
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const proxy = new HuggingFaceProxy(`http://127.0.0.1:${address.port}/v1`);
  const base = await proxy.start('hf_proxy_fixture');
  t.after(() => { proxy.dispose(); upstream.closeAllConnections(); upstream.close(); });
  const post = (body: unknown, extra: Record<string, string> = {}) => fetch(`${base}/responses`, { method: 'POST',
    headers: { authorization: 'Bearer hf_proxy_fixture', 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
  return { proxy, base, post };
}

test('the HF adapter streams fragmented UTF-8/SSE and restores tool identities through completion', async t => {
  let request: Record<string, any> = {};
  const h = await harness(t, async (req, res) => {
    assert.equal(req.url, '/v1/responses');
    assert.equal(req.headers.authorization, 'Bearer hf_proxy_fixture');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    request = JSON.parse(Buffer.concat(chunks).toString());
    const frames = hfEvents([hfMessage('日本語'), { type: 'function_call', id: 'item', call_id: 'call-1', name: request.tools[0].name, arguments: '{"text":"日本語"}' }], { input_tokens: 4, output_tokens: 3, total_tokens: 7 });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const bytes = Buffer.from(frames.map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('') + 'data: [DONE]\n\n');
    const split = bytes.indexOf(Buffer.from('日')) + 1;
    res.write(bytes.subarray(0, split));
    await new Promise(resolve => setImmediate(resolve));
    res.end(bytes.subarray(split));
  });
  const response = await h.post({ reasoning: { effort: 'max' }, stream: true,
    tools: [{ type: 'namespace', name: 'fixture', tools: [{ type: 'function', name: 'echo', parameters: { type: 'object' } }] }] });
  assert.equal(response.status, 200);
  const events = (await response.text()).split('\n\n').flatMap(frame => frame.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6))));
  assert.equal(request.reasoning, undefined);
  assert.equal(request.tools[0].type, 'function');
  const call = events.find(event => event.type === 'response.output_item.done' && event.item.type === 'function_call').item;
  assert.equal(call.name, 'echo'); assert.equal(call.namespace, 'fixture');
  assert.equal(events.find(event => event.type === 'response.function_call_arguments.delta').delta, '{"text":"日本語"}');
  const completed = events.find(event => event.type === 'response.completed').response;
  assert.equal(completed.output.find((item: { type: string }) => item.type === 'function_call').namespace, 'fixture');
  assert.equal(completed.usage.input_tokens, 4); assert.equal(completed.usage.output_tokens, 3);
});

test('only authenticated Responses requests reach HF; upstream failures preserve status and retry information', async t => {
  let calls = 0;
  const h = await harness(t, (_req, res) => { calls++; res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' }); res.end('{"error":{"message":"quota"}}'); });
  assert.equal((await h.post({}, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await fetch(`${h.base}/elsewhere`, { headers: { authorization: 'Bearer hf_proxy_fixture' } })).status, 404);
  assert.equal(calls, 0);
  const response = await h.post({});
  assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '2');
  assert.deepEqual(await response.json(), { error: { message: 'quota' } }); assert.equal(calls, 1);
});

test('non-streaming responses restore tools and closing the adapter cancels in-flight upstream requests', async t => {
  let closed!: () => void;
  const cancelled = new Promise<void>(resolve => { closed = resolve; });
  let hanging = false;
  const h = await harness(t, async (req, res) => {
    if (hanging) { res.once('close', closed); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n'); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'completed', output: [{ type: 'function_call', name: body.tools[0].name, call_id: 'call', arguments: '{}' }] }));
  });
  const response = await h.post({ tools: [{ type: 'namespace', name: 'fixture', tools: [{ type: 'function', name: 'echo', parameters: {} }] }] });
  const result = await response.json() as { output: { name: string; namespace: string; arguments: string }[] };
  assert.equal(result.output[0]!.name, 'echo'); assert.equal(result.output[0]!.namespace, 'fixture'); assert.equal(result.output[0]!.arguments, '{}');
  hanging = true;
  const pending = await h.post({ stream: true });
  const read = pending.text();
  h.proxy.dispose();
  await assert.rejects(read);
  await cancelled;
});

test('HF streams without a terminal event fail instead of reporting a completed answer', async t => {
  const h = await harness(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"type":"response.created"}\n\n'); });
  await assert.rejects(async () => (await h.post({ stream: true })).text());
});
