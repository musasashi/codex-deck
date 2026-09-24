import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import type * as vscode from 'vscode';
import type { JsonObject, Task, TaskRecord } from '../src/core/types';
import type { TaskManager } from '../src/core/taskManager';
import type { PanelHost } from '../src/ui/panels';
import { deferred, FakeGateway, thread } from './helpers';
import type { AppServerClient } from '../src/appServer/client';

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

function panel() {
  const disposed = new Emitter<void>();
  const messages: JsonObject[] = [];
  let receive = async (_value: unknown): Promise<void> => {};
  const webviewPanel = {
    active: true, viewColumn: 1,
    webview: { cspSource: 'test:', asWebviewUri: (uri: vscode.Uri) => uri,
      onDidReceiveMessage(listener: typeof receive) { receive = listener; return disposable(); },
      async postMessage(message: JsonObject) { messages.push(structuredClone(message)); return true; } },
    reveal() {}, onDidChangeViewState: disposable, onDidDispose: disposed.event, dispose() { disposed.fire(); },
  } as unknown as vscode.WebviewPanel;
  return Object.assign(webviewPanel, { messages, receive: (value: unknown) => receive(value) });
}

function activate(records: TaskRecord[], options: { remoteName?: string; isTrusted?: boolean; cliPath?: string; presets?: unknown; questionPresets?: unknown } = { remoteName: 'wsl' }) {
  let stored: unknown = { version: 1, tasks: structuredClone(records) };
  let clipboardText = '';
  let serializer!: vscode.WebviewPanelSerializer;
  const serializers = new Map<string, vscode.WebviewPanelSerializer>();
  let createdPanels = 0;
  const openedPanels: ReturnType<typeof panel>[] = [];
  const trees = new Map<string, { getChildren(): Task[] }>();
  const commands = new Map<string, (arg?: unknown) => unknown>();
  const api = {
    EventEmitter: Emitter,
    TabInputWebview: class { constructor(readonly viewType: string) {} },
    ViewColumn: { Active: -1 },
    env: { remoteName: options.remoteName, clipboard: {
      async writeText(value: string) { clipboardText = value; },
      async readText() { return clipboardText; },
    } },
    Uri: { file: (value: string) => new URL(`file://${value}`),
      joinPath: (uri: URL, ...parts: string[]) => new URL(`${uri}/${parts.join('/')}`) },
    window: {
      state: { focused: true },
      activeTextEditor: undefined as vscode.TextEditor | undefined,
      tabGroups: { all: [] as { tabs: vscode.Tab[] }[], close: async (_tabs: readonly vscode.Tab[]): Promise<boolean> => true },
      showQuickPick: async (_items: { label: string; task: Task }[]): Promise<{ label: string; task: Task } | undefined> => undefined,
      showInputBox: async (): Promise<string | undefined> => undefined,
      showWarningMessage: async (_message: string, _options: vscode.MessageOptions, ..._items: string[]): Promise<string | undefined> => undefined,
      createOutputChannel: () => ({ ...disposable(), append() {}, appendLine() {} }),
      onDidChangeWindowState: disposable, registerFileDecorationProvider: disposable,
      registerTreeDataProvider(id: string, tree: { getChildren(): Task[] }) { trees.set(id, tree); return disposable(); },
      registerWebviewPanelSerializer(type: string, value: vscode.WebviewPanelSerializer) {
        serializer = value; serializers.set(type, value);
        return { dispose() { serializers.delete(type); } };
      },
      createWebviewPanel(viewType: string) { createdPanels++; const value = Object.assign(panel(), { viewType }); openedPanels.push(value); return value; },
    },
    workspace: {
      isTrusted: options.isTrusted ?? false, // Restoration must populate the tree even when connecting is unavailable.
      workspaceFolders: [{ uri: { fsPath: '/project' } }],
      onDidChangeConfiguration: disposable, onDidCloseTextDocument: disposable, registerTextDocumentContentProvider: disposable,
      getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'cliPath' ? options.cliPath ?? fallback : key === 'presets' ? options.presets ?? fallback : key === 'questionPresets' ? options.questionPresets ?? fallback : fallback }),
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
    rows: () => trees.get('codexDeck.tasks')!.getChildren(), serializer, serializers, commands, api, openedPanels,
    createdPanels: () => createdPanels,
    records: () => (stored as { tasks: TaskRecord[] }).tasks, clipboard: () => clipboardText,
    async shutdown() {
      try { await module.exports.deactivate(); }
      finally { for (const subscription of context.subscriptions.reverse()) subscription.dispose(); }
    },
  };
}

