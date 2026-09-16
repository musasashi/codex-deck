import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { array, object, string, messageOf, statusLabel, type JsonObject, type Model, type Task, type TaskStatus } from '../core/types';
import { TaskManager } from '../core/taskManager';
import { readPresets, taskPresets } from '../core/settings';
import { withHuggingFaceModels } from '../core/huggingFace';
import { chatHtml } from './html';
import { readQuestionPresets } from '../core/questionPresets';

function taskIcon(uri: vscode.Uri, status: TaskStatus): { light: vscode.Uri; dark: vscode.Uri } {
  return {
    light: vscode.Uri.joinPath(uri, 'media', 'task-status', 'light', `${status}.svg`),
    dark: vscode.Uri.joinPath(uri, 'media', 'task-status', 'dark', `${status}.svg`),
  };
}

function taskViewType(id: string): string { return `codexDeck.task.${encodeURIComponent(id)}`; }

export interface PanelHost {
  models: Model[];
  command(task: Task, message: JsonObject): Promise<JsonObject | void>;
  connect(): Promise<void>;
  report(error: unknown): void;
}

export class TaskPanels implements vscode.WebviewPanelSerializer, vscode.Disposable {
  private panels = new Map<string, vscode.WebviewPanel>();
  private serializers = new Map<string, vscode.Disposable>();
  private ready = new Set<string>();
  private pendingMessages = new Map<string, JsonObject[]>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private subscriptions: (() => void)[];
  private stopping = false;
  constructor(private readonly uri: vscode.Uri, private readonly manager: TaskManager, private readonly host: PanelHost) {
    this.subscriptions = [manager.changed.subscribe(task => {
      if (task) this.update(task.id); else for (const id of this.panels.keys()) this.update(id);
    })];
    const configuration = vscode.workspace.onDidChangeConfiguration(event => {
      for (const task of manager.openTasks) {
        if (event.affectsConfiguration('codexDeck', vscode.Uri.file(task.cwd))) this.update(task.id);
      }
    });
    this.subscriptions.push(() => configuration.dispose());
    const windowState = vscode.window.onDidChangeWindowState(state => {
      if (state.focused && this.activeId) this.post(this.activeId);
    });
    this.subscriptions.push(() => windowState.dispose());
    for (const task of manager.openTasks) this.registerSerializer(task.id);
  }
  get activeId(): string | undefined { return [...this.panels].find(([, panel]) => panel.active)?.[0]; }
  idForEditorResource(resourcePath: string): string | undefined {
    // VS Code tab menus pass webview-panel/webview-<viewType>-<resource UUID>.
    const match = /^\/?webview-panel\/webview-codexDeck\.task\.(.+)-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.exec(resourcePath);
    return match ? decodeURIComponent(match[1]!) : undefined;
  }
  private registerSerializer(id: string): void {
    const viewType = taskViewType(id);
    if (!this.serializers.has(viewType)) this.serializers.set(viewType, vscode.window.registerWebviewPanelSerializer(viewType, this));
  }
  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const id = string(object(state).taskId);
    if (!id || !this.manager.tasks.has(id)) { panel.dispose(); return; }
    const existing = this.panels.get(id);
    if (existing) { panel.dispose(); existing.reveal(); return; }
    if (panel.viewType === 'codexDeck.task') {
      panel.dispose();
      this.open(this.manager.get(id));
    } else {
      this.manager.open(id);
      this.bind(panel, this.manager.get(id));
    }
    try { await this.host.connect(); await this.manager.restore(id); }
    catch (error) { this.host.report(error); }
  }
  open(task: Task): void {
    const existing = this.panels.get(task.id);
    if (existing) { existing.reveal(existing.viewColumn); return; }
    this.manager.open(task.id);
    this.registerSerializer(task.id);
    const panel = vscode.window.createWebviewPanel(taskViewType(task.id), task.title, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.bind(panel, task);
  }
  async close(id: string): Promise<void> {
    const panel = this.panels.get(id);
    if (panel) { panel.dispose(); return; }
    // A restored tab may not have been deserialized yet.
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
      tab.input instanceof vscode.TabInputWebview && tab.input.viewType === `mainThreadWebview-${taskViewType(id)}`);
    if (!tabs.length || await vscode.window.tabGroups.close(tabs)) this.manager.close(id);
  }
  private bind(panel: vscode.WebviewPanel, task: Task): void {
    this.panels.set(task.id, panel);
    const webview = panel.webview;
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.uri, 'dist'), vscode.Uri.joinPath(this.uri, 'media')] };
    webview.html = this.html(webview);
    const receive = webview.onDidReceiveMessage(async (value: unknown) => {
      const message = object(value);
      try {
        if (message.type === 'ready') {
          this.ready.add(task.id);
          this.post(task.id);
          void this.postKeybindings(task.id);
          for (const pending of this.pendingMessages.get(task.id) ?? []) void webview.postMessage(pending);
          this.pendingMessages.delete(task.id);
          return;
        }
        if (message.type === 'keybindings') {
          await this.postKeybindings(task.id);
          return;
        }
        if (message.type === 'read') {
          if (panel.active && vscode.window.state.focused) this.manager.markRead(task.id, string(message.turnId));
          return;
        }
        const response = await this.host.command(task, message);
        if (response && this.panels.get(task.id) === panel) void webview.postMessage(response);
        if (message.type === 'send') {
          this.post(task.id);
          void webview.postMessage({ type: 'sent', sendId: string(message.sendId), text: string(message.text) });
        }
      } catch (error) {
        task.error = messageOf(error);
        this.update(task.id);
        this.host.report(error);
        if (message.type === 'selectionAction') void webview.postMessage({ type: 'selectionResult', requestId: message.requestId });
        void webview.postMessage({ type: 'failure', ...(message.type === 'answer' ? { requestId: string(message.requestId) } : {}),
          ...(message.type === 'send' ? { sendId: string(message.sendId) } : {}) });
      }
    });
    const viewState = panel.onDidChangeViewState(() => {
      if (panel.active) this.post(task.id);
    });
    panel.onDidDispose(() => {
      receive.dispose();
      viewState.dispose();
      if (this.panels.get(task.id) !== panel) return;
      this.panels.delete(task.id);
      this.ready.delete(task.id);
      this.pendingMessages.delete(task.id);
      const timer = this.timers.get(task.id);
      if (timer) clearTimeout(timer);
      this.timers.delete(task.id);
      if (!this.stopping) this.manager.close(task.id);
    });
    this.post(task.id);
  }
  update(id: string): void {
    if (!this.panels.has(id) || this.timers.has(id)) return;
    this.timers.set(id, setTimeout(() => { this.timers.delete(id); this.post(id); }, 75));
  }
  message(id: string, message: JsonObject): void {
    const panel = this.panels.get(id);
    if (!panel) return;
    if (this.ready.has(id)) void panel.webview.postMessage(message);
    else this.pendingMessages.set(id, [...(this.pendingMessages.get(id) ?? []), message]);
  }
  broadcast(message: JsonObject): void { for (const id of this.panels.keys()) this.message(id, message); }
  private async postKeybindings(id: string): Promise<void> {
    const panel = this.panels.get(id);
    if (!panel) return;
    let cyclePreset = '';
    try {
      // VS Code's command palette lookup reflects user overrides and removed bindings.
      const commands = await vscode.commands.executeCommand<unknown>('_getAllCommands');
      const command = array(commands).map(object).find(command => command.command === 'codexDeck.cyclePreset');
      const keybinding = string(command?.keybinding).trim();
      if (keybinding !== 'Not set') cyclePreset = keybinding;
    } catch { /* Keep the tooltip usable if the internal lookup is unavailable. */ }
    if (this.panels.get(id) === panel) void panel.webview.postMessage({ type: 'keybindings', cyclePreset });
  }
  private post(id: string): void {
    const panel = this.panels.get(id);
    if (!panel) return;
    const task = this.manager.get(id);
    panel.title = task.title;
    panel.iconPath = taskIcon(this.uri, task.status);
    const config = vscode.workspace.getConfiguration('codexDeck', vscode.Uri.file(task.cwd));
    const models = withHuggingFaceModels(this.host.models, [...readPresets(config.get('presets')).map(preset => preset.model), task.settings.model, task.effectiveModel]);
    void panel.webview.postMessage({ type: 'state', task, models, connected: this.manager.gateway.connected,
      questionPresets: readQuestionPresets(config.get('questionPresets')).map(({ id, name }) => ({ id, name })),
      usage: this.manager.usage, presetCount: taskPresets(task, readPresets(config.get('presets'))).length, enterBehavior: config.get<string>('composerEnterBehavior', 'modEnter') });
  }
  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(18).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.uri, 'dist', 'webview.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.uri, 'media', 'chat.css'));
    return chatHtml({ cspSource: webview.cspSource, script: script.toString(), css: css.toString(), nonce });
  }
  dispose(): void {
    this.stopping = true;
    for (const dispose of this.subscriptions) dispose();
    for (const serializer of this.serializers.values()) serializer.dispose();
    this.serializers.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const panel of this.panels.values()) panel.dispose();
    this.panels.clear();
  }
}

