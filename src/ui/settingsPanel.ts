import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { readPresets, readTitleEffort, readTitleModel, selectedModel, validatePresets, validateTitleEffort, validateTitleModel } from '../core/settings';
import { messageOf, object, string, type Model } from '../core/types';
import { settingsHtml } from './settingsHtml';
import { isExternalModel, parseResponsesModel, providerModels, readProviders, validateProviders, type ResponsesProvider } from '../core/providers';
import { readTokenPrice, validateTokenPrice, type TokenPrice } from '../core/cost';
import type { ProviderCheck, ProviderCheckPurpose } from '../core/providerCheck';

interface SettingsHost {
  loadModels(): Promise<Model[]>;
  checkProvider(model: string, purpose: ProviderCheckPurpose, providers: ResponsesProvider[], signal: AbortSignal, progress: (check: ProviderCheck) => void): Promise<ProviderCheck>;
  providersChanged(): void;
  openCodexSettings(): Promise<void>;
  report(error: unknown): void;
}
interface Scope {
  id: string;
  label: string;
  target: vscode.ConfigurationTarget;
  field: 'globalValue' | 'workspaceValue' | 'workspaceFolderValue';
  uri?: vscode.Uri;
}

export class SettingsPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private saving = false;
  private operation?: { controller: AbortController; requestId: unknown };
  constructor(private readonly uri: vscode.Uri, private readonly host: SettingsHost) {}

  open(): void {
    if (this.panel) { this.panel.reveal(); void this.panel.webview.postMessage({ type: 'reload' }); return; }
    const panel = vscode.window.createWebviewPanel('codexDeck.settings', 'Codex Deck 設定', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.panel = panel;
    const webview = panel.webview;
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.uri, 'dist'), vscode.Uri.joinPath(this.uri, 'media')] };
    panel.iconPath = vscode.Uri.joinPath(this.uri, 'media', 'deck.svg');
    webview.html = settingsHtml({
      cspSource: webview.cspSource, nonce: randomBytes(18).toString('base64'),
      script: webview.asWebviewUri(vscode.Uri.joinPath(this.uri, 'dist', 'settings.js')).toString(),
      css: webview.asWebviewUri(vscode.Uri.joinPath(this.uri, 'media', 'settings.css')).toString(),
    });
    const receive = webview.onDidReceiveMessage(async value => {
      const message = object(value);
      try {
        if (message.type === 'cancelProviderCheck') { const operation = this.operation; if (operation && operation.requestId === message.requestId) operation.controller.abort(); return; }
        if (message.type === 'openCodexSettings') { await this.host.openCodexSettings(); return; }
        if (message.type === 'openOtherSettings') { await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:codex-deck.codex-deck'); return; }
        if (message.type !== 'loadSettings' && message.type !== 'saveSettings' && message.type !== 'checkProviderModel') return;
        if (this.saving) throw new Error('確認・保存中です。完了後に再読み込みしてください。');
        const scopes = this.scopes();
        const scope = scopes.find(scope => scope.id === string(message.scope, 'user'));
        if (!scope) throw new Error('保存先を選び直してください。');
        const saving = message.type === 'saveSettings';
        const checking = message.type === 'checkProviderModel';
        const operation = { controller: new AbortController(), requestId: message.requestId };
        if (saving || checking) { this.saving = true; this.operation = operation; }
        const signal = operation.controller.signal;
        try {
          const storedProviders = readProviders(this.read(scopes[0]!, 'providers'));
          const providers = saving || checking ? validateProviders(message.providers ?? storedProviders) : storedProviders;
          if (checking) {
            const post = (result: ProviderCheck) => { if (this.panel === panel) void webview.postMessage({ type: 'providerCheckState', requestId: message.requestId, result }); };
            const result = await this.host.checkProvider(string(message.model), message.purpose === 'title' ? 'title' : 'task', providers, signal, post);
            if (this.panel === panel) void webview.postMessage({ type: 'providerCheckDone', requestId: message.requestId, result });
            return;
          }
          let modelError = '';
          const catalog = await this.host.loadModels().catch(error => { this.host.report(error); modelError = `モデル一覧: ${messageOf(error)}`; return [] as Model[]; });
          const models = [...catalog.filter(model => !parseResponsesModel(model.id)), ...providerModels(providers)];
          if (saving) {
            const titleModel = validateTitleModel(message.titleModel, models);
            const presets = validatePresets(message.presets, models);
            const titleEffort = validateTitleEffort(message.titleEffort, selectedModel(models, titleModel));
            const titlePricing = isExternalModel(titleModel) && message.titlePricing !== undefined ? validateTokenPrice(message.titlePricing) : undefined;
            signal.throwIfAborted();
            if (this.panel === panel) void webview.postMessage({ type: 'settingsSaving', requestId: message.requestId });
            await this.save(scope, presets, titleModel, titleEffort, titlePricing);
            if (JSON.stringify(providers) !== JSON.stringify(storedProviders)) {
              await vscode.workspace.getConfiguration('codexDeck').update('providers', providers, vscode.ConfigurationTarget.Global);
              this.host.providersChanged();
            }
          }
          if (this.panel === panel) void webview.postMessage({ type: 'settingsState', requestId: message.requestId, saved: saving,
            scopes: scopes.map(({ id, label }) => ({ id, label })), scope: scope.id,
            presets: readPresets(this.read(scope, 'presets')), titleModel: readTitleModel(this.read(scope, 'titleModel')),
            titleEffort: readTitleEffort(this.read(scope, 'titleEffort')), titlePricing: readTokenPrice(this.read(scope, 'titlePricing')), providers, models, modelError });
        } finally { if (this.operation === operation) { this.saving = false; this.operation = undefined; } }
      } catch (error) {
        this.host.report(error);
        if (this.panel === panel) void webview.postMessage({ type: 'settingsError', requestId: message.requestId, message: messageOf(error) });
      }
    });
    panel.onDidDispose(() => { receive.dispose(); if (this.panel === panel) { this.panel = undefined; this.operation?.controller.abort(); } });
  }

  private scopes(): Scope[] {
    const scopes: Scope[] = [{ id: 'user', label: 'ユーザー', target: vscode.ConfigurationTarget.Global, field: 'globalValue' }];
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length || vscode.workspace.workspaceFile) scopes.push({ id: 'workspace', label: 'ワークスペース', target: vscode.ConfigurationTarget.Workspace, field: 'workspaceValue' });
    if (folders.length > 1) for (const folder of folders) scopes.push({ id: `folder:${folder.uri.toString()}`, label: `フォルダー: ${folder.name}`, target: vscode.ConfigurationTarget.WorkspaceFolder, field: 'workspaceFolderValue', uri: folder.uri });
    return scopes;
  }
  private read(scope: Scope, key: string): unknown {
    const config = vscode.workspace.getConfiguration('codexDeck', scope.uri);
    const value = config.inspect<unknown>(key);
    return (scope.field === 'workspaceFolderValue' ? value?.workspaceFolderValue : undefined)
      ?? (scope.field !== 'globalValue' ? value?.workspaceValue : undefined) ?? value?.globalValue ?? value?.defaultValue;
  }
  private async save(scope: Scope, presets: ReturnType<typeof validatePresets>, titleModel: string, titleEffort: string, titlePricing?: TokenPrice): Promise<void> {
    const config = vscode.workspace.getConfiguration('codexDeck', scope.uri);
    await config.update('presets', presets, scope.target);
    await config.update('titleModel', titleModel, scope.target);
    await config.update('titleEffort', titleEffort, scope.target);
    await config.update('titlePricing', titlePricing, scope.target);
  }
  dispose(): void { this.panel?.dispose(); }
}
