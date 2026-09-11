import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { HuggingFaceProxy } from '../src/appServer/huggingFaceProxy';
import { checkHuggingFaceModel } from '../src/appServer/huggingFaceCheck';
import { array, object, type JsonObject } from '../src/core/types';
import { hfEchoCall, hfMessage, hfReasoning, sendHfResponse } from './fixtures/hfResponses';

async function harness(t: TestContext, failure = '') {
  const requests: JsonObject[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/v1/responses', 'checks must use the same Responses route as tasks');
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = object(JSON.parse(Buffer.concat(chunks).toString())); requests.push(body);
    assert.equal(body.reasoning, undefined);
    assert.equal(body.stream, true); assert.equal(body.max_output_tokens, 1024);
    assert.ok(array(body.input).every(item => object(item).type !== 'reasoning'));
    const n = requests.length;
    if (failure === 'authorization') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"Token hf_private_test_token rejected"}}'); return; }
    if (failure === 'continuation' && n === 3) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"type":"response.failed","response":{"status":"failed","error":{"message":"reasoning history required"}}}\n\n'); return; }
    let output: JsonObject[];
    if (n === 1) output = [hfMessage(failure === 'title' ? 'Not JSON' : '{"title":"接続検証"}')];
    else if (n === 2) {
      assert.equal(body.tool_choice, 'auto', 'checks must not require forced tool selection that normal tasks do not use');
      const tool = object(array(body.tools)[0]);
      assert.equal(tool.type, 'function');
      output = failure === 'tools' ? [hfMessage('Cannot use tools')] : [hfReasoning, hfEchoCall(tool.name)];
    } else {
      assert.ok(array(body.input).some(item => object(item).type === 'function_call_output' && object(item).output === 'HF tool OK'));
      output = failure === 'repeat' ? [hfEchoCall(object(array(body.tools)[0]).name)] : [hfMessage(failure === 'format' ? '**HF tool OK**.' : 'HF tool OK')];
    }
    sendHfResponse(res, output, failure === 'usage' ? { input_tokens: 0, output_tokens: 0 } : undefined);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const proxy = new HuggingFaceProxy(`http://127.0.0.1:${address.port}/v1`);
  await proxy.start('hf_fixture');
  t.after(() => { proxy.dispose(); server.closeAllConnections(); server.close(); });
  const check = (purpose: 'task' | 'title' = 'task') => proxy.check('hf:fixture/model', purpose, new AbortController().signal, () => {});
  return { check, requests };
}

test('HF compatibility checks run a JSON title and a namespaced tool round trip through the task adapter', async t => {
  const h = await harness(t);
  const result = await h.check();
  assert.equal(result.status, 'passed', result.message);
  assert.equal(h.requests.length, 3);
  assert.equal(object(h.requests[0]!.text).format, undefined, 'JSON Schema support is not required for title generation');
});

for (const [failure, expected, calls] of [['authorization', /HTTP 401/, 1], ['title', /JSON応答/, 1], ['tools', /ツールを正しく/, 2],
  ['continuation', /会話継続.*reasoning history required/, 3], ['repeat', /ツールが再度呼び出され/, 3], ['usage', /利用額を計算できません/, 3]] as const) {
  test(`HF checks fail with an actionable reason for ${failure}`, async t => {
    const h = await harness(t, failure);
    const result = await h.check();
    assert.equal(result.status, 'failed'); assert.match(result.message, expected);
    assert.equal(h.requests.length, calls); assert.ok(!result.message.includes('hf_private_test_token'));
  });
}

test('minor formatting of a returned confirmation does not cause a compatibility failure', async t => {
  const h = await harness(t, 'format');
  assert.equal((await h.check()).status, 'passed');
});

test('HF title-only checks do not require function calling', async t => {
  const h = await harness(t, 'tools');
  assert.equal((await h.check('title')).status, 'passed'); assert.equal(h.requests.length, 1);
});

test('missing tokens and malformed model IDs fail before sending inference', async () => {
  const proxy = new HuggingFaceProxy();
  assert.match((await proxy.check('hf:fixture/model', 'task', new AbortController().signal, () => {})).message, /HF_TOKEN/);
  const result = await checkHuggingFaceModel('hf:invalid', 'task', async () => { throw new Error('must not send'); }, new AbortController().signal);
  assert.match(result.message, /モデルID/);
});

test('cancellation prevents further check requests and non-streaming success is not accepted', async () => {
  const controller = new AbortController();
  const pending = checkHuggingFaceModel('hf:fixture/model', 'task', async (_body, signal) => new Promise<Response>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    controller.abort();
  }), controller.signal);
  assert.match((await pending).message, /中止/);
  const result = await checkHuggingFaceModel('hf:fixture/model', 'task', async () => Response.json({ status: 'completed' }), new AbortController().signal);
  assert.equal(result.status, 'failed'); assert.match(result.message, /ストリーミング/);
  const limited = await checkHuggingFaceModel('hf:fixture/model', 'task', async () => new Response('Too many requests', { status: 429 }), new AbortController().signal);
  assert.match(limited.message, /HTTP 429/);
});