test('unsupported remote hosts cannot activate the extension', () => {
  assert.throws(() => activate([], { remoteName: 'ssh-remote' }), /WSL接続で開き/);
  assert.throws(() => activate([], { remoteName: 'dev-container' }), /WSL接続で開き/);
});

test('every editor title provides a new task button', () => {
  const manifest = nodeRequire('./package.json');
  const icon = { light: 'media/new-task-light.svg', dark: 'media/new-task-dark.svg' };
  assert.deepEqual(manifest.contributes.commands.find((command: { command: string }) => command.command === 'codexDeck.newTask').icon, icon);
  assert.ok(Object.values(icon).every(file => existsSync(path.resolve(file))));
  assert.deepEqual(manifest.contributes.menus['editor/title'], [{
    command: 'codexDeck.newTask',
    group: 'navigation@1',
  }]);
});

test('preset cycling is a customizable command bound to Ctrl+Tab in task editors', async () => {
  const presets = [
    { model: 'test-model', effort: 'high', mode: 'auto-review' },
    { model: 'test-model', effort: 'test-effort', mode: 'workspace-write' },
  ];
  const extension = activate([record('draft', true, true)], { remoteName: 'wsl', presets });
  const { host, manager } = extension.serializer as unknown as { host: PanelHost; manager: TaskManager };
  try {
    const manifest = nodeRequire('./package.json');
    assert.equal(manifest.contributes.commands.find((command: { command: string }) => command.command === 'codexDeck.cyclePreset').title, '次のプリセットに切り替え');
    assert.deepEqual(manifest.contributes.keybindings.find((binding: { command: string }) => binding.command === 'codexDeck.cyclePreset'), {
      command: 'codexDeck.cyclePreset', key: 'ctrl+tab', when: 'activeWebviewPanelId =~ /^codexDeck\\.task\\./',
    });

    host.models = [{ id: 'test-model', label: 'Test', description: '', defaultEffort: 'test-effort', efforts: [{ id: 'high', description: '' }, { id: 'test-effort', description: '' }], isDefault: true, inputModalities: ['text'] }];
    await extension.serializer.deserializeWebviewPanel(panel(), { taskId: 'draft' });
    await extension.commands.get('codexDeck.cyclePreset')!();
    assert.deepEqual(manager.get('draft').settings, presets[0]);
    await extension.commands.get('codexDeck.cyclePreset')!();
    assert.deepEqual(manager.get('draft').settings, presets[1]);
  } finally { await extension.shutdown(); }
});

test('code block copy requests write the exact code and acknowledge their request', async () => {
  const extension = activate([]);
  const { host, manager } = extension.serializer as unknown as { host: PanelHost; manager: TaskManager };
  try {
    const task = manager.create('/project');
    const text = 'const value = "<tag>";\n  run(value);';
    assert.deepEqual(await host.command(task, { type: 'copyCode', requestId: 7, text }), { type: 'codeCopied', requestId: 7 });
    assert.equal(extension.clipboard(), text);
  } finally { await extension.shutdown(); }
});

test('selection mentions replace the old command and use the source chat instead of another active task', async () => {
  const extension = activate([record('first', true), record('source', true)]);
  const first = panel(), source = panel();
  try {
    await extension.serializer.deserializeWebviewPanel(first, { taskId: 'first' });
    await extension.serializer.deserializeWebviewPanel(source, { taskId: 'source' });
    await source.receive({ type: 'ready' });
    assert.equal(extension.commands.has('codexDeck.addSelection'), false);
    const manifest = nodeRequire('./package.json');
    assert.equal(manifest.contributes.commands.some((command: { command: string }) => command.command === 'codexDeck.addSelection'), false);
    assert.equal(manifest.contributes.commands.find((command: { command: string }) => command.command === 'codexDeck.mentionSelection').title, 'Codex-Deckで言及');
    assert.equal(manifest.contributes.menus['editor/context'][0].command, 'codexDeck.mentionSelection');
    assert.equal(manifest.contributes.menus['webview/context'], undefined);

    await extension.commands.get('codexDeck.mentionSelection')!({ webview: 'codexDeck.task', codexDeckTaskId: 'source', codexDeckSelectionText: '選択した文章\n  字下げを保持' });
    assert.deepEqual(source.messages.at(-1), { type: 'insertReference', text: '> 参照元: 会話「source」\n>\n> 選択した文章\n>   字下げを保持\n\n' });
    assert.equal(first.messages.some(message => message.type === 'insertReference'), false);
    assert.ok(extension.rows().every(task => !task.attachments.length && !task.turns.length));
  } finally { await extension.shutdown(); }
});

