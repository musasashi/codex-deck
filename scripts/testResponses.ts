import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { StdioConnection } from '../src/appServer/rpc';
import { ResponsesConnections } from '../src/appServer/responsesConnections';
import { TitleGenerator } from '../src/appServer/titleGenerator';
import { externalModelConfig, modelRequest, providerModels, responsesModelId, validateProviders } from '../src/core/providers';
import { array, object, string, type JsonObject } from '../src/core/types';
import { hfEchoCall, hfMessage, hfReasoning, sendHfResponse } from '../tests/fixtures/hfResponses';

async function main(): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'codex-deck-responses-'));
  let calls = 0, toolCalled = false;
  const failures: unknown[] = [];
  const server = createServer((req, res) => { void (async () => {
    assert.equal(req.url, '/v1/responses');
    assert.equal(req.headers.authorization, 'Bearer fixture_remote_key');
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = object(JSON.parse(Buffer.concat(chunks).toString()));
    assert.equal(body.model, 'fixture/model'); assert.equal(body.store, false);
    const current = ++calls;
    if (current === 1) {
      assert.equal(object(body.reasoning).effort, 'high');
      const tool = array(body.tools).map(object).find(tool => string(tool.name).startsWith('deck_probe__echo'))!;
      assert.ok(tool); sendHfResponse(res, [hfReasoning, hfEchoCall(tool.name)]);
    } else {
      if (current === 2) assert.ok(array(body.input).some(item => object(item).type === 'function_call_output' && object(item).output === 'Responses tool OK'));
      if (current >= 3) assert.equal(object(body.text).format, undefined);
      if (current === 4) assert.equal(object(body.reasoning).effort, undefined, 'the provider default must not inherit Codex reasoning effort');
      sendHfResponse(res, [hfMessage(current === 2 ? 'Responses tool OK' : '{"title":"Responses接続検証"}')]);
    }
  })().catch(error => { failures.push(error); res.destroy(); }); });
  const connection = new StdioConnection(() => {});
  const proxies = new ResponsesConnections(async () => ({ FIXTURE_API_KEY: 'fixture_remote_key' }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const providers = validateProviders([{ id: 'fixture', name: 'Fixture API', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: 'FIXTURE_API_KEY',
      models: [{ id: 'fixture/model', reasoningEfforts: ['low', 'high'] }] }]);
    const model = responsesModelId('fixture', 'fixture/model');
    const config = await proxies.config(model, providers, 'high');
    assert.ok(!JSON.stringify(config).includes('fixture_remote_key'), 'the provider credential must stay out of Codex configuration');
    const peer = connection.start(process.env.CODEX_DECK_CLI ?? 'codex', cwd);
    peer.handleRequest = async ({ method, params }) => {
      const call = object(params); assert.equal(method, 'item/tool/call');
      assert.equal(call.namespace, 'deck_probe'); assert.equal(call.tool, 'echo'); assert.deepEqual(call.arguments, { text: 'test' });
      toolCalled = true; return { success: true, contentItems: [{ type: 'inputText', text: 'Responses tool OK' }] };
    };
    await peer.request('initialize', { clientInfo: { name: 'codex_deck_responses_test', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    peer.notify('initialized');
    const baseline = object(object(await peer.request('config/read', { cwd, includeLayers: false })).config);
    const result = object(await peer.request('thread/start', { cwd, ...modelRequest(model), ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', serviceTier: null,
      baseInstructions: 'Run a connectivity test.', developerInstructions: '',
      dynamicTools: [{ type: 'namespace', name: 'deck_probe', description: 'Safe test tools.', tools: [{ type: 'function', name: 'echo', description: 'Echo a test input.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] }],
      config: { ...externalModelConfig(model, providers, 'high'), ...config, project_doc_max_bytes: 0,
        mcp_servers: Object.fromEntries(Object.keys(object(baseline.mcp_servers)).map(name => [name, { enabled: false, required: false }])),
        'features.apps': false, 'features.plugins': false, 'features.hooks': false, 'features.memories': false,
        'features.multi_agent': false, 'features.multi_agent_v2': false, 'features.shell_tool': false, 'features.shell_snapshot': false } }));
    const threadId = object(result.thread).id;
    const completed = new Promise<JsonObject>((resolve, reject) => {
      peer.notifications.subscribe(({ method, params }) => { const data = object(params); if (method === 'turn/completed' && data.threadId === threadId) resolve(object(data.turn)); });
      timer = setTimeout(() => reject(new Error('Responses API互換テストがタイムアウトしました。')), 20_000);
    });
    await peer.request('turn/start', { threadId, input: [{ type: 'text', text: 'Test the echo tool.', text_elements: [] }] });
    const turn = await completed; clearTimeout(timer);
    assert.deepEqual(failures, []); assert.equal(turn.status, 'completed', JSON.stringify(turn.error)); assert.ok(toolCalled); assert.equal(calls, 2);
    const titles = new TitleGenerator(peer, async () => providerModels(providers), 20_000, () => providers, (id, effort) => proxies.config(id, providers, effort));
    try {
      assert.equal(await titles.generate({ cwd, input: 'Test', model, effort: 'lowest' }, new AbortController().signal), 'Responses接続検証');
      assert.equal(await titles.generate({ cwd, input: 'Test default effort', model, effort: 'default' }, new AbortController().signal), 'Responses接続検証');
    }
    finally { titles.dispose(); }
    assert.deepEqual(failures, []); assert.equal(calls, 4);
    console.log('実際のCodex CLIでResponses API接続先の登録・認証分離・ストリーミング・ツール往復・タスク名生成を確認しました。外部APIへのリクエストは送信していません。');
  } finally {
    clearTimeout(timer); connection.dispose(); proxies.dispose(); server.closeAllConnections(); server.close();
    await rm(cwd, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
