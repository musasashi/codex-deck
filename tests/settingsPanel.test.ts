import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import type * as vscode from 'vscode';
import { FakeGateway, externalModelIds } from './helpers';
import { type JsonObject } from '../src/core/types';

const bundle = buildSync({ entryPoints: [path.resolve('src/ui/settingsPanel.ts')], bundle: true, write: false,
  platform: 'node', format: 'cjs', external: ['vscode'], logLevel: 'silent' }).outputFiles[0]!.text;
const nodeRequire = createRequire(path.resolve('package.json'));
const preset = { model: 'test-model', effort: 'default', mode: 'read-only' };
const save = { type: 'saveSettings', scope: 'user', presets: [preset], titleModel: 'latest', titleEffort: 'lowest', requestId: 1 };

function harness(scoped = false) {
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
    { loadModels: () => new FakeGateway().listModels(), openCodexSettings: async () => {}, report() {} });
  panel.open();
  return { receive: (message: unknown) => receive(message), updates, sent, values };
}

test('settings load only subscription presets and save only supported settings', async () => {
  const h = harness();
  const external = { ...preset, model: externalModelIds[1] };
  h.values.set('presets', { globalValue: [external, preset] });
  h.values.set('questionPresets', { globalValue: [{ id: 'explain', name: '解説', prompt: '説明してください', settings: external }] });
  h.values.set('titleModel', { globalValue: externalModelIds[0] });
  await h.receive({ type: 'loadSettings', scope: 'user' });
  const state = h.sent.at(-1)!;
  assert.deepEqual(state.presets, [preset]);
  assert.deepEqual(state.questionPresets, []);
  assert.equal(state.titleModel, 'latest');
  await h.receive(save);
  assert.deepEqual(h.updates.map(update => update.key), ['presets', 'questionPresets', 'titleModel', 'titleEffort']);
  assert.equal(h.sent.at(-1)?.saved, true);
});

for (const [scope, target] of [['user', 1], ['workspace', 2], ['folder:file:///two', 3]] as const) {
  test(`question presets save independently and reload in the ${scope} scope`, async () => {
    const h = harness(true);
    const questions = [{ id: 'explain', name: '解説', prompt: '具体例で説明してください', settings: { ...preset, model: 'latest' } }];
    await h.receive({ ...save, scope, questionPresets: questions });
    assert.deepEqual(h.updates.find(update => update.key === 'questionPresets'), { key: 'questionPresets', value: questions, target,
      uri: target === 3 ? 'file:///two' : undefined });
    assert.deepEqual(h.sent.at(-1)?.questionPresets, questions);
    await h.receive({ ...save, scope, presets: [{ ...preset, mode: 'danger-full-access' }], questionPresets: questions });
    await h.receive({ type: 'loadSettings', scope });
    assert.deepEqual(h.sent.at(-1)?.questionPresets, questions);
  });
}

test('invalid questions are validated before any settings are written', async () => {
  const question = { id: 'ask', name: '質問', prompt: '説明して', settings: preset };
  for (const questionPresets of [[{ ...question, prompt: ' ' }], [question, question], [{ ...question, settings: { ...preset, model: 'unavailable-model' } }]]) {
    const h = harness();
    await h.receive({ ...save, questionPresets });
    assert.deepEqual(h.updates, []);
    assert.equal(h.sent.at(-1)?.type, 'settingsError');
    assert.match(String(h.sent.at(-1)?.message), /質問プリセット/);
  }
});
