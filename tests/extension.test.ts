import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import type * as vscode from 'vscode';
import type { Task, TaskRecord } from '../src/core/types';

const bundle = buildSync({ entryPoints: [path.resolve('src/extension.ts')], bundle: true, write: false,
  platform: 'node', format: 'cjs', external: ['vscode'], logLevel: 'silent' }).outputFiles[0]!.text;
const nodeRequire = createRequire(path.resolve('package.json'));
const disposable = () => ({ dispose() {} });

class Emitter<T> {
  private listeners = new Set<(value: T) => void>();
  event = (listener: (value: T) => void) => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };
  fire(value: T): void { for (const listener of this.listeners) listener(value); }
  dispose(): void { this.listeners.clear(); }
}

function record(id: string, open: boolean, draft = false): TaskRecord {
  return { id, title: id, ...(draft ? {} : { threadId: `thread-${id}` }), cwd: '/project', open,
    autoResume: false, claims: [], settings: { mode: 'default' } };
}

function panel(): vscode.WebviewPanel {
  const disposed = new Emitter<void>();
  return {
    active: true, viewColumn: 1,
    webview: { cspSource: 'test:', asWebviewUri: (uri: vscode.Uri) => uri, onDidReceiveMessage: disposable, postMessage: async () => true },
    reveal() {}, onDidChangeViewState: disposable, onDidDispose: disposed.event, dispose() { disposed.fire(); },
  } as unknown as vscode.WebviewPanel;
}

function activate(records: TaskRecord[]) {
  let stored: unknown = { version: 1, tasks: structuredClone(records) };
  let serializer!: vscode.WebviewPanelSerializer;
  let createdPanels = 0;
  const trees = new Map<string, { getChildren(): Task[] }>();
  const commands = new Map<string, (arg?: unknown) => unknown>();
  const api = {
    EventEmitter: Emitter,
    Uri: { file: (value: string) => new URL(`file://${value}`),
      joinPath: (uri: URL, ...parts: string[]) => new URL(`${uri}/${parts.join('/')}`) },
    window: {
      state: { focused: true },
      createOutputChannel: () => ({ ...disposable(), append() {}, appendLine() {} }),
      onDidChangeWindowState: disposable, registerFileDecorationProvider: disposable,
      registerTreeDataProvider(id: string, tree: { getChildren(): Task[] }) { trees.set(id, tree); return disposable(); },
      registerWebviewPanelSerializer(_type: string, value: vscode.WebviewPanelSerializer) { serializer = value; return disposable(); },
      createWebviewPanel() { createdPanels++; return panel(); },
    },
    workspace: {
      isTrusted: false, // Restoration must populate the tree even when connecting is unavailable.
      onDidChangeConfiguration: disposable, onDidCloseTextDocument: disposable, registerTextDocumentContentProvider: disposable,
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    },
    commands: { registerCommand(id: string, action: (arg?: unknown) => unknown) { commands.set(id, action); return disposable(); } },
  };
  const context = {
    extensionUri: new URL('file:///extension'), subscriptions: [] as vscode.Disposable[],
    globalStorageUri: { fsPath: '/storage' },
    workspaceState: { get: () => stored, async update(_key: string, value: unknown) { stored = structuredClone(value); } },
  };
  const module = { exports: {} as typeof import('../src/extension') };
  new Function('require', 'module', 'exports', bundle)((id: string) => id === 'vscode' ? api : nodeRequire(id), module, module.exports);
  module.exports.activate(context as unknown as vscode.ExtensionContext);
  return {
    rows: () => trees.get('codexDeck.tasks')!.getChildren(), serializer, commands,
    createdPanels: () => createdPanels,
    records: () => (stored as { tasks: TaskRecord[] }).tasks,
    async shutdown() {
      try { await module.exports.deactivate(); }
      finally { for (const subscription of context.subscriptions.reverse()) subscription.dispose(); }
    },
  };
}

test('activation lists all saved open tasks before any editor tab is deserialized', async () => {
  const extension = activate([record('first', true), record('closed', false), record('second', true), record('draft', true, true)]);
  try {
    assert.deepEqual(extension.rows().map(task => task.id), ['first', 'second', 'draft']);
    assert.deepEqual(extension.rows().map(task => task.status), ['disconnected', 'disconnected', 'idle']);
    assert.equal(extension.createdPanels(), 0, 'restoring the list must not create duplicate editors or change focus');
  } finally { await extension.shutdown(); }
});

test('restoring and closing one editor preserves the other open tasks across another reload', async () => {
  const extension = activate([record('first', true), record('hidden', true), record('closed', false)]);
  try {
    await extension.serializer.deserializeWebviewPanel(panel(), { taskId: 'first' });
    assert.deepEqual(extension.rows().map(task => task.id), ['first', 'hidden']);
    assert.equal(extension.createdPanels(), 0);
    await extension.commands.get('codexDeck.closeTask')!('first');
    assert.deepEqual(extension.rows().map(task => task.id), ['hidden']);
  } finally { await extension.shutdown(); }
  const reloaded = activate(extension.records());
  try {
    assert.deepEqual(reloaded.rows().map(task => task.id), ['hidden']);
    assert.equal(reloaded.createdPanels(), 0);
  } finally { await reloaded.shutdown(); }
});

test('reloading without selecting any task retains open drafts and conversations', async () => {
  const records = [record('hidden', true), record('draft', true, true), record('closed', false)];
  const extension = activate(records);
  await extension.shutdown();
  const reloaded = activate(extension.records());
  try {
    assert.deepEqual(reloaded.rows().map(task => task.id), ['hidden', 'draft']);
    assert.deepEqual(reloaded.records().map(({ id, open }) => ({ id, open })), records.map(({ id, open }) => ({ id, open })));
  } finally { await reloaded.shutdown(); }
});
