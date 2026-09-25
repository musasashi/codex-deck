import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { AppServerClient } from './appServer/client';
import { StdioConnection } from './appServer/rpc';
import { appServerEnvironment, requireWslHost } from './appServer/environment';
import { HuggingFaceProxy } from './appServer/huggingFaceProxy';
import { ResponsesConnections } from './appServer/responsesConnections';
import { TaskManager, readTaskRecords } from './core/taskManager';
import { deleteThreadHistory } from './core/threadDeletion';
import { messageMarkdown, taskMarkdown } from './core/taskCopy';
import { linkedThreadId, taskDeepLink } from './core/taskReferences';
import { selectionReference } from './core/selectionReference';
import { questionPresetMessage, readQuestionPresets, validateQuestionPreset } from './core/questionPresets';
import { IMAGE_FORMAT_ERROR, isImageDataUrl, MAX_ATTACHMENT_BYTES } from './core/attachments';
import { configPermissionMode, parseSlashCommand, permissionOptions, permissionPresets, resolveSkillMentions, slashCommands } from './core/composer';
import { workingDiff } from './core/gitDiff';
import { isHuggingFaceModel, withHuggingFaceModels } from './core/huggingFace';
import { isExternalModel, parseResponsesModel, providerModels, readProviders, sameTaskProvider, type ResponsesProvider } from './core/providers';
import { readTokenPrice } from './core/cost';
import { availableResetCredits, resetCreditExpiry } from './core/usage';
import { nextPresetIndex, readPresets, readTitleEffort, readTitleModel, resolveRunSettings, selectedModel, taskPresets, validatePreset } from './core/settings';
import { array, object, string, messageOf, statusLabel, isTaskRunning, type ComposerCatalog, type ExecutionMode, type JsonObject, type Model, type Task } from './core/types';
import { TaskPanels, TaskTree, type PanelHost } from './ui/panels';
import { SettingsPanel } from './ui/settingsPanel';
import { pickHistory } from './ui/historyPicker';

const exec = promisify(execFile);
const STORAGE_KEY = 'codexDeck.tasks';
let deck: DeckExtension | undefined;

export function activate(context: vscode.ExtensionContext): void {
  requireWslHost(vscode.env.remoteName);
  deck = new DeckExtension(context);
}
export async function deactivate(): Promise<void> { await deck?.shutdown(); deck = undefined; }

