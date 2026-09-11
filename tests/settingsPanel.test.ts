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

function harness(check: (model: string, purpose: HuggingFaceCheckPurpose, signal: AbortSignal) => Promise<HuggingFaceCheck>) {
  const updates: { key: string; value: unknown }[] = [];
  const sent: JsonObject[] = [];
  let receive!: (value: unknown) => Promise<void>, close!: () => void;
  const api = {
    ConfigurationTarget: { Global: 1 }, ViewColumn: { Active: 1 },
    Uri: { joinPath: (uri: URL, ...parts: string[]) => new URL(`${uri}/${parts.join('/')}`) },
    workspace: { getConfiguration: () => ({ inspect: () => undefined, update: async (key: string, value: unknown) => { updates.push({ key, value }); } }) },
    window: { createWebviewPanel: () => ({
      webview: { cspSource: 'test:', asWebviewUri: (uri: URL) => uri, onDidReceiveMessage: (fn: typeof receive) => { receive = fn; return { dispose() {} }; },
        postMessage: async (message: JsonObject) => { sent.push(message); return true; } },
      onDidDispose: (fn: () => void) => { close = fn; }, dispose: () => close(),
    }) },
  };
  const module = { exports: {} as typeof import('../src/ui/settingsPanel') };
  new Function('require', 'module', 'exports', bundle)((id: string) => id === 'vscode' ? api : nodeRequire(id), module, module.exports);
  const panel = new module.exports.SettingsPanel(new URL('file:///extension') as unknown as vscode.Uri,
    { loadModels: async () => [], checkHuggingFace: check, openCodexSettings: async () => {}, report() {} });
  panel.open();
  return { receive: (message: unknown) => receive(message), updates, sent, close: () => close() };
}
const passed = async (model: string, purpose: HuggingFaceCheckPurpose): Promise<HuggingFaceCheck> => ({ model, purpose, status: 'passed', message: '利用可' });

test('failed HF validation blocks every settings write even when the webview claims a passed check', async () => {
  const h = harness(async (model, purpose) => ({ model, purpose, status: 'failed', message: 'ツール結果を処理できません' }));
  await h.receive({ ...save, checks: [{ model: hf.model, status: 'passed' }] });
  assert.deepEqual(h.updates, []);
  assert.match(String(h.sent.at(-1)!.message), /保存していません/);
  assert.equal(object(h.sent.find(message => message.type === 'hfCheckState')!.result).status, 'failed');
});

test('successful manual checks are reused for duplicate presets and titles on save', async () => {
  let calls = 0;
  const h = harness(async (model, purpose) => { calls++; return passed(model, purpose); });
  await h.receive({ type: 'checkHfModel', scope: 'user', model: hf.model, purpose: 'task', requestId: 1 });
  assert.equal(calls, 1); assert.deepEqual(h.updates, []);
  await h.receive({ ...save, presets: [hf, { ...hf, mode: 'workspace-write' }], titleModel: hf.model, titlePricing: hf.pricing, requestId: 2 });
  assert.equal(calls, 1); assert.equal(h.updates.length, 4);
  assert.equal(h.sent.at(-1)!.saved, true);
  await h.receive({ type: 'checkHfModel', scope: 'user', model: hf.model, purpose: 'task', requestId: 3 });
  assert.equal(calls, 2, 'explicit rechecks must not use the cache');
});

test('all different HF models must pass before any setting is written', async () => {
  const h = harness(async (model, purpose) => model === hf.model ? passed(model, purpose) : { model, purpose, status: 'failed', message: '利用量が未取得' });
  await h.receive({ ...save, presets: [hf, { ...hf, model: 'hf:fixture/other' }] });
  assert.deepEqual(h.updates, []);
});

test('HF checks can be cancelled during save and closing settings also aborts them', async () => {
  for (const close of [false, true]) {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const h = harness(async (model, purpose, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve({ model, purpose, status: 'failed', message: '中止' }), { once: true }); started();
    }));
    const work = h.receive(save); await ready;
    if (close) h.close(); else await h.receive({ type: 'cancelHfCheck', requestId: 1 });
    await work; assert.deepEqual(h.updates, []);
  }
});