test('editor mentions snapshot unsaved text before choosing a task and wait for its composer to be ready', async () => {
  const extension = activate([record('first', true), record('target', true)]);
  let selectedText = '一行目\r\n\r\n  <tag>二行目</tag>';
  extension.api.window.activeTextEditor = {
    document: { uri: { scheme: 'file', fsPath: '/project/開いている文章.md' }, getText: () => selectedText },
    selection: { isEmpty: false, start: { line: 4, character: 2 }, end: { line: 6, character: 18 } },
  } as unknown as vscode.TextEditor;
  extension.api.window.showQuickPick = async items => {
    selectedText = '選択後に変更された文章';
    extension.api.window.activeTextEditor = undefined;
    return items.find(item => item.task.id === 'target');
  };
  try {
    await extension.commands.get('codexDeck.mentionSelection')!();
    const target = extension.openedPanels[0]!;
    assert.equal(extension.createdPanels(), 1);
    assert.equal(target.messages.some(message => message.type === 'insertReference'), false);
    await target.receive({ type: 'ready' });
    assert.deepEqual(target.messages.at(-1), { type: 'insertReference', text: '> 参照元: /project/開いている文章.md:5:3-7:19\n>\n> 一行目\n> \n>   <tag>二行目</tag>\n\n' });
    await target.receive({ type: 'ready' });
    assert.equal(target.messages.filter(message => message.type === 'insertReference').length, 1);
    assert.ok(extension.rows().every(task => !task.attachments.length && !task.turns.length));
  } finally { await extension.shutdown(); }
});

test('editor mentions create a draft when no task is open and retain untitled document locations', async () => {
  const extension = activate([]);
  extension.api.window.activeTextEditor = {
    document: { uri: { scheme: 'untitled', toString: () => 'untitled:Untitled-1' }, getText: () => 'まだ保存していない文章' },
    selection: { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 0, character: 13 } },
  } as unknown as vscode.TextEditor;
  try {
    await extension.commands.get('codexDeck.mentionSelection')!();
    assert.equal(extension.rows().length, 1);
    const target = extension.openedPanels[0]!;
    await target.receive({ type: 'ready' });
    assert.deepEqual(target.messages.at(-1), { type: 'insertReference', text: '> 参照元: untitled:Untitled-1:1:1-1:14\n>\n> まだ保存していない文章\n\n' });
    assert.equal(extension.rows()[0]!.threadId, undefined);
    assert.equal(extension.rows()[0]!.attachments.length, 0);
  } finally { await extension.shutdown(); }
});

test('Windows CLI paths are rejected before connecting from WSL', async () => {
  for (const cliPath of ['codex.exe', 'codex.cmd', 'codex.bat', ' C:\\tools\\codex.exe ', 'C:/tools/codex', '/mnt/c/tools/CODEX.EXE', '\\\\server\\share\\codex']) {
    const extension = activate([], { remoteName: 'wsl', isTrusted: true, cliPath });
    try {
      const { host } = extension.serializer as unknown as { host: PanelHost };
      await assert.rejects(host.connect(), /WSL内のCodex CLI.*Windows版/);
    } finally { await extension.shutdown(); }
  }
});

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

