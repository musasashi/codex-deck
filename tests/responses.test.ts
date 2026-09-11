import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ResponsesConnections } from '../src/appServer/responsesConnections';
import { responsesRequest } from '../src/appServer/responsesWire';
import { providerId, validateProviders } from '../src/core/providers';
import { array, object, string, type JsonObject } from '../src/core/types';
import { hfEchoCall, hfMessage, hfReasoning, sendHfResponse } from './fixtures/hfResponses';

test('the standard adapter retains reasoning history and gates optional capabilities without changing its input', () => {
  const raw = { input: [hfReasoning], reasoning: { effort: 'high' }, store: true };
  assert.deepEqual(responsesRequest(raw, { stateless: true }).body, { ...raw, store: false });
  assert.equal(raw.store, true);
  assert.deepEqual(responsesRequest(raw, { discardReasoning: true }).body.input, [hfReasoning]);
  assert.throws(() => responsesRequest({ previous_response_id: 'previous' }, { stateless: true }), /履歴/);
  const image = { input: [{ type: 'message', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] }] };
  assert.throws(() => responsesRequest(image, { images: false }), /画像入力/);
  assert.deepEqual(responsesRequest(image, { images: true }).body, image);
  assert.throws(() => responsesRequest({ text: { format: { type: 'json_schema' } } }, { structuredOutput: false }), /構造化出力/);
});

test('provider adapters separate credentials, allow local no-auth APIs, retain error statuses and reject unknown models', async t => {
  const requests: { authorization?: string; body: JsonObject }[] = [];
  const server = createServer((req, res) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ authorization: req.headers.authorization, body: object(JSON.parse(Buffer.concat(chunks).toString())) });
    res.writeHead(402, { 'content-type': 'application/json' }); res.end('{"error":{"message":"remote_secret_test: insufficient balance"}}');
  })().catch(() => res.destroy()); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const providers = validateProviders(['one', 'two'].map(id => ({ id, name: id, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: id === 'one' ? 'CUSTOM_KEY' : '', models: [{ id: 'model', reasoningEfforts: id === 'one' ? ['low', 'high'] : [] }] })));
  const connections = new ResponsesConnections(async () => ({ CUSTOM_KEY: 'remote_secret_test' }));
  t.after(() => { connections.dispose(); server.closeAllConnections(); server.close(); });
  const first = await connections.config('responses:one:model', providers), second = await connections.config('responses:two:model', providers);
  const one = object(object(first.model_providers)[providerId('one')]), two = object(object(second.model_providers)[providerId('two')]);
  assert.ok(!JSON.stringify(first).includes('remote_secret_test'));
  const post = (config: JsonObject, model = 'model', authorization = `Bearer ${config.experimental_bearer_token}`) => fetch(`${config.base_url}/responses`, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ model, input: 'Test', reasoning: { effort: 'high' } }),
  });
  assert.equal((await post(one, 'model', 'Bearer wrong')).status, 401);
  assert.equal((await post(one, 'unknown')).status, 400); assert.equal(requests.length, 0);
  const result = await post(one); assert.equal(result.status, 402); assert.ok(!(await result.text()).includes('remote_secret_test'));
  assert.equal((await post(two)).status, 402);
  assert.equal(requests[0]!.authorization, 'Bearer remote_secret_test'); assert.equal(requests[1]!.authorization, undefined);
  assert.equal(requests[0]!.body.reasoning, undefined); assert.equal(requests[0]!.body.store, false);
  assert.deepEqual(await connections.config('responses:one:model', providers), first, 'reuse an unchanged connection');
  const selected = await connections.config('responses:one:model', providers, 'low');
  assert.notDeepEqual(selected, first, 'concurrent tasks can use different efforts without changing an existing connection');
  await post(object(object(selected.model_providers)[providerId('one')]));
  assert.equal(object(requests[2]!.body.reasoning).effort, 'low', 'only send the selected effort, not the inherited Codex value');
  await assert.rejects(connections.config('responses:one:model', providers, 'medium'), /推論強度/);
});

test('custom compatibility checks use the same adapter and complete a tool round trip even without usage reporting', async t => {
  let calls = 0;
  const server = createServer((req, res) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = object(JSON.parse(Buffer.concat(chunks).toString()));
    const n = ++calls;
    if (n === 1) sendHfResponse(res, [hfMessage('{"title":"接続確認"}')], {});
    else if (n === 2) sendHfResponse(res, [hfReasoning, hfEchoCall(object(array(body.tools)[0]).name)], {});
    else {
      assert.ok(array(body.input).some(item => object(item).type === 'reasoning'));
      assert.ok(array(body.input).some(item => object(item).type === 'function_call_output' && object(item).output === 'Responses tool OK'));
      sendHfResponse(res, [hfMessage('Responses tool OK')], {});
    }
  })().catch(() => res.destroy()); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const providers = validateProviders([{ id: 'local', name: 'Local', baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [{ id: 'fixture/model' }] }]);
  const connections = new ResponsesConnections(async () => ({}));
  t.after(() => { connections.dispose(); server.closeAllConnections(); server.close(); });
  const result = await connections.check('responses:local:fixture/model', providers, 'task', new AbortController().signal, () => {});
  assert.equal(result.status, 'passed', result.message); assert.equal(calls, 3); assert.match(result.message, /費用は未計測/);
  const missing = new ResponsesConnections(async () => ({}));
  await assert.rejects(missing.config('responses:local:fixture/model', [{ ...providers[0]!, apiKeyEnv: 'MISSING_KEY' }]), /MISSING_KEY/);
  missing.dispose();
});
