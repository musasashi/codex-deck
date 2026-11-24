import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { imageViewerHtml } from './html';

export class ImageViewer implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private opening?: Promise<void>;
  private image?: { source: vscode.Uri | string; label: string };
  private ready = false;
  private disposed = false;

  constructor(private readonly extensionUri: vscode.Uri, private readonly report: (error: unknown) => void) {}

  async open(source: vscode.Uri | string, label: string): Promise<void> {
    this.image = { source, label };
    if (this.panel) {
      this.panel.reveal(this.panel.viewColumn);
      this.present();
      return;
    }
    this.opening ??= this.createWindow().finally(() => { this.opening = undefined; });
    await this.opening;
  }

  private async createWindow(): Promise<void> {
    const existingColumns = new Set(vscode.window.tabGroups.all.map(group => group.viewColumn));
    await vscode.commands.executeCommand('workbench.action.newEmptyEditorWindow');
    if (this.disposed || !this.image) return;
    const column = vscode.window.tabGroups.all.find(group => !existingColumns.has(group.viewColumn))?.viewColumn ?? vscode.ViewColumn.Active;
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel('codexDeck.imageViewer', this.image.label, column,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [dist] });
    this.panel = panel;
    panel.onDidDispose(() => { this.panel = undefined; this.image = undefined; this.ready = false; });
    let enterFullscreen = false;
    const fullscreenWhenActive = () => {
      if (!enterFullscreen || !panel.active) return;
      enterFullscreen = false;
      void vscode.commands.executeCommand('workbench.action.toggleFullScreen').then(undefined, this.report);
    };
    panel.onDidChangeViewState(fullscreenWhenActive);
    panel.webview.onDidReceiveMessage(message => {
      if (message.type === 'close') { panel.dispose(); return; }
      if (message.type !== 'ready') return;
      if (!this.ready) enterFullscreen = message.fullscreen === false;
      this.ready = true;
      this.present();
      fullscreenWhenActive();
    });
    panel.webview.html = imageViewerHtml({ cspSource: panel.webview.cspSource, nonce: randomBytes(18).toString('hex'),
      script: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'imageViewer.js')).toString(),
      css: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'chat.css')).toString() });
  }

  private present(): void {
    if (!this.panel || !this.image || !this.ready) return;
    const { source, label } = this.image;
    const webview = this.panel.webview;
    const roots = [vscode.Uri.joinPath(this.extensionUri, 'dist')];
    if (typeof source !== 'string') roots.push(vscode.Uri.file(path.dirname(source.fsPath)));
    webview.options = { enableScripts: true, localResourceRoots: roots };
    this.panel.title = label;
    const src = typeof source === 'string' ? source : webview.asWebviewUri(source).toString();
    void webview.postMessage({ type: 'image', src, label });
  }

  dispose(): void { this.disposed = true; this.panel?.dispose(); }
}