function connectedExtension(records: TaskRecord[] = [], options: Parameters<typeof activate>[1] = {}) {
  const extension = activate(records, { remoteName: 'wsl', ...options });
  const { host, manager } = extension.serializer as unknown as { host: PanelHost; manager: TaskManager };
  const gateway = new FakeGateway();
  const client = manager.gateway;
  const resetRequests: { creditId: string; idempotencyKey: string }[] = [];
  Object.assign(client, {
    connected: true,
    startThread: gateway.startThread.bind(gateway), resumeThread: gateway.resumeThread.bind(gateway), readThread: gateway.readThread.bind(gateway),
    listModels: gateway.listModels.bind(gateway), startTurn: gateway.startTurn.bind(gateway), steerTurn: gateway.steerTurn.bind(gateway),
    generateTitle: gateway.generateTitle.bind(gateway), renameThread: gateway.renameThread.bind(gateway), readUsage: gateway.readUsage.bind(gateway),
    listSkills: async () => [{ name: 'sample', path: '/skills/sample/SKILL.md', description: '', scope: 'user' }],
    readConfig: async () => ({}),
    // All reset operations in extension tests terminate at this in-memory stub.
    consumeResetCredit: async (creditId: string, idempotencyKey: string) => { resetRequests.push({ creditId, idempotencyKey }); return 'reset'; },
  });
  gateway.events.subscribe(event => client.events.emit(event));
  host.connect = async () => {};
  return { ...extension, host, manager, gateway, resetRequests };
}

function resetCreditExtension() {
  const extension = connectedExtension([record('reset', true, true)]);
  extension.gateway.limits.accountId = 'test-account';
  extension.gateway.limits.resetCredits = { availableCount: 2, credits: [
    { id: 'test-credit', title: 'テスト専用チケット', expiresAt: 4_000_000_000_000 }, { id: 'other-credit', expiresAt: null },
  ] };
  return { ...extension, task: extension.manager.get('reset'), request: { type: 'requestResetCredit', creditId: 'test-credit', requestId: 'test-request' } };
}

test('one reset click only opens confirmation; cancellation and concurrent clicks never consume tickets', async () => {
  const extension = resetCreditExtension();
  const confirmation = deferred<string | undefined>();
  const opened = deferred<void>();
  extension.api.window.showWarningMessage = async (message, options, ...items) => {
    assert.match(message, /1枚使用/); assert.equal(options.modal, true);
    assert.match(options.detail!, /テスト専用チケット\n有効期限:/); assert.deepEqual(items, ['チケットを使用']);
    opened.resolve(); return confirmation.promise;
  };
  let pending: Promise<unknown> | undefined;
  try {
    pending = extension.host.command(extension.task, { ...extension.request, confirmed: true });
    await opened.promise;
    assert.equal(extension.resetRequests.length, 0, 'the initial click cannot redeem a ticket, even with a forged confirmation field');
    const other = extension.manager.create('/project');
    const duplicate = await extension.host.command(other, { ...extension.request, requestId: 'duplicate' });
    assert.match(String(duplicate?.error), /進行中/);
    confirmation.resolve(undefined);
    assert.deepEqual(await pending, { type: 'resetCreditResult', requestId: 'test-request' });
    assert.equal(extension.resetRequests.length, 0);
  } finally { confirmation.resolve(undefined); await pending; await extension.shutdown(); }
});

test('explicit reset confirmation consumes only the selected mock credit and refreshes the shared balance', async () => {
  const extension = resetCreditExtension();
  const consumed = deferred<void>();
  const finish = deferred<'reset'>();
  extension.api.window.showWarningMessage = async () => 'チケットを使用';
  const client = extension.manager.gateway as AppServerClient;
  const mockConsume = client.consumeResetCredit.bind(client);
  client.consumeResetCredit = async (creditId, key) => {
    await mockConsume(creditId, key); consumed.resolve();
    const result = await finish.promise;
    extension.gateway.limits.resetCredits = { availableCount: 1, credits: [{ id: 'other-credit', expiresAt: null }] };
    return result;
  };
  let pending: Promise<unknown> | undefined;
  try {
    pending = extension.host.command(extension.task, extension.request);
    await consumed.promise;
    await extension.host.command(extension.task, { ...extension.request, requestId: 'double-click' });
    assert.equal(extension.resetRequests.length, 1);
    assert.equal(extension.resetRequests[0]!.creditId, 'test-credit');
    assert.match(extension.resetRequests[0]!.idempotencyKey, /^[\da-f-]{36}$/);
    finish.resolve('reset'); await pending;
    assert.equal(extension.manager.usage?.resetCredits?.availableCount, 1);
  } finally { finish.resolve('reset'); await pending; await extension.shutdown(); }
});