export class TaskTree implements vscode.TreeDataProvider<Task>, vscode.FileDecorationProvider, vscode.Disposable {
  private emitter = new vscode.EventEmitter<Task | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private decorations = new vscode.EventEmitter<vscode.Uri | undefined>();
  readonly onDidChangeFileDecorations = this.decorations.event;
  private decorationProvider: vscode.Disposable;
  private unsubscribe: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly uri: vscode.Uri, private readonly manager: TaskManager) {
    this.decorationProvider = vscode.window.registerFileDecorationProvider(this);
    this.unsubscribe = manager.changed.subscribe(() => {
      if (this.timer) return;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.emitter.fire(undefined);
        this.decorations.fire(undefined);
      }, 100);
    });
  }
  getTreeItem(task: Task): vscode.TreeItem {
    const item = new vscode.TreeItem(task.title);
    item.id = task.id;
    item.resourceUri = vscode.Uri.from({ scheme: 'codex-deck-task', path: `/${task.id}` });
    item.description = statusLabel[task.status];
    item.tooltip = `${task.title}\n${statusLabel[task.status]}${task.unreadTurnId ? '\n回答完了・未読' : ''}\n${task.cwd}`;
    item.accessibilityInformation = { label: `${task.title}、${statusLabel[task.status]}${task.unreadTurnId ? '、回答完了・未読' : ''}` };
    item.command = { command: 'codexDeck.openTask', title: '開く', arguments: [task.id] };
    item.contextValue = task.activeTurnId || task.status === 'waiting' || task.busy ? 'runningTask' : task.threadId ? 'task' : 'draftTask';
    item.iconPath = taskIcon(this.uri, task.status);
    return item;
  }
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'codex-deck-task') return;
    const task = this.manager.tasks.get(uri.path.slice(1));
    if (task?.open && task.unreadTurnId) return new vscode.FileDecoration('●', '回答完了・未読', new vscode.ThemeColor('notificationsInfoIcon.foreground'));
  }
  getChildren(): Task[] { return this.manager.openTasks; }
  dispose(): void {
    this.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
    this.decorationProvider.dispose();
    this.decorations.dispose();
    this.emitter.dispose();
  }
}
