import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { readPresets, readTitleEffort, readTitleModel, selectedModel, validatePresets, validateTitleEffort, validateTitleModel } from '../core/settings';
import { messageOf, object, string, type Model } from '../core/types';
import { settingsHtml } from './settingsHtml';
import { isHuggingFaceModel } from '../core/huggingFace';
import { readTokenPrice, validateTokenPrice, type TokenPrice } from '../core/cost';
import { huggingFaceCheckKey, type HuggingFaceCheck, type HuggingFaceCheckPurpose } from '../core/huggingFaceCheck';

interface SettingsHost {
  loadModels(): Promise<Model[]>;
  checkHuggingFace(model: string, purpose: HuggingFaceCheckPurpose, signal: AbortSignal, progress: (check: HuggingFaceCheck) => void): Promise<HuggingFaceCheck>;
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
  private checks = new Map<string, { result: HuggingFaceCheck; time: number }>();
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
        if (message.type === 'cancelHfCheck') { const operation = this.operation; if (operation && operation.requestId === message.requestId) operation.controller.abort(); return; }
        if (message.type === 'openCodexSettings') { await this.host.openCodexSettings(); return; }
        if (message.type === 'openOtherSettings') { await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:codex-deck.codex-deck'); return; }
        if (message.type !== 'loadSettings' && message.type !== 'saveSettings' && message.type !== 'checkHfModel') return;
        if (this.saving) throw new Error('確認・保存中です。完了後に再読み込みしてください。');
        const scopes = this.scopes();
        const scope = scopes.find(scope => scope.id === string(message.scope, 'user'));
        if (!scope) throw new Error('保存先を選び直してください。');
        const saving = message.type === 'saveSettings';
        const checking = message.type === 'checkHfModel';
        const operation = { controller: new AbortController(), requestId: message.requestId };
        if (saving || checking) { this.saving = true; this.operation = operation; }
        else this.checks.clear();
        const signal = operation.controller.signal;
        const check = async (model: string, purpose: HuggingFaceCheckPurpose): Promise<HuggingFaceCheck> => {
          const key = huggingFaceCheckKey(model, purpose);
          const cached = this.checks.get(key);
          const post = (result: HuggingFaceCheck) => { if (this.panel === panel) void webview.postMessage({ type: 'hfCheckState', requestId: message.requestId, result }); };
          signal.throwIfAborted();
          const result = !checking && cached && Date.now() - cached.time < 10 * 60_000 ? cached.result
            : await this.host.checkHuggingFace(model, purpose, signal, post);
          post(result);
          if (result.status === 'passed' && !signal.aborted) this.checks.set(key, { result, time: Date.now() });
          else this.checks.delete(key);
          return result;
        };
        try {
          if (checking) {
            const result = await check(string(message.model), message.purpose === 'title' ? 'title' : 'task');
            if (this.panel === panel) void webview.postMessage({ type: 'hfCheckDone', requestId: message.requestId, result });
            return;
          }
          let modelError = '';
          const models = await this.host.loadModels().catch(error => { this.host.report(error); modelError = `モデル一覧: ${messageOf(error)}`; return [] as Model[]; });
          if (saving) {
            const titleModel = validateTitleModel(message.titleModel, models);
            const presets = validatePresets(message.presets, models);
            const titleEffort = validateTitleEffort(message.titleEffort, selectedModel(models, titleModel));
            const titlePricing = isHuggingFaceModel(titleModel) ? validateTokenPrice(message.titlePricing) : undefined;
            for (const model of new Set(presets.filter(preset => isHuggingFaceModel(preset.model)).map(preset => preset.model))) {
              const result = await check(model, 'task');
              if (result.status !== 'passed') throw new Error(`${model}：${result.message} 設定は保存していません。`);
            }
            if (isHuggingFaceModel(titleModel) && !presets.some(preset => preset.model === titleModel)) {
              const result = await check(titleModel, 'title');
              if (result.status !== 'passed') throw new Error(`${titleModel}：${result.message} 設定は保存していません。`);
            }
            signal.throwIfAborted();
            if (this.panel === panel) void webview.postMessage({ type: 'settingsSaving', requestId: message.requestId });
            await this.save(scope, presets, titleModel, titleEffort, titlePricing);
          }
          if (this.panel === panel) void webview.postMessage({ type: 'settingsState', requestId: message.requestId, saved: saving,
            scopes: scopes.map(({ id, label }) => ({ id, label })), scope: scope.id,
            presets: readPresets(this.read(scope, 'presets')), titleModel: readTitleModel(this.read(scope, 'titleModel')),
            titleEffort: readTitleEffort(this.read(scope, 'titleEffort')), titlePricing: readTokenPrice(this.read(scope, 'titlePricing')), models, modelError });
        } finally { if (this.operation === operation) { this.saving = false; this.operation = undefined; } }
      } catch (error) {
        this.host.report(error);
        if (this.panel === panel) void webview.postMessage({ type: 'settingsError', requestId: message.requestId, message: messageOf(error) });
      }
    });
    panel.onDidDispose(() => { receive.dispose(); if (this.panel === panel) { this.panel = undefined; this.operation?.controller.abort(); this.checks.clear(); } });
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