test('expired or unavailable tickets, changed accounts and lost connections invalidate reset confirmation', async () => {
  for (const change of ['expired', 'removed', 'account', 'account-id', 'connection', 'read-failure', 'closed'] as const) {
    const extension = resetCreditExtension();
    extension.api.window.showWarningMessage = async () => {
      if (change === 'expired') extension.gateway.limits.resetCredits!.credits![0]!.expiresAt = Date.now() - 1;
      if (change === 'removed') extension.gateway.limits.resetCredits = { availableCount: 0, credits: [] };
      if (change === 'account') extension.gateway.events.emit({ type: 'account' });
      if (change === 'account-id') extension.gateway.limits.accountId = 'different-account';
      if (change === 'connection') { Object.assign(extension.manager.gateway, { connected: false }); extension.gateway.events.emit({ type: 'connection', connected: false }); }
      if (change === 'read-failure') extension.gateway.usageReader = async () => { throw new Error('mock read failure'); };
      if (change === 'closed') extension.manager.close(extension.task.id);
      return 'チケットを使用';
    };
    try {
      const response = await extension.host.command(extension.task, extension.request);
      assert.ok(response?.error, change);
      assert.equal(extension.resetRequests.length, 0, change);
    } finally { await extension.shutdown(); }
  }
});

test('an uncertain reset outcome is never retried automatically and explicit retries reuse the same key', async () => {
  const extension = resetCreditExtension();
  let confirmations = 0;
  extension.api.window.showWarningMessage = async () => { confirmations++; return 'チケットを使用'; };
  const client = extension.manager.gateway as AppServerClient;
  const mockConsume = client.consumeResetCredit.bind(client);
  client.consumeResetCredit = async (creditId, key) => { await mockConsume(creditId, key); throw new Error('mock timeout'); };
  try {
    assert.match(String((await extension.host.command(extension.task, extension.request))?.error), /mock timeout/);
    assert.equal(extension.resetRequests.length, 1);
    extension.gateway.events.emit({ type: 'connection', connected: false });
    extension.gateway.events.emit({ type: 'connection', connected: true });
    await extension.host.command(extension.task, { ...extension.request, requestId: 'retry' });
    assert.equal(confirmations, 2);
    assert.equal(extension.resetRequests.length, 2);
    assert.equal(extension.resetRequests[0]!.idempotencyKey, extension.resetRequests[1]!.idempotencyKey);
  } finally { await extension.shutdown(); }
});

test('a later reset after nothingToReset starts a new explicitly confirmed attempt', async () => {
  const extension = resetCreditExtension();
  extension.api.window.showWarningMessage = async () => 'チケットを使用';
  const client = extension.manager.gateway as AppServerClient;
  const mockConsume = client.consumeResetCredit.bind(client);
  client.consumeResetCredit = async (creditId, key) => { await mockConsume(creditId, key); return 'nothingToReset'; };
  try {
    assert.match(String((await extension.host.command(extension.task, extension.request))?.message), /リセットが必要な使用量枠はありません/);
    await extension.host.command(extension.task, { ...extension.request, requestId: 'new-attempt' });
    assert.equal(extension.resetRequests.length, 2);
    assert.notEqual(extension.resetRequests[0]!.idempotencyKey, extension.resetRequests[1]!.idempotencyKey);
  } finally { await extension.shutdown(); }
});

function editorResource(id: string) {
  return { scheme: 'webview-panel', path: `webview-panel/webview-codexDeck.task.${encodeURIComponent(id)}-00000000-0000-4000-8000-000000000000` };
}

