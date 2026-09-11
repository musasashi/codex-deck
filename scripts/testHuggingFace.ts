import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { StdioConnection } from '../src/appServer/rpc';
import { HuggingFaceProxy } from '../src/appServer/huggingFaceProxy';
import { TitleGenerator } from '../src/appServer/titleGenerator';
import { HF_MODEL_CONFIG, HF_PROVIDER } from '../src/core/huggingFace';
import { array, object, string, type JsonObject } from '../src/core/types';
import { hfEchoCall, hfMessage, hfReasoning, sendHfResponse } from '../tests/fixtures/hfResponses';

async function main(): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'codex-deck-hf-integration-'));
  let calls = 0, toolCalled = false;
  const failures: unknown[] = [];
  const server = createServer((req, res) => { void (async () => {
    assert.equal(req.url, '/v1/responses');
    assert.equal(req.headers.authorization, 'Bearer hf_local_fixture');
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = object(JSON.parse(Buffer.concat(chunks).toString()));
    assert.equal(body.reasoning, undefined);
    assert.ok(array(body.input).every(item => object(item).type !== 'reasoning'));
    assert.ok(array(body.tools).every(tool => object(tool).type === 'function'));
    const current = ++calls;
    if (current === 1) {
      const tool = array(body.tools).map(object).find(tool => string(tool.name).startsWith('deck_probe__echo'))!;
      assert.ok(tool);
      sendHfResponse(res, [hfReasoning, hfEchoCall(tool.name)]);
    } else {
      if (current === 2) {
        const input = array(body.input).map(object);
        assert.ok(input.some(item => item.type === 'function_call' && item.call_id === 'call_fixture'));
        assert.ok(input.some(item => item.type === 'function_call_output' && item.output === 'HF tool OK'));
      } else assert.equal(object(body.text).format, undefined, 'HF titles validate JSON locally without requiring provider-specific schema support');
      sendHfResponse(res, [hfMessage(current === 2 ? 'HF tool OK' : '{"title":"HF接続検証"}')]);
    }
  })().catch(error => { failures.push(error); res.destroy(); }); });
  const connection = new StdioConnection(() => undefined);
  let proxy: HuggingFaceProxy | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    proxy = new HuggingFaceProxy(`http://127.0.0.1:${address.port}/v1`);
    const url = await proxy.start('hf_local_fixture');
    const peer = connection.start(process.env.CODEX_DECK_CLI ?? 'codex', cwd, { ...process.env, HF_TOKEN: 'hf_local_fixture' }, url);
    peer.handleRequest = async ({ method, params }) => {
      const call = object(params);
      assert.equal(method, 'item/tool/call'); assert.equal(call.namespace, 'deck_probe'); assert.equal(call.tool, 'echo');
      assert.deepEqual(call.arguments, { text: 'test' }); toolCalled = true;
      return { success: true, contentItems: [{ type: 'inputText', text: 'HF tool OK' }] };
    };
    await peer.request('initialize', { clientInfo: { name: 'codex_deck_hf_test', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    peer.notify('initialized');
    const config = object(object(await peer.request('config/read', { cwd, includeLayers: false })).config);
    const result = object(await peer.request('thread/start', { cwd, ephemeral: true, model: 'fixture/model', modelProvider: HF_PROVIDER,
      sandbox: 'read-only', approvalPolicy: 'never', serviceTier: null, baseInstructions: 'Run a connectivity test.', developerInstructions: '',
      dynamicTools: [{ type: 'namespace', name: 'deck_probe', description: 'Safe test tools.', tools: [{ type: 'function', name: 'echo', description: 'Echo a test input.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] }],
      config: { ...HF_MODEL_CONFIG, model_reasoning_effort: 'max', project_doc_max_bytes: 0,
        mcp_servers: Object.fromEntries(Object.keys(object(config.mcp_servers)).map(name => [name, { enabled: false, required: false }])),
        'features.apps': false, 'features.plugins': false, 'features.hooks': false, 'features.memories': false,
        'features.multi_agent': false, 'features.multi_agent_v2': false, 'features.shell_tool': false, 'features.shell_snapshot': false } }));
    const threadId = object(result.thread).id;
    const completed = new Promise<JsonObject>((resolve, reject) => {
      peer.notifications.subscribe(({ method, params }) => { const data = object(params); if (method === 'turn/completed' && data.threadId === threadId) resolve(object(data.turn)); });
      timer = setTimeout(() => reject(new Error('HF互換テストがタイムアウトしました。')), 20_000);
    });
    await peer.request('turn/start', { threadId, input: [{ type: 'text', text: 'Test the echo tool.', text_elements: [] }] });
    const turn = await completed; clearTimeout(timer);
    assert.deepEqual(failures, []); assert.equal(turn.status, 'completed'); assert.equal(toolCalled, true); assert.equal(calls, 2);
    const titles = new TitleGenerator(peer, async () => []);
    try { assert.equal(await titles.generate({ cwd, input: 'Test', model: 'hf:fixture/model', effort: 'lowest' }, new AbortController().signal), 'HF接続検証'); }
    finally { titles.dispose(); }
    assert.deepEqual(failures, []); assert.equal(calls, 3);
    console.log('実際のCodex CLIで、HF Responses API向けの設定補正・ツール往復・タスク名要約を確認しました。HFへの外部リクエストは送信していません。');
  } finally {
    clearTimeout(timer); connection.dispose(); proxy?.dispose(); server.closeAllConnections(); server.close();
    await rm(cwd, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