class DeckExtension implements PanelHost {
  readonly client = new AppServerClient(() => this.providers(), (model, effort) => this.responses.config(model, this.providers(), effort));
  readonly manager: TaskManager;
  readonly panels: TaskPanels;
  private readonly settingsPanel: SettingsPanel;
  models: Model[] = [];
  accountLabel = '未接続';
  private output = vscode.window.createOutputChannel('Codex Deck');
  private connection = new StdioConnection(text => this.output.append(text));
  private huggingFace = new HuggingFaceProxy();
  private responses = new ResponsesConnections();
  private connecting?: Promise<void>;
  private catalogSequence = 0;
  private composerCatalogs = new Map<string, ComposerCatalog>();
  private composerLoads = new Map<string, Promise<ComposerCatalog>>();
  private pendingLogin?: string;
  private stopping = false;
  private virtualDocuments = new Map<string, string>();
  private presetSelections = new WeakMap<Task, { signature: string; index: number }>();
  private questionStarts = new WeakMap<Task, { requestId: string; promise: Promise<void> }>();
  private resetCreditBusy = false;
  private resetCreditEpoch = 0;
  private resetCreditKeys = new Map<string, string>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.manager = new TaskManager(this.client, { save: async records => { await context.workspaceState.update(STORAGE_KEY, { version: 1, tasks: records }); } }, readTaskRecords(context.workspaceState.get(STORAGE_KEY)), {
      titleModel: cwd => readTitleModel(vscode.workspace.getConfiguration('codexDeck', vscode.Uri.file(cwd)).get('titleModel')),
      titleEffort: cwd => readTitleEffort(vscode.workspace.getConfiguration('codexDeck', vscode.Uri.file(cwd)).get('titleEffort')),
      titlePricing: cwd => readTokenPrice(vscode.workspace.getConfiguration('codexDeck', vscode.Uri.file(cwd)).get('titlePricing')),
    });
    // Hidden tabs are deserialized only when shown, so keep their saved open state.
    this.panels = new TaskPanels(context.extensionUri, this.manager, this);
    this.settingsPanel = new SettingsPanel(context.extensionUri, {
      loadModels: async () => {
        await this.connect();
        const sequence = ++this.catalogSequence;
        const models = await this.client.listModels(true);
        if (sequence === this.catalogSequence && this.client.connected && !this.stopping) {
          this.models = models; this.manager.changed.emit(undefined);
        }
        return models;
      },
      checkProvider: async (model, purpose, providers, signal, progress) => {
        if (!vscode.workspace.isTrusted) throw new Error('ワークスペースを信頼してからAPIに接続してください。');
        if (!isHuggingFaceModel(model)) return this.responses.check(model, providers, purpose, signal, progress);
        await this.connect(); signal.throwIfAborted(); return this.huggingFace.check(model, purpose, signal, progress);
      },
      providersChanged: () => {
        this.models = [...this.models.filter(model => !parseResponsesModel(model.id)), ...providerModels(this.providers())];
        this.manager.changed.emit(undefined);
      },
      openCodexSettings: () => this.codexSettings(), report: error => this.report(error),
    });
    const tree = new TaskTree(context.extensionUri, this.manager);
    context.subscriptions.push(this.output, this.settingsPanel, tree, vscode.window.registerTreeDataProvider('codexDeck.tasks', tree), vscode.window.registerWebviewPanelSerializer('codexDeck.task', this.panels),
      vscode.window.registerTreeDataProvider<vscode.TreeItem>('codexDeck.launcher', { getTreeItem: item => item, getChildren: () => [] }),
      vscode.workspace.registerTextDocumentContentProvider('codex-deck', { provideTextDocumentContent: uri => this.virtualDocuments.get(uri.toString()) ?? '' }));
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => { if (document.uri.scheme === 'codex-deck') this.virtualDocuments.delete(document.uri.toString()); }));
    const errorSubscription = this.manager.errors.subscribe(message => this.report(new Error(message)));
    const attentionSubscription = this.manager.attention.subscribe(task => {
      if (task.open && this.panels.activeId === task.id) return;
      this.output.appendLine(`${task.title}: ${statusLabel[task.status]}`);
    });
    const eventsSubscription = this.client.events.subscribe(event => {
      if (event.type === 'account' || event.type === 'connection') {
        this.resetCreditEpoch++;
        if (event.type === 'account') this.resetCreditKeys.clear();
      }
      if (event.type === 'skills') this.invalidateComposerCatalogs();
      if (event.type === 'account') {
        if (event.success !== undefined) {
          this.pendingLogin = undefined;
          if (event.success) this.output.appendLine('Codexにサインインしました。');
          else if (event.error) this.report(new Error(event.error));
        }
        void this.refreshCatalog();
      }
    });
    context.subscriptions.push({ dispose: () => { errorSubscription(); attentionSubscription(); eventsSubscription(); } });
    const commands: Record<string, (arg?: unknown) => Promise<unknown> | unknown> = {
      newTask: () => this.newTask(), history: () => this.history(),
      openTask: async arg => { const task = await this.task(arg); this.panels.open(task); await this.connect(); await this.manager.restore(task.id); },
      closeTask: async arg => this.panels.close((await this.task(arg)).id),
      stopTask: async arg => { const task = await this.task(arg); this.manager.setAutoResume(task.id, false); await this.connect(); await this.manager.stop(task.id); },
      renameTask: async arg => this.rename(await this.task(arg)), archiveTask: async arg => this.archive(await this.task(arg)), forkTask: async arg => this.fork(await this.task(arg)),
      copyTaskDeepLink: async arg => this.copyTaskDeepLink(await this.task(arg)),
      copyTaskMarkdown: async arg => this.copyTaskMarkdown(await this.task(arg)),
      mentionSelection: arg => this.mentionSelection(arg), addFile: arg => this.addFile(arg instanceof vscode.Uri ? arg : undefined),
      signIn: () => this.signIn(), signOut: () => this.signOut(), settings: () => this.settings(),
      cyclePreset: async arg => this.cyclePreset(await this.task(arg)),
      mcp: () => this.mcp(), skills: async () => this.skills(await this.task()), review: async () => this.review(await this.task()),
      showDiff: async () => this.showDiff(await this.task()), worktree: () => this.worktree(),
      reconnect: async () => { if (!this.client.connected) { this.connection.dispose(); await this.connect(); } else await this.refreshCatalog(); },
      menu: async () => this.menu(await this.task()),
    };
    for (const name of ['archiveTask', 'forkTask', 'renameTask']) commands[`editor.${name}`] = commands[name]!;
    for (const [name, action] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand(`codexDeck.${name}`, async (arg?: unknown) => {
      try { return await action(arg); } catch (error) { this.report(error); }
    }));
  }
  report(error: unknown): void {
    this.output.appendLine(messageOf(error));
  }
  private providers(): ResponsesProvider[] { return readProviders(vscode.workspace.getConfiguration('codexDeck').get('providers', [])); }
  async connect(): Promise<void> {
    if (this.client.connected) return;
    if (this.connecting) return this.connecting;
    const work = (async () => {
      if (!vscode.workspace.isTrusted) throw new Error('ワークスペースを信頼してからCodexを起動してください。');
      this.connection.dispose();
      this.huggingFace.dispose();
      const executable = vscode.workspace.getConfiguration('codexDeck').get<string>('cliPath', 'codex').trim();
      if (!executable) throw new Error('codexDeck.cliPathにWSL内の公式Codex CLIの実行ファイルを指定してください。');
      if (/\\|^[a-z]:|\.(?:exe|cmd|bat)$/i.test(executable)) throw new Error('codexDeck.cliPathにWSL内のCodex CLIを指定してください。Windows版の実行ファイルは使用できません。');
      this.invalidateComposerCatalogs();
      const env = await appServerEnvironment();
      if (this.stopping) return;
      const hfUrl = env.HF_TOKEN ? await this.huggingFace.start(env.HF_TOKEN) : undefined;
      if (this.stopping) { this.huggingFace.dispose(); return; }
      try { await this.client.connect(this.connection.start(executable, this.workspaceCwd() || undefined, env, hfUrl)); }
      catch (error) { this.huggingFace.dispose(); throw error; }
      void this.refreshCatalog().catch(error => this.report(error));
      for (const task of this.manager.openTasks) {
        if (task.threadId) void this.manager.restore(task.id).catch(error => this.report(error));
      }
    })();
    this.connecting = work;
    try { await work; } finally { this.connecting = undefined; }
  }
  private async refreshCatalog(): Promise<void> {
    if (!this.client.connected) return;
    const sequence = ++this.catalogSequence;
    const [models, account] = await Promise.allSettled([this.client.listModels(true), this.client.account()]);
    // A background read must not overwrite a newer sign-in or reconnect refresh.
    if (sequence !== this.catalogSequence || !this.client.connected || this.stopping) return;
    if (models.status === 'fulfilled') this.models = models.value;
    else this.output.appendLine(`モデル一覧: ${messageOf(models.reason)}`);
    if (account.status === 'fulfilled') {
      const value = object(account.value.account);
      this.accountLabel = value.type === 'chatgpt' ? `ChatGPT ${string(value.planType)}` : value.type === 'apiKey' ? 'API key' : value.type ? string(value.type) : account.value.requiresOpenaiAuth === false ? 'カスタムプロバイダー' : '未サインイン';
    } else this.output.appendLine(`アカウント情報: ${messageOf(account.reason)}`);
    this.manager.changed.emit(undefined);
  }
  private invalidateComposerCatalogs(): void {
    this.composerCatalogs.clear(); this.composerLoads.clear();
    this.panels.broadcast({ type: 'catalogInvalidated' });
  }
  private async composerCatalog(task: Task): Promise<ComposerCatalog> {
    await this.connect();
    const cwd = task.cwd;
    const cached = this.composerCatalogs.get(cwd);
    if (cached) return cached;
    const existing = this.composerLoads.get(cwd);
    if (existing) return existing;
    const work = Promise.all([this.client.listSkills(cwd), this.client.readConfig(cwd)]).then(([skills, config]) => {
      const catalog = { skills, permissionMode: configPermissionMode(config) };
      if (this.composerLoads.get(cwd) === work) this.composerCatalogs.set(cwd, catalog);
      return catalog;
    });
    this.composerLoads.set(cwd, work);
    try { return await work; }
    finally { if (this.composerLoads.get(cwd) === work) this.composerLoads.delete(cwd); }
  }
  private workspaceCwd(): string { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''; }
  private async chooseCwd(): Promise<string> {
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length === 1) return folders[0]!.uri.fsPath;
    if (folders && folders.length > 1) {
      const folder = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'タスクのワークスペース' });
      if (!folder) throw new Error('ワークスペースが選択されませんでした。');
      return folder.uri.fsPath;
    }
    const selection = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: '作業フォルダーを選択' });
    if (!selection?.[0]) throw new Error('作業フォルダーが選択されませんでした。');
    return selection[0].fsPath;
  }
  private async newTask(cwd?: string): Promise<Task> {
    const folder = cwd ?? await this.chooseCwd();
    const config = vscode.workspace.getConfiguration('codexDeck', vscode.Uri.file(folder));
    const task = this.manager.create(folder, readPresets(config.get('presets'))[0]!);
    this.panels.open(task);
    void this.connect().catch(error => this.report(error));
    return task;
  }
  private async task(arg?: unknown): Promise<Task> {
    if (object(arg).scheme === 'webview-panel') {
      const id = this.panels.idForEditorResource(string(object(arg).path));
      if (!id) throw new Error('対象のタスクが見つかりません。');
      return this.manager.get(id);
    }
    const id = typeof arg === 'string' ? arg : string(object(arg).id) || this.panels.activeId;
    if (id) return this.manager.get(id);
    const open = this.manager.openTasks;
    if (open.length === 1) return open[0]!;
    if (open.length > 1) {
      const selected = await vscode.window.showQuickPick(open.map(task => ({ label: task.title, description: statusLabel[task.status], task })), { placeHolder: '対象のタスク' });
      if (selected) return selected.task;
      throw new Error('タスクが選択されませんでした。');
    }
    return this.newTask();
  }
  private async copyTaskDeepLink(task: Task): Promise<void> {
    await vscode.env.clipboard.writeText(taskDeepLink(task));
  }
  private async copyTaskMarkdown(task: Task): Promise<void> {
    if (task.threadId && !task.hydrated) { await this.connect(); await this.manager.restore(task.id); }
    await vscode.env.clipboard.writeText(taskMarkdown(task));
  }
  async command(task: Task, message: JsonObject): Promise<JsonObject | void> {
    switch (message.type) {
      case 'requestResetCredit': return this.requestResetCredit(task, message);
      case 'selectionAction': {
        const text = string(message.text), requestId = string(message.requestId);
        if (!requestId || !text.trim()) throw new Error('操作する文章を範囲選択してください。');
        if (text.length > 2 * 1024 * 1024) throw new Error('メッセージが大きすぎます。');
        if (message.action === 'copy') await vscode.env.clipboard.writeText(text);
        else if (message.action === 'mention') await this.mentionSelection({ codexDeckTaskId: task.id, codexDeckSelectionText: text });
        else if (message.action === 'question') {
          const previous = this.questionStarts.get(task);
          if (previous?.requestId === requestId) await previous.promise;
          else {
            const promise = this.startQuestion(task, string(message.questionPresetId), text);
            this.questionStarts.set(task, { requestId, promise });
            await promise;
          }
        } else throw new Error('選択範囲の操作が不正です。');
        return { type: 'selectionResult', requestId };
      }
      case 'copyCode':
        await vscode.env.clipboard.writeText(string(message.text));
        return { type: 'codeCopied', requestId: message.requestId };
      case 'copyMessage': case 'forkMessage': {
        const turn = task.turns.find(turn => turn.id === string(message.turnId));
        const item = turn?.items.find(item => item.id === string(message.itemId));
        const text = item && messageMarkdown(item);
        if (!turn || !item || text === undefined) throw new Error('対象のメッセージが見つかりません。');
        if (message.type === 'copyMessage') {
          await vscode.env.clipboard.writeText(text);
          return { type: 'messageCopied', turnId: turn.id, itemId: item.id };
        }
        if (item.kind === 'userMessage' || turn.status === 'inProgress' || task.activeTurnId === turn.id) throw new Error('応答が完了してから分岐してください。');
        await this.fork(task, turn.id); return;
      }
      case 'composerCatalog': {
        try { return { type: 'composerCatalog', requestId: message.requestId, ...(await this.composerCatalog(task)) }; }
        catch (error) { return { type: 'composerCatalog', requestId: message.requestId, skills: [], error: messageOf(error) }; }
      }
      case 'fileSearch': {
        const query = string(message.query);
        if (query.length > 1000) return;
        try { await this.connect(); return { type: 'fileSearch', requestId: message.requestId, files: await this.client.searchFiles(task.cwd, query) }; }
        catch (error) { return { type: 'fileSearch', requestId: message.requestId, files: [], error: messageOf(error) }; }
      }
      case 'autoResume':
        if (typeof message.enabled !== 'boolean') return;
        this.manager.setAutoResume(task.id, message.enabled); return;
      case 'removeAttachment': this.manager.removeAttachment(task.id, string(message.id)); return;
      case 'attach': await this.attachFiles(task); return;
      case 'pasteImages': {
        const urls = array(message.urls);
        if (!urls.length || !urls.every(isImageDataUrl)) return { type: 'imagesPasted', requestId: message.requestId, error: IMAGE_FORMAT_ERROR };
        for (const url of urls) this.manager.attach(task.id, { id: randomUUID(), label: '貼り付けた画像', input: { type: 'image', url } });
        return { type: 'imagesPasted', requestId: message.requestId, attachments: task.attachments };
      }
      case 'invalidJson': throw new Error('JSON形式の回答を確認してください。');
      case 'openLink': await this.openLink(task, string(message.url)); return;
      case 'settings': await this.updateSettings(task, message); return;
      case 'cyclePreset': this.cyclePreset(task); return;
      case 'menu': await this.menu(task); return;
      case 'account': await this.accountMenu(); return;
      case 'review': await this.review(task); return;
      case 'stop': this.manager.setAutoResume(task.id, false); await this.connect(); await this.manager.stop(task.id); return;
      case 'answer': await this.manager.answer(task.id, string(message.requestId), object(message.answer)); return;
      case 'send': {
        const text = string(message.text);
        if (text.length > 2 * 1024 * 1024) throw new Error('メッセージが大きすぎます。');
        if (await this.slash(task, text.trim(), message)) return;
        await this.send(task, text, message); return;
      }
    }
  }
  private async requestResetCredit(task: Task, message: JsonObject): Promise<JsonObject> {
    const result = { type: 'resetCreditResult', requestId: message.requestId };
    const creditId = string(message.creditId);
    if (!creditId || !string(message.requestId)) return { ...result, error: '使用するチケットを選択してください。' };
    if (this.resetCreditBusy) return { ...result, error: '別のチケット操作が進行中です。' };
    this.resetCreditBusy = true;
    const epoch = this.resetCreditEpoch;
    try {
      await this.manager.checkUsage();
      const snapshot = this.manager.usage;
      const credit = availableResetCredits(snapshot?.resetCredits).find(credit => credit.id === creditId);
      if (!credit || epoch !== this.resetCreditEpoch || !this.client.connected) throw new Error('このチケットは現在使用できません。残数と期限を確認してください。');
      const action = 'チケットを使用';
      const confirmed = await vscode.window.showWarningMessage('リセットチケットを1枚使用しますか？', {
        modal: true, detail: `${credit.title ?? 'Codex リセットチケット'}\n${resetCreditExpiry(credit.expiresAt)}\n\n使用するとCodexの使用量枠がリセットされます。`,
      }, action);
      if (confirmed !== action) return result;
      await this.manager.checkUsage();
      const current = availableResetCredits(this.manager.usage?.resetCredits).find(credit => credit.id === creditId);
      if (!current || current.expiresAt !== credit.expiresAt || this.manager.usage?.accountId !== snapshot?.accountId
        || epoch !== this.resetCreditEpoch || !this.client.connected || this.stopping || !task.open)
        throw new Error('チケットまたは接続の状態が変わりました。もう一度確認してください。');
      // Preserve the key after an uncertain response; retrying must not consume another credit.
      const key = this.resetCreditKeys.get(creditId) ?? randomUUID();
      this.resetCreditKeys.set(creditId, key);
      try {
        const outcome = await this.client.consumeResetCredit(creditId, key);
        this.resetCreditKeys.delete(creditId);
        const messages = {
          reset: 'チケットを1枚使用し、使用量枠をリセットしました。',
          nothingToReset: 'リセットが必要な使用量枠はありません。',
          noCredit: '使用可能なチケットがありません。',
          alreadyRedeemed: 'このチケットはすでに使用されています。',
        };
        return { ...result, message: messages[outcome] };
      } finally { await this.manager.checkUsage(); }
    } catch (error) { return { ...result, error: messageOf(error) }; }
    finally { this.resetCreditBusy = false; }
  }
  private async send(task: Task, text: string, message: JsonObject): Promise<void> {
    this.manager.prepareInput(task.id);
    await this.connect();
    const selected = array(message.skillPaths).filter((value): value is string => typeof value === 'string');
    const catalog = text.includes('$') || selected.length ? await this.composerCatalog(task) : { skills: [] };
    if (selected.some(path => !catalog.skills.some(skill => skill.path === path))) throw new Error('スキル一覧が更新されています。スキルを選び直してください。');
    const skills = resolveSkillMentions(text, catalog.skills, selected);
    await this.manager.send(task.id, text, skills.map(skill => ({ type: 'skill', name: skill.name, path: skill.path })), {
      clientId: string(message.sendId), attachmentIds: array(message.attachmentIds).filter((value): value is string => typeof value === 'string'),
    });
  }
  private async updateSettings(task: Task, message: JsonObject): Promise<void> {
    const mode = string(message.mode) as ExecutionMode;
    if (!['default', 'read-only', 'workspace-write', 'auto-review', 'danger-full-access'].includes(mode)) return;
    if (task.activeTurnId || task.busy) throw new Error('実行が完了してから設定を変更してください。');
    const model = string(message.model);
    const effort = string(message.effort);
    const selected = selectedModel(this.models, model || task.effectiveModel || 'latest');
    if (model && model !== 'latest' && !selected) throw new Error('モデル一覧を再取得してください。');
    if (effort && effort !== 'default' && (selected || model !== 'latest') && !selected?.efforts.some(candidate => candidate.id === effort)) throw new Error('このモデルで利用できる推論の強さを選択してください。');
    const pricing = !model || model === task.settings.model ? task.settings.pricing
      : readPresets(vscode.workspace.getConfiguration('codexDeck', vscode.Uri.file(task.cwd)).get('presets')).find(preset => preset.model === model)?.pricing;
    this.manager.updateSettings(task.id, { model: model || undefined, effort: effort === 'default' ? selected?.defaultEffort || undefined : effort || (model && model !== task.settings.model ? selected?.defaultEffort || undefined : undefined), mode,
      ...(pricing && isExternalModel(model || task.effectiveModel) ? { pricing } : {}) });
    this.presetSelections.delete(task);
  }
  private cyclePreset(task: Task): void {
    if (isTaskRunning(task) || task.busy) throw new Error('実行が完了してから設定を変更してください。');
    const presets = taskPresets(task, readPresets(vscode.workspace.getConfiguration('codexDeck', vscode.Uri.file(task.cwd)).get('presets')));
    if (!presets.length) return;
    const signature = JSON.stringify(presets);
    const previous = this.presetSelections.get(task);
    const index = nextPresetIndex(task.settings, presets, this.models, previous?.signature === signature ? previous.index : undefined);
    const settings = resolveRunSettings(validatePreset(presets[index], this.models), this.models);
    this.manager.updateSettings(task.id, settings);
    this.presetSelections.set(task, { signature, index });
  }
  private async history(): Promise<void> {
    const chosen = await pickHistory({
      load: async (cursor, archived) => { await this.connect(); return this.client.listThreads(cursor, archived); },
      archive: async thread => {
        const task = [...this.manager.tasks.values()].find(task => task.threadId === thread.id);
        if (task) await this.archive(task);
        else { await this.connect(); await this.client.archiveThread(thread.id); }
      },
      delete: async (thread, confirm) => {
        await this.connect();
        const validate = (threads: { id: string; title: string }[]): void => {
          const ids = new Set(threads.map(thread => thread.id));
          const running = [...this.manager.tasks.values()].find(task => task.threadId && ids.has(task.threadId) && (task.busy || isTaskRunning(task)));
          if (running) throw new Error(`「${running.title}」の実行を停止してから削除してください。`);
        };
        return deleteThreadHistory(thread, {
          list: () => this.client.listThreadsForDeletion(thread), validate,
          delete: async target => {
            validate([target]);
            const task = [...this.manager.tasks.values()].find(task => task.threadId === target.id);
            if (task) this.manager.setAutoResume(task.id, false);
            await this.client.deleteThread(target.id);
            this.manager.removeThread(target.id);
          },
        }, confirm);
      },
      report: error => this.report(error),
    });
    if (!chosen) return;
    const { thread, archived } = chosen;
    if (archived) await this.client.unarchiveThread(thread.id);
    const task = this.manager.openThread(thread.id, thread.title, thread.cwd);
    this.panels.open(task);
    await this.manager.restore(task.id);
  }
  private async rename(task: Task, provided?: string): Promise<void> {
    const name = provided ?? await vscode.window.showInputBox({ title: 'タスク名', value: task.title, validateInput: value => value.trim() ? undefined : '名前を入力してください。' });
    if (!name) return;
    await this.connect();
    await this.manager.rename(task.id, name);
  }
  private async archive(task: Task): Promise<void> {
    if (task.activeTurnId || task.busy) throw new Error('実行を停止してからアーカイブしてください。');
    this.manager.setAutoResume(task.id, false);
    if (task.threadId) { await this.connect(); await this.client.archiveThread(task.threadId); }
    await this.panels.close(task.id);
  }
  private async fork(task: Task, lastTurnId?: string): Promise<void> {
    await this.connect();
    const forked = await this.manager.fork(task.id, lastTurnId);
    this.panels.open(forked);
  }
  private async attachFiles(task: Task): Promise<void> {
    const files = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: true, openLabel: 'タスクに添付' });
    for (const file of files ?? []) await this.addFile(file, task);
  }
  private async addFile(uri?: vscode.Uri, target?: Task): Promise<void> {
    const source = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!source) throw new Error('追加するファイルを選択してください。');
    const task = target ?? await this.task();
    const ext = path.extname(source.fsPath).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
      const stat = await vscode.workspace.fs.stat(source);
      if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error('画像は8MB以下にしてください。');
      this.manager.attach(task.id, { id: randomUUID(), label: path.basename(source.fsPath), input: { type: 'localImage', path: source.fsPath } });
    } else {
      const document = await vscode.workspace.openTextDocument(source);
      const text = document.getText();
      if (Buffer.byteLength(text) > MAX_ATTACHMENT_BYTES) throw new Error('ファイルは8MB以下にしてください。');
      this.manager.attach(task.id, { id: randomUUID(), label: path.basename(source.fsPath), input: { type: 'text', text: `ファイル: ${source.fsPath}\n\n${text}` } });
    }
    this.panels.open(task);
  }
  private async mentionSelection(arg?: unknown): Promise<void> {
    const context = object(arg);
    const taskId = string(context.codexDeckTaskId);
    if (taskId) {
      const text = string(context.codexDeckSelectionText);
      if (!text.trim()) return;
      const task = this.manager.get(taskId);
      this.panels.open(task);
      this.panels.message(task.id, { type: 'insertReference', text: selectionReference(text, `会話「${task.title}」`) });
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) throw new Error('言及する文章を範囲選択してください。');
    const text = editor.document.getText(editor.selection);
    if (!text.trim()) return;
    const uri = editor.document.uri;
    const filename = uri.scheme === 'file' ? uri.fsPath : uri.toString();
    const { start, end } = editor.selection;
    const source = `${filename}:${start.line + 1}:${start.character + 1}-${end.line + 1}:${end.character + 1}`;
    const task = await this.task();
    this.panels.open(task);
    this.panels.message(task.id, { type: 'insertReference', text: selectionReference(text, source) });
  }
  private async startQuestion(source: Task, presetId: string, selectedText: string): Promise<void> {
    const link = taskDeepLink(source);
    const config = vscode.workspace.getConfiguration('codexDeck', vscode.Uri.file(source.cwd));
    const matches = readQuestionPresets(config.get('questionPresets')).filter(preset => preset.id === presetId);
    if (matches.length !== 1) throw new Error('質問プリセットが見つからないか、IDが重複しています。設定を確認してください。');
    await this.connect();
    const models = isHuggingFaceModel(matches[0]!.settings.model) ? [] : await this.client.listModels();
    const preset = validateQuestionPreset(matches[0]!, models);
    const text = questionPresetMessage(preset, selectedText, { title: source.title, link });
    const task = this.manager.create(source.cwd, resolveRunSettings(preset.settings, models));
    this.panels.open(task);
    this.panels.message(task.id, { type: 'initialQuestion', sendId: randomUUID(), text });
  }
  private async signIn(): Promise<void> {
    await this.connect();
    if (this.pendingLogin) throw new Error('サインイン手続き中です。アカウントメニューからキャンセルできます。');
    const option = await vscode.window.showQuickPick([
      { label: 'ChatGPTでサインイン', type: 'chatgpt' as const }, { label: 'ChatGPTのデバイスコードでサインイン', type: 'chatgptDeviceCode' as const }, { label: 'APIキーでサインイン', type: 'apiKey' as const },
    ], { title: 'Codexにサインイン' });
    if (!option) return;
    const apiKey = option.type === 'apiKey' ? await vscode.window.showInputBox({ title: 'OpenAI APIキー', password: true, ignoreFocusOut: true }) : undefined;
    if (option.type === 'apiKey' && !apiKey) return;
    const result = await this.client.login(option.type, apiKey);
    this.pendingLogin = typeof result.loginId === 'string' ? result.loginId : undefined;
    if (typeof result.authUrl === 'string') await this.openExternal(result.authUrl);
    if (typeof result.verificationUrl === 'string') {
      await this.showDocument('Codexサインイン.txt', `デバイスコード: ${string(result.userCode)}\n\n認証ページ: ${result.verificationUrl}\n\n認証ページでデバイスコードを入力してください。`, 'plaintext');
      await this.openExternal(result.verificationUrl);
    }
    await this.refreshCatalog();
  }
  private async signOut(): Promise<void> { await this.connect(); await this.client.logout(); await this.refreshCatalog(); }
  private async accountMenu(): Promise<void> {
    await this.connect();
    const choice = await vscode.window.showQuickPick(['サインイン', '使用量を表示', ...(this.pendingLogin ? ['サインインをキャンセル'] : []), 'サインアウト'], { title: this.accountLabel });
    if (choice === 'サインイン') await this.signIn();
    else if (choice === 'サインアウト') await this.signOut();
    else if (choice === '使用量を表示') { await this.manager.checkUsage(); await this.showJson('使用量', this.manager.usage); }
    else if (choice === 'サインインをキャンセル' && this.pendingLogin) { await this.client.cancelLogin(this.pendingLogin); this.pendingLogin = undefined; }
  }
  private async settings(): Promise<void> { this.settingsPanel.open(); }
  private async codexSettings(): Promise<void> {
    await this.connect();
    const selected = await vscode.window.showQuickPick(['有効なCodex設定を表示', 'Codex設定値を変更', 'MCPサーバー', '拡張機能の設定'], { title: 'Codex設定' });
    if (selected === '有効なCodex設定を表示') await this.showJson('Codex設定', await this.client.readConfig(this.workspaceCwd()));
    else if (selected === 'Codex設定値を変更') {
      const key = await vscode.window.showInputBox({ title: '変更する設定キー', prompt: '例: model、model_reasoning_effort、mcp_servers.server_name.url' });
      if (!key?.trim()) return;
      const value = await vscode.window.showInputBox({ title: `${key} の値 (JSON)`, prompt: '文字列は "..."、有効・無効は true / false', validateInput: input => { try { JSON.parse(input); return undefined; } catch { return 'JSON形式で入力してください。'; } } });
      if (value === undefined) return;
      await this.client.writeConfig(key.trim(), JSON.parse(value));
      this.invalidateComposerCatalogs();
      await this.refreshCatalog();
      this.output.appendLine('Codex設定を保存しました。新規タスクから適用されます。');
    } else if (selected === 'MCPサーバー') await this.mcp();
    else if (selected === '拡張機能の設定') await this.settings();
  }
  private async skills(task: Task): Promise<void> {
    const catalog = await this.composerCatalog(task);
    const choice = await vscode.window.showQuickPick(catalog.skills.map(skill => ({ label: `$${skill.name}`, description: skill.description, skill })), { title: 'スキル', matchOnDescription: true });
    if (choice) { this.panels.open(task); this.panels.message(task.id, { type: 'insertSkill', skill: choice.skill }); }
  }
  private async mcp(): Promise<void> {
    await this.connect();
    const servers = await this.client.listMcp();
    const choices = servers.map(value => { const server = object(value); return { label: string(server.name), description: string(server.authStatus), value: server }; });
    choices.push({ label: 'MCP設定を再読み込み', description: '', value: { reload: true } });
    const choice = await vscode.window.showQuickPick(choices, { title: 'MCPサーバー' });
    if (!choice) return;
    if (choice.value.reload) { await this.client.reloadMcp(); return; }
    const action = await vscode.window.showQuickPick(['詳細を表示', 'OAuthで接続'], { title: choice.label });
    if (action === '詳細を表示') await this.showJson(choice.label, choice.value);
    else if (action === 'OAuthで接続') { const response = await this.client.loginMcp(choice.label); await this.openExternal(string(response.authorizationUrl)); }
  }
  private async review(task: Task): Promise<void> {
    await this.connect();
    const kind = await vscode.window.showQuickPick(['未コミットの変更', 'ベースブランチと比較', 'コミットを指定', 'レビュー指示を入力'], { title: 'コードレビュー' });
    let target: JsonObject;
    if (kind === '未コミットの変更') target = { type: 'uncommittedChanges' };
    else if (kind === 'ベースブランチと比較') { const branch = await vscode.window.showInputBox({ title: 'ベースブランチ' }); if (!branch) return; target = { type: 'baseBranch', branch }; }
    else if (kind === 'コミットを指定') { const sha = await vscode.window.showInputBox({ title: 'コミットSHA' }); if (!sha) return; target = { type: 'commit', sha }; }
    else if (kind === 'レビュー指示を入力') { const instructions = await vscode.window.showInputBox({ title: 'レビュー指示' }); if (!instructions) return; target = { type: 'custom', instructions }; }
    else return;
    await this.manager.runReview(task.id, threadId => this.client.review(threadId, target));
  }
  private async showDiff(task: Task): Promise<void> {
    const diff = task.diff || task.turns.flatMap(turn => turn.items.filter(item => item.kind === 'fileChange').flatMap(item => array(item.data.changes).map(change => `--- ${string(object(change).path)}\n${string(object(change).diff)}`))).join('\n');
    if (!diff) { this.output.appendLine('このタスクには表示できる差分がありません。'); return; }
    await this.showDocument('変更の差分.diff', diff, 'diff');
  }
  private async showWorkingDiff(task: Task): Promise<void> {
    const diff = await workingDiff(task.cwd);
    if (!diff) { this.output.appendLine('作業ツリーに変更はありません。'); return; }
    await this.showDocument('作業ツリーの差分.diff', diff, 'diff');
  }
  private async worktree(): Promise<void> {
    const cwd = await this.chooseCwd();
    const { stdout } = await exec('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
    const root = stdout.trim();
    const name = `deck-${randomUUID().slice(0, 8)}`;
    const destination = await vscode.window.showInputBox({ title: '新しいworktreeの作成先', value: path.join(path.dirname(root), `${path.basename(root)}-${name}`), prompt: 'HEADから新規ブランチと作業フォルダーを作成します。' });
    if (!destination) return;
    if (!path.isAbsolute(destination)) throw new Error('絶対パスを指定してください。');
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'worktreeを作成しています' }, () => exec('git', ['-C', root, 'worktree', 'add', '-b', name, '--', destination]));
    await this.newTask(destination);
  }
  private async menu(task: Task): Promise<void> {
    const actions: Record<string, () => Promise<unknown>> = {
      '新規タスク': () => this.newTask(), 'チャット履歴': () => this.history(), '会話を分岐': () => this.fork(task), '名前を変更': () => this.rename(task),
      'モデルを選択': () => this.pickModel(task), '推論の強さを選択': () => this.pickEffort(task), 'Permissions': () => this.pickMode(task),
      '使用量と状態': () => this.showStatus(task), 'スキルを追加': () => this.skills(task), 'MCPサーバー': () => this.mcp(),
      '適用中のAGENTS.md': () => this.instructions(task), 'コードレビュー': () => this.review(task), '変更の差分': () => this.showDiff(task),
      '会話を圧縮': async () => { await this.connect(); await this.client.compactThread(await this.manager.ensureThread(task)); },
      '新しいworktreeでタスクを作成': () => this.worktree(), '設定': () => this.settings(), 'アカウント': () => this.accountMenu(),
      'App Serverに再接続': () => this.connect(), 'アーカイブ': () => this.archive(task),
    };
    const choice = await vscode.window.showQuickPick(Object.keys(actions), { title: task.title });
    if (choice) await actions[choice]?.();
  }
  private async pickModel(task: Task): Promise<void> {
    await this.connect();
    await this.refreshCatalog();
    const models = withHuggingFaceModels(this.models, [...readPresets(vscode.workspace.getConfiguration('codexDeck', vscode.Uri.file(task.cwd)).get('presets')).map(preset => preset.model), task.settings.model, task.effectiveModel])
      .filter(model => !task.threadId || sameTaskProvider(task, model.id));
    const choice = await vscode.window.showQuickPick(models.map(model => ({ label: model.label, description: model.description, id: model.id })), { title: 'モデル' });
    if (!choice) return;
    const model = selectedModel(models, choice.id)!;
    const effort = model.efforts.length ? await vscode.window.showQuickPick(model.efforts.map(effort => ({ label: effort.id, description: effort.description })), { title: '推論の強さ' }) : undefined;
    if (model.efforts.length && !effort) return;
    await this.updateSettings(task, { ...task.settings, model: choice.id, effort: effort?.label ?? '' });
  }
  private async pickEffort(task: Task): Promise<void> {
    await this.connect();
    await this.refreshCatalog();
    const model = selectedModel(this.models, task.settings.model ?? task.effectiveModel ?? 'latest');
    const choice = await vscode.window.showQuickPick((model?.efforts ?? []).map(effort => ({ label: effort.id, description: effort.description })), { title: '推論の強さ' });
    if (choice) await this.updateSettings(task, { ...task.settings, effort: choice.label });
  }
  private async pickMode(task: Task): Promise<void> {
    const catalog = await this.composerCatalog(task);
    const choice = await vscode.window.showQuickPick(permissionOptions(task.settings.mode, task.effectivePermissionMode ?? catalog.permissionMode).map(option => ({ ...option, description: permissionPresets.find(preset => preset.label === option.label)?.description })), { title: 'Update Model Permissions' });
    if (choice) await this.updateSettings(task, { ...task.settings, mode: choice.id });
  }
  private async showStatus(task: Task): Promise<void> {
    await this.connect(); await this.manager.checkUsage();
    await this.showJson('タスクの状態', { threadId: task.threadId, state: statusLabel[task.status], autoResume: task.autoResume, recoveryAt: task.recoveryAt ? new Date(task.recoveryAt).toISOString() : undefined, tokenUsage: task.tokenUsage, usage: this.manager.usage });
  }
  private async instructions(task: Task): Promise<void> {
    await this.connect(); await this.manager.ensureThread(task);
    if (!task.instructionSources.length) { this.output.appendLine('このタスクから取得できる指示ファイルはありません。'); return; }
    const choice = await vscode.window.showQuickPick(task.instructionSources, { title: '適用中の指示ファイル' });
    if (choice) await vscode.window.showTextDocument(vscode.Uri.file(choice));
  }
  private async slash(task: Task, text: string, message: JsonObject): Promise<boolean> {
    const command = parseSlashCommand(text);
    if (!command) return false;
    if (!slashCommands.some(item => item.name === command.name)) throw new Error(`/${command.name} はこの拡張では利用できません。/ でコマンド一覧を確認してください。`);
    if (command.args && !['rename', 'review', 'plan'].includes(command.name)) throw new Error(`/${command.name} は引数を指定せず実行してください。`);
    switch (command.name) {
      case 'plan':
        if (isTaskRunning(task) || task.busy) throw new Error('実行が完了してからプランモードを切り替えてください。');
        await this.connect(); await this.manager.restore(task.id);
        this.manager.setCollaborationMode(task.id, command.args || task.settings.collaborationMode !== 'plan' ? 'plan' : 'default');
        if (command.args) await this.send(task, command.args, message);
        break;
      case 'new': case 'clear': await this.newTask(task.cwd); break;
      case 'resume': await this.history(); break;
      case 'fork': await this.fork(task); break;
      case 'rename': await this.rename(task, command.args || undefined); break;
      case 'archive': await this.archive(task); break;
      case 'model': await this.pickModel(task); break;
      case 'permissions': await this.pickMode(task); break;
      case 'status': await this.showStatus(task); break;
      case 'mcp': await this.mcp(); break;
      case 'skills': await this.skills(task); break;
      case 'mention': this.panels.message(task.id, { type: 'insertMention' }); break;
      case 'diff': await this.showWorkingDiff(task); break;
      case 'copy': {
        const item = task.turns.filter(turn => turn.status !== 'inProgress').flatMap(turn => turn.items).findLast(item => item.kind === 'agentMessage' || item.kind === 'plan');
        if (!item) throw new Error('コピーできる応答がありません。');
        await vscode.env.clipboard.writeText(string(item.data.text)); break;
      }
      case 'logout': await this.signOut(); break;
      case 'quit': case 'exit': await this.panels.close(task.id); break;
      case 'review':
        if (!command.args) await this.review(task);
        else { await this.connect(); await this.manager.runReview(task.id, threadId => this.client.review(threadId, { type: 'custom', instructions: command.args })); }
        break;
      case 'compact': await this.connect(); await this.client.compactThread(await this.manager.ensureThread(task)); break;
      case 'init': await this.connect(); await this.manager.send(task.id, 'このプロジェクトを調査し、開発手順と作業上の指示をまとめたAGENTS.mdを作成してください。'); break;
    }
    return true;
  }
  private async openExternal(url: string): Promise<void> {
    const uri = vscode.Uri.parse(url, true);
    if (!['http', 'https'].includes(uri.scheme)) throw new Error('HTTPまたはHTTPSのリンクのみ開けます。');
    await vscode.env.openExternal(uri);
  }
  private async openLink(task: Task, value: string): Promise<void> {
    if (/^https?:\/\//i.test(value)) { await this.openExternal(value); return; }
    const threadId = linkedThreadId(value);
    if (threadId) {
      await this.connect();
      const linked = this.manager.openThread(threadId);
      this.panels.open(linked);
      await this.manager.restore(linked.id); return;
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(value)) throw new Error('この種類のリンクは開けません。');
    const match = /^(.*?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)?$/.exec(value);
    if (!match?.[1]) return;
    const filename = path.isAbsolute(match[1]) ? match[1] : path.resolve(task.cwd, match[1]);
    const line = Number(match[2] ?? match[3] ?? 1) - 1;
    await vscode.window.showTextDocument(vscode.Uri.file(filename), { viewColumn: vscode.ViewColumn.Beside, selection: new vscode.Range(Math.max(0, line), 0, Math.max(0, line), 0) });
  }
  private async showDocument(title: string, content: string, language: string): Promise<void> {
    const uri = vscode.Uri.from({ scheme: 'codex-deck', path: `/${randomUUID()}/${title}` });
    this.virtualDocuments.set(uri.toString(), content);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(document, language);
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: true });
  }
  private async showJson(title: string, value: unknown): Promise<void> { await this.showDocument(`${title}.json`, JSON.stringify(value, null, 2) ?? '{}', 'json'); }
  async shutdown(): Promise<void> {
    this.stopping = true;
    this.settingsPanel.dispose();
    this.panels.dispose();
    this.manager.dispose();
    await this.manager.checkpoint().catch(error => this.output.appendLine(messageOf(error)));
    this.connection.dispose(); this.huggingFace.dispose(); this.responses.dispose(); this.client.detach();
  }
}