test('tab menu commands act on the clicked task even when an identically named task is active in another group', async () => {
  const extension = connectedExtension();
  const { manager, gateway, commands, api } = extension;
  const archived: string[] = [];
  Object.assign(manager.gateway, { forkThread: gateway.forkThread.bind(gateway), archiveThread: async (id: string) => { archived.push(id); } });
  api.window.showInputBox = async () => '名前を変更したタスク';
  try {
    const first = manager.adoptThread({ ...thread('first'), title: '同じ名前' });
    const source = { ...thread('target'), title: '同じ名前', turns: [{ id: 'target-turn', status: 'completed',
      items: [{ id: 'target-reply', kind: 'agentMessage', data: { text: '対象の会話' } }] }] };
    gateway.threads.set(source.id, source);
    const target = manager.adoptThread(source);
    await extension.serializer.deserializeWebviewPanel(panel(), { taskId: first.id });
    await extension.serializer.deserializeWebviewPanel(Object.assign(panel(), { active: false, viewColumn: 2 }), { taskId: target.id });
    const resource = editorResource(target.id);

    await commands.get('codexDeck.copyTaskDeepLink')!(resource);
    assert.equal(extension.clipboard(), 'codex://threads/target');
    await commands.get('codexDeck.copyTaskMarkdown')!(resource);
    assert.match(extension.clipboard(), /対象の会話/);
    await commands.get('codexDeck.editor.renameTask')!(resource);
    assert.equal(target.title, '名前を変更したタスク');
    assert.equal(first.title, '同じ名前');
    await commands.get('codexDeck.editor.forkTask')!(resource);
    const fork = [...manager.tasks.values()].find(task => task.threadId?.startsWith('fork-'))!;
    assert.deepEqual(fork.turns, target.turns);
    assert.equal(extension.openedPanels[0]!.viewType, `codexDeck.task.${fork.id}`);
    assert.ok(extension.serializers.has(extension.openedPanels[0]!.viewType));
    await commands.get('codexDeck.editor.archiveTask')!(resource);
    assert.deepEqual(archived, ['target']);
    assert.equal(target.open, false);
    assert.equal(first.open, true);

    for (const invalid of [editorResource('missing'), { scheme: 'webview-panel', path: 'webview-panel/webview-codexDeck.settings-00000000-0000-4000-8000-000000000000' }]) {
      await commands.get('codexDeck.editor.archiveTask')!(invalid);
      assert.deepEqual(archived, ['target'], 'an unknown tab must never fall back to the active task');
    }
  } finally { await extension.shutdown(); }
});

test('saved task tabs register their serializers at startup and can be archived before being shown', async () => {
  const extension = connectedExtension([record('first', true, true), record('hidden', true, true)]);
  const { api, manager } = extension;
  const hiddenTab = { input: new api.TabInputWebview('mainThreadWebview-codexDeck.task.hidden') } as vscode.Tab;
  api.window.tabGroups.all = [{ tabs: [hiddenTab] }];
  let closed: readonly vscode.Tab[] = [];
  api.window.tabGroups.close = async tabs => { closed = tabs; return true; };
  try {
    assert.ok(extension.serializers.has('codexDeck.task.first'));
    assert.ok(extension.serializers.has('codexDeck.task.hidden'));
    await extension.serializer.deserializeWebviewPanel(panel(), { taskId: 'first' });
    await extension.commands.get('codexDeck.editor.archiveTask')!(editorResource('hidden'));
    assert.deepEqual(closed, [hiddenTab]);
    assert.equal(manager.get('hidden').open, false);
    assert.equal(manager.get('first').open, true);
    assert.equal(extension.createdPanels(), 0);
  } finally { await extension.shutdown(); }
  assert.equal(extension.serializers.size, 0);
});

test('deleted chats close visible and hidden tabs and cannot restore saved task data', async () => {
  const extension = connectedExtension([record('visible', true), record('hidden', true), record('other', true)]);
  extension.gateway.threads.set('thread-visible', thread('thread-visible'));
  const { api, manager } = extension;
  const hiddenTab = { input: new api.TabInputWebview('mainThreadWebview-codexDeck.task.hidden') } as vscode.Tab;
  api.window.tabGroups.all = [{ tabs: [hiddenTab] }];
  let closed: readonly vscode.Tab[] = [];
  api.window.tabGroups.close = async tabs => { closed = tabs; return true; };
  const visible = panel();
  let disposed = false;
  visible.onDidDispose(() => { disposed = true; });
  try {
    await extension.serializer.deserializeWebviewPanel(visible, { taskId: 'visible' });
    manager.gateway.events.emit({ type: 'deleted', threadId: 'thread-visible' });
    manager.gateway.events.emit({ type: 'deleted', threadId: 'thread-hidden' });
    await manager.flush();
    assert.equal(disposed, true);
    assert.deepEqual(closed, [hiddenTab]);
    assert.deepEqual(extension.records().map(record => record.id), ['other']);
    assert.deepEqual(extension.rows().map(task => task.id), ['other']);
  } finally { await extension.shutdown(); }
});

