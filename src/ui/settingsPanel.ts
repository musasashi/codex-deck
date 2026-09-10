import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { readPresets, readTitleEffort, readTitleModel, selectedModel, validatePresets, validateTitleEffort, validateTitleModel } from '../core/settings';
import { messageOf, object, string, type Model } from '../core/types';
import { settingsHtml } from './settingsHtml';

interface SettingsHost {
  loadModels(): Promise<Model[]>;
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
        if (message.type === 'openCodexSettings') { await this.host.openCodexSettings(); return; }
        if (message.type === 'openOtherSettings') { await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:codex-deck.codex-deck'); return; }
        if (message.type !== 'loadSettings' && message.type !== 'saveSettings') return;
        if (this.saving) throw new Error('設定を保存中です。完了後に再読み込みしてください。');
        const scopes = this.scopes();
        const scope = scopes.find(scope => scope.id === string(message.scope, 'user'));
        if (!scope) throw new Error('保存先を選び直してください。');
        const saving = message.type === 'saveSettings';
        if (saving) this.saving = true;
        try {
          const models = await this.host.loadModels();
          if (saving) {
            const titleModel = validateTitleModel(message.titleModel, models);
            await this.save(scope, validatePresets(message.presets, models), titleModel, validateTitleEffort(message.titleEffort, selectedModel(models, titleModel)));
          }
          if (this.panel === panel) void webview.postMessage({ type: 'settingsState', requestId: message.requestId, saved: saving,
            scopes: scopes.map(({ id, label }) => ({ id, label })), scope: scope.id,
            presets: readPresets(this.read(scope, 'presets')), titleModel: readTitleModel(this.read(scope, 'titleModel')),
            titleEffort: readTitleEffort(this.read(scope, 'titleEffort')), models });
        } finally { if (saving) this.saving = false; }
      } catch (error) {
        this.host.report(error);
        if (this.panel === panel) void webview.postMessage({ type: 'settingsError', requestId: message.requestId, message: messageOf(error) });
      }
    });
    panel.onDidDispose(() => { receive.dispose(); if (this.panel === panel) this.panel = undefined; });
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
  private async save(scope: Scope, presets: ReturnType<typeof validatePresets>, titleModel: string, titleEffort: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('codexDeck', scope.uri);
    await config.update('presets', presets, scope.target);
    await config.update('titleModel', titleModel, scope.target);
    await config.update('titleEffort', titleEffort, scope.target);
  }
  dispose(): void { this.panel?.dispose(); }
}
