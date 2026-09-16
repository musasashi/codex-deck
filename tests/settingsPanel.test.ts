import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import type * as vscode from 'vscode';
import type { HuggingFaceCheck, HuggingFaceCheckPurpose } from '../src/core/huggingFaceCheck';
import { object, type JsonObject } from '../src/core/types';

const bundle = buildSync({ entryPoints: [path.resolve('src/ui/settingsPanel.ts')], bundle: true, write: false,
  platform: 'node', format: 'cjs', external: ['vscode'], logLevel: 'silent' }).outputFiles[0]!.text;
const nodeRequire = createRequire(path.resolve('package.json'));
const hf = { model: 'hf:fixture/model', effort: 'default', mode: 'read-only', pricing: { input: 1, output: 2 } };
const save = { type: 'saveSettings', scope: 'user', presets: [hf], titleModel: 'latest', titleEffort: 'lowest', requestId: 1 };

function harness(check: (model: string, purpose: HuggingFaceCheckPurpose, signal: AbortSignal) => Promise<HuggingFaceCheck>, scoped = false) {
  const updates: { key: string; value: unknown; target: number; uri?: string }[] = [];
  const values = new Map<string, Record<string, unknown>>();
  const sent: JsonObject[] = [];
  let receive!: (value: unknown) => Promise<void>, close!: () => void;
  const api = {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 }, ViewColumn: { Active: 1 },
    Uri: { joinPath: (uri: URL, ...parts: string[]) => new URL(`${uri}/${parts.join('/')}`) },
    workspace: {
      workspaceFolders: scoped ? [{ name: 'one', uri: new URL('file:///one') }, { name: 'two', uri: new URL('file:///two') }] : [],
      getConfiguration: (_section: string, uri?: URL) => ({ inspect: (key: string) => values.get(key), update: async (key: string, value: unknown, target: number) => {
        updates.push({ key, value, target, uri: uri?.toString() });
        values.set(key, { ...values.get(key), [target === 1 ? 'globalValue' : target === 2 ? 'workspaceValue' : 'workspaceFolderValue']: value });
      } }),
    },
    window: { createWebviewPanel: () => ({
      webview: { cspSource: 'test:', asWebviewUri: (uri: URL) => uri, onDidReceiveMessage: (fn: typeof receive) => { receive = fn; return { dispose() {} }; },
        postMessage: async (message: JsonObject) => { sent.push(message); return true; } },
      onDidDispose: (fn: () => void) => { close = fn; }, dispose: () => close(),
    }) },
  };
  const module = { exports: {} as typeof import('../src/ui/settingsPanel') };
  new Function('require', 'module', 'exports', bundle)((id: string) => id === 'vscode' ? api : nodeRequire(id), module, module.exports);
  const panel = new module.exports.SettingsPanel(new URL('file:///extension') as unknown as vscode.Uri,
    { loadModels: async () => [], checkProvider: (model, purpose, _providers, signal) => check(model, purpose, signal), providersChanged() {}, openCodexSettings: async () => {}, report() {} });
  panel.open();
  return { receive: (message: unknown) => receive(message), updates, sent, close: () => close() };
}
const passed = async (model: string, purpose: HuggingFaceCheckPurpose): Promise<HuggingFaceCheck> => ({ model, purpose, status: 'passed', message: '利用可' });

test('HF settings can be saved without credentials, prices or paid compatibility checks', async () => {
  const h = harness(async () => { throw new Error('Saving must never run inference'); });
  await h.receive({ ...save, presets: [{ ...hf, pricing: undefined }] });
  assert.equal(h.updates.length, 5);
  assert.equal(h.sent.at(-1)!.saved, true);
});