test('/plan toggles without a turn and inline instructions use the normal send path with images and skills', async () => {
  const extension = connectedExtension();
  const { host, manager, gateway } = extension;
  try {
    const task = manager.create('/project', { model: 'test-model', effort: 'high', mode: 'auto-review' });
    const image = { id: 'image', label: 'Image', input: { type: 'image' as const, url: 'data:image/png;base64,YQ==' } };
    manager.attach(task.id, image);
    manager.attach(task.id, { ...image, id: 'later' });
    await host.command(task, { type: 'send', text: '/plan', sendId: 'toggle', attachmentIds: [image.id] });
    assert.equal(task.settings.collaborationMode, 'plan');
    assert.equal(task.threadId, undefined, 'a bare toggle must not create an empty conversation');
    assert.equal(gateway.sent.length, 0);
    assert.equal(task.attachments.length, 2);
    await host.command(task, { type: 'send', text: '/plan $sample 画面を設計してください', sendId: 'inline', attachmentIds: [image.id], skillPaths: ['/skills/sample/SKILL.md'] });
    assert.deepEqual(gateway.sent[0]?.input, [
      { type: 'text', text: '$sample 画面を設計してください' }, image.input,
      { type: 'skill', name: 'sample', path: '/skills/sample/SKILL.md' },
    ]);
    assert.equal(gateway.sent[0]?.clientId, 'inline');
    assert.deepEqual(gateway.sent[0]?.settings, { model: 'test-model', effort: 'high', mode: 'auto-review', collaborationMode: 'plan' });
    assert.deepEqual(task.attachments.map(attachment => attachment.id), ['later']);
    await assert.rejects(host.command(task, { type: 'send', text: '/plan' }), /実行が完了/);
    assert.equal(task.settings.collaborationMode, 'plan');
    gateway.finish(task.threadId!, task.activeTurnId!, 'completed');
    await host.command(task, { type: 'send', text: '/plan 計画を調整してください', attachmentIds: [] });
    assert.equal(gateway.sent.at(-1)?.settings.collaborationMode, 'plan', 'inline /plan must stay in plan mode');
    gateway.finish(task.threadId!, task.activeTurnId!, 'completed');
    host.models = await gateway.listModels();
    await host.command(task, { type: 'settings', model: 'test-model', effort: 'high', mode: 'read-only' });
    await host.command(task, { type: 'cyclePreset' });
    assert.equal(task.settings.collaborationMode, 'plan', 'settings and presets must preserve the conversation mode');
    await host.command(task, { type: 'send', text: '/plan' });
    assert.equal(task.settings.collaborationMode, 'default');
    await host.command(task, { type: 'send', text: '実装してください', attachmentIds: [] });
    assert.equal(gateway.sent.at(-1)?.settings.collaborationMode, 'default');
    assert.equal(gateway.sent.length, 3);
  } finally { await extension.shutdown(); }
});

test('/plan restores a saved task before checking for an active turn and rejects changes while sending', async () => {
  const saved = record('running', true);
  const extension = connectedExtension([saved]);
  const { host, manager, gateway } = extension;
  try {
    gateway.threads.set(saved.threadId!, { ...thread(saved.threadId), status: 'active', turns: [{ id: 'running-turn', status: 'inProgress', items: [] }] });
    const task = manager.get(saved.id);
    assert.equal(task.hydrated, false);
    await assert.rejects(host.command(task, { type: 'send', text: '/plan change the plan' }), /実行が完了/);
    assert.equal(task.settings.collaborationMode, undefined);
    assert.equal(gateway.sent.length, 0);
    assert.equal(gateway.steered.length, 0);
    const draft = manager.create('/project');
    draft.busy = true;
    await assert.rejects(host.command(draft, { type: 'send', text: '/plan' }), /実行が完了/);
    assert.equal(draft.settings.collaborationMode, undefined);
  } finally { await extension.shutdown(); }
});

