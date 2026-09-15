import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import type * as vscode from 'vscode';
import type { JsonObject, Task, TaskRecord } from '../src/core/types';
import type { TaskManager } from '../src/core/taskManager';
import type { PanelHost } from '../src/ui/panels';
import { FakeGateway, thread } from './helpers';

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

function activate(records: TaskRecord[], options: { remoteName?: string; isTrusted?: boolean; cliPath?: string; presets?: unknown } = { remoteName: 'wsl' }) {
  let stored: unknown = { version: 1, tasks: structuredClone(records) };
  let clipboardText = '';
  let serializer!: vscode.WebviewPanelSerializer;
  let createdPanels = 0;
  const openedPanels: ReturnType<typeof panel>[] = [];
  const trees = new Map<string, { getChildren(): Task[] }>();
  const commands = new Map<string, (arg?: unknown) => unknown>();
  const api = {
    EventEmitter: Emitter,
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
      showQuickPick: async (_items: { label: string; task: Task }[]): Promise<{ label: string; task: Task } | undefined> => undefined,
      createOutputChannel: () => ({ ...disposable(), append() {}, appendLine() {} }),
      onDidChangeWindowState: disposable, registerFileDecorationProvider: disposable,
      registerTreeDataProvider(id: string, tree: { getChildren(): Task[] }) { trees.set(id, tree); return disposable(); },
      registerWebviewPanelSerializer(_type: string, value: vscode.WebviewPanelSerializer) { serializer = value; return disposable(); },
      createWebviewPanel() { createdPanels++; const value = panel(); openedPanels.push(value); return value; },
    },
    workspace: {
      isTrusted: options.isTrusted ?? false, // Restoration must populate the tree even when connecting is unavailable.
      workspaceFolders: [{ uri: { fsPath: '/project' } }],
      onDidChangeConfiguration: disposable, onDidCloseTextDocument: disposable, registerTextDocumentContentProvider: disposable,
      getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'cliPath' ? options.cliPath ?? fallback : key === 'presets' ? options.presets ?? fallback : fallback }),
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
    rows: () => trees.get('codexDeck.tasks')!.getChildren(), serializer, commands, api, openedPanels,
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

test('task editor title provides a new task button', () => {
  const manifest = nodeRequire('./package.json');
  assert.deepEqual(manifest.contributes.menus['editor/title'], [{
    command: 'codexDeck.newTask',
    when: 'activeWebviewPanelId == codexDeck.task',
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
      command: 'codexDeck.cyclePreset', key: 'ctrl+tab', when: 'activeWebviewPanelId == codexDeck.task',
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
    assert.deepEqual(manifest.contributes.menus['webview/context'], [{ command: 'codexDeck.mentionSelection', when: 'webviewId == codexDeck.task && codexDeckHasSelection', group: 'codexDeck' }]);

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

function connectedExtension(records: TaskRecord[] = []) {
  const extension = activate(records);
  const { host, manager } = extension.serializer as unknown as { host: PanelHost; manager: TaskManager };
  const gateway = new FakeGateway();
  const client = manager.gateway;
  Object.assign(client, {
    connected: true,
    startThread: gateway.startThread.bind(gateway), resumeThread: gateway.resumeThread.bind(gateway), readThread: gateway.readThread.bind(gateway),
    listModels: gateway.listModels.bind(gateway), startTurn: gateway.startTurn.bind(gateway), steerTurn: gateway.steerTurn.bind(gateway),
    generateTitle: gateway.generateTitle.bind(gateway), renameThread: gateway.renameThread.bind(gateway), readUsage: gateway.readUsage.bind(gateway),
    listSkills: async () => [{ name: 'sample', path: '/skills/sample/SKILL.md', description: '', scope: 'user' }],
    readConfig: async () => ({}),
  });
  gateway.events.subscribe(event => client.events.emit(event));
  host.connect = async () => {};
  return { ...extension, host, manager, gateway };
}

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