test('manual checks remain independent from saving duplicate presets and titles', async () => {
  let calls = 0;
  const h = harness(async (model, purpose) => { calls++; return passed(model, purpose); });
  await h.receive({ type: 'checkProviderModel', scope: 'user', model: hf.model, purpose: 'task', requestId: 1 });
  assert.equal(calls, 1); assert.deepEqual(h.updates, []);
  await h.receive({ ...save, presets: [hf, { ...hf, mode: 'workspace-write' }], titleModel: hf.model, titlePricing: hf.pricing, requestId: 2 });
  assert.equal(calls, 1); assert.equal(h.updates.length, 5);
  assert.equal(h.sent.at(-1)!.saved, true);
  await h.receive({ type: 'checkProviderModel', scope: 'user', model: hf.model, purpose: 'task', requestId: 3 });
  assert.equal(calls, 2, 'explicit rechecks must not use the cache');
});

test('invalid provider configuration is rejected before any setting is written', async () => {
  const h = harness(passed);
  await h.receive({ ...save, providers: [{ id: 'bad.id', name: 'invalid', baseUrl: 'https://example.test', models: [{ id: 'model' }] }] });
  assert.deepEqual(h.updates, []);
  assert.match(String(h.sent.at(-1)!.message), /接続先ID/);
});

test('external HTTP providers cannot be saved or checked through settings messages', async () => {
  let checks = 0;
  const h = harness(async (model, purpose) => { checks++; return passed(model, purpose); });
  for (const type of ['saveSettings', 'checkProviderModel']) {
    await h.receive({ ...save, type, model: 'responses:api:model',
      providers: [{ id: 'api', name: 'API', baseUrl: 'http://api.example/v1', models: [{ id: 'model' }] }] });
    assert.equal(h.sent.at(-1)!.type, 'settingsError');
    assert.match(String(h.sent.at(-1)!.message), /HTTPS/);
  }
  assert.deepEqual(h.updates, []);
  assert.equal(checks, 0);
});

test('manual API checks can be cancelled and closing settings also aborts them', async () => {
  for (const close of [false, true]) {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const h = harness(async (model, purpose, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve({ model, purpose, status: 'failed', message: '中止' }), { once: true }); started();
    }));
    const work = h.receive({ type: 'checkProviderModel', scope: 'user', model: hf.model, requestId: 1 }); await ready;
    if (close) h.close(); else await h.receive({ type: 'cancelProviderCheck', requestId: 1 });
    await work; assert.deepEqual(h.updates, []);
  }
});

for (const [scope, target] of [['user', 1], ['workspace', 2], ['folder:file:///two', 3]] as const) {
  test(`question presets save independently and reload in the ${scope} scope without inference`, async () => {
    const h = harness(async () => { throw new Error('No paid checks while saving'); }, true);
    const questions = [{ id: 'explain', name: '解説', prompt: '具体例で説明してください', settings: { ...hf, model: 'hf:other/model' } }];
    await h.receive({ ...save, scope, questionPresets: questions });
    assert.deepEqual(h.updates.find(update => update.key === 'questionPresets'), { key: 'questionPresets', value: questions, target,
      uri: target === 3 ? 'file:///two' : undefined });
    assert.deepEqual(h.sent.at(-1)?.questionPresets, questions);
    await h.receive({ ...save, scope, presets: [{ ...hf, mode: 'danger-full-access' }], questionPresets: questions });
    await h.receive({ type: 'loadSettings', scope });
    assert.deepEqual(h.sent.at(-1)?.questionPresets, questions);
  });
}

test('invalid questions are validated before any settings are written', async () => {
  const question = { id: 'ask', name: '質問', prompt: '説明して', settings: hf };
  for (const questionPresets of [[{ ...question, prompt: ' ' }], [question, question], [{ ...question, settings: { ...hf, pricing: { input: -1, output: 2 } } }]]) {
    const h = harness(passed);
    await h.receive({ ...save, questionPresets });
    assert.deepEqual(h.updates, []);
    assert.equal(h.sent.at(-1)?.type, 'settingsError');
    assert.match(String(h.sent.at(-1)?.message), /質問プリセット/);
  }
});