for (const settings of [
  { model: 'latest', effort: 'high', mode: 'read-only' },
  { model: 'hf:org/model', effort: 'default', mode: 'workspace-write', pricing: { input: 1, output: 2 } },
]) test(`selection questions create one independent task with ${settings.model} and reference the source conversation`, async () => {
  const questions = [{ id: 'explain', name: '具体例で', prompt: '/new という語を説明してください。', settings }];
  const extension = connectedExtension([], { questionPresets: questions });
  const { host, manager, gateway } = extension;
  let referenceFile: string | undefined;
  try {
    const parent = { ...thread('parent'), cwd: '/source-project', status: 'active', turns: [{ id: 'source-turn', status: 'inProgress',
      items: [{ id: 'source-reply', kind: 'agentMessage', data: { text: 'コードの説明です。' } }] }] };
    gateway.threads.set(parent.id, parent);
    const source = manager.adoptThread(parent);
    source.settings = { model: 'test-model', mode: 'danger-full-access', collaborationMode: 'plan' };
    const before = structuredClone(source);
    const contexts: string[] = [];
    const configuration = extension.api.workspace.getConfiguration;
    extension.api.workspace.getConfiguration = (_section?: string, uri?: URL) => { if (uri) contexts.push(uri.pathname); return configuration(); };
    const request = { type: 'selectionAction', action: 'question', requestId: 'ask-once', questionPresetId: 'explain', text: '選択した文章\n  code();' };
    await Promise.all([host.command(source, request), host.command(source, request)]);
    const child = [...manager.tasks.values()].find(task => task !== source)!;
    assert.equal(extension.createdPanels(), 1);
    assert.equal(child.cwd, source.cwd);
    assert.deepEqual(child.settings, { ...settings, model: settings.model === 'latest' ? 'test-model' : settings.model, effort: settings.model.startsWith('hf:') ? undefined : 'high' });
    assert.ok(contexts.includes(source.cwd));
    assert.equal(gateway.sent.length, 0, 'sending waits until the new webview is ready');
    const panel = extension.openedPanels[0]!;
    assert.equal(panel.messages.some(message => message.type === 'initialQuestion'), false);
    await panel.receive({ type: 'ready' });
    await panel.receive({ type: 'ready' });
    const initial = panel.messages.filter(message => message.type === 'initialQuestion');
    assert.equal(initial.length, 1);
    assert.match(String(initial[0]!.text), /^質問: \/new/);
    assert.match(String(initial[0]!.text), /> 選択した文章\n>   code\(\);/);
    assert.match(String(initial[0]!.text), /codex:\/\/threads\/parent$/);
    await panel.receive({ type: 'send', text: initial[0]!.text, sendId: initial[0]!.sendId, attachmentIds: [], skillPaths: [] });
    assert.equal(gateway.sent.length, 1);
    assert.equal(gateway.steered.length, 0);
    assert.equal(manager.tasks.size, 2, '/new in a question must not execute a command');
    assert.equal(gateway.sent[0]!.settings.mode, settings.mode);
    const reference = gateway.sent[0]!.input.find(input => input.text?.includes('<codex_deck_reference>'))!.text!;
    referenceFile = JSON.parse(reference.match(/スナップショット: (.+)/)![1]!);
    assert.match(await readFile(referenceFile!, 'utf8'), /コードの説明です/);
    assert.deepEqual(source, before);
    questions[0]!.settings = { model: 'hf:another/model', effort: 'default', mode: 'read-only' };
    await panel.receive({ type: 'ready' });
    assert.equal(child.settings.mode, settings.mode, 'editing questions does not change an existing task');
  } finally {
    await extension.shutdown();
    if (referenceFile) await rm(path.dirname(referenceFile), { recursive: true, force: true });
  }
});

test('invalid selection questions do not create tasks; copy and mention remain scoped to the source', async () => {
  const questions = [{ id: 'ask', name: '質問', prompt: '説明してください', settings: { model: 'missing', effort: 'high', mode: 'read-only' } }];
  const extension = connectedExtension([], { questionPresets: questions });
  const { host, manager } = extension;
  try {
    const source = manager.adoptThread(thread('source'));
    const base = { type: 'selectionAction', action: 'question', text: '説明', questionPresetId: 'ask' };
    await assert.rejects(host.command(source, { ...base, requestId: 'missing-model' }), /モデル/);
    await assert.rejects(host.command(source, { ...base, requestId: 'deleted', questionPresetId: 'deleted' }), /見つからない/);
    questions.push({ ...questions[0]! });
    await assert.rejects(host.command(source, { ...base, requestId: 'duplicate' }), /重複/);
    assert.equal(extension.createdPanels(), 0);
    assert.equal(manager.tasks.size, 1);
    await host.command(source, { ...base, action: 'copy', text: '  正確な引用\n次の行', requestId: 'copy' });
    assert.equal(extension.clipboard(), '  正確な引用\n次の行');
    await host.command(source, { ...base, action: 'mention', requestId: 'mention' });
    const panel = extension.openedPanels[0]!;
    await panel.receive({ type: 'ready' });
    assert.ok(panel.messages.some(message => message.type === 'insertReference' && String(message.text).includes('会話「source」')));
    assert.equal(manager.tasks.size, 1);
  } finally { await extension.shutdown(); }
});
