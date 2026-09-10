import * as vscode from 'vscode';
import { messageOf, type Thread } from '../core/types';

interface HistoryHost {
  load(cursor: string | undefined, archived: boolean): Promise<{ threads: Thread[]; cursor?: string }>;
  archive(thread: Thread): Promise<void>;
  report(error: unknown): void;
}
interface HistoryItem extends vscode.QuickPickItem {
  action: 'open' | 'next' | 'toggle';
  thread?: Thread;
}
interface HistorySelection { thread: Thread; archived: boolean }

export async function pickHistory(host: HistoryHost): Promise<HistorySelection | undefined> {
  const picker = vscode.window.createQuickPick<HistoryItem>();
  picker.title = 'チャット履歴';
  picker.placeholder = 'タイトル・フォルダーで検索';
  picker.matchOnDescription = true;
  picker.keepScrollPosition = true;
  picker.buttons = [{ iconPath: new vscode.ThemeIcon('refresh'), tooltip: '履歴を再読み込み' }];
  const archiveButton = { iconPath: new vscode.ThemeIcon('archive'), tooltip: 'アーカイブ' };
  const confirmButton = { iconPath: new vscode.ThemeIcon('check'), tooltip: 'アーカイブを確認（もう一度クリック）' };
  const pendingButton = { iconPath: new vscode.ThemeIcon('loading~spin'), tooltip: 'アーカイブ中…' };
  let threads: Thread[] = [];
  let cursor: string | undefined;
  let nextCursor: string | undefined;
  let archived = false;
  let confirming: string | undefined;
  let archiving: string | undefined;
  let loading = false;
  let closed = false;
  const errors = new Map<string, string>();
  const subscriptions: vscode.Disposable[] = [];

  function render(): void {
    if (closed) return;
    const active = picker.activeItems[0];
    const items: HistoryItem[] = threads.map(thread => ({
      action: 'open', thread, label: thread.title, description: thread.cwd,
      // Keep a detail line in every state so confirmation never moves the button.
      detail: archiving === thread.id ? 'アーカイブ中…' : confirming === thread.id ? '確認：右のチェックをもう一度クリックしてアーカイブ'
        : errors.get(thread.id) ?? `${archived ? '復元して開く · ' : ''}${thread.updatedAt ? new Date(thread.updatedAt * 1000).toLocaleString() : ' '}`,
      buttons: archived ? [] : [archiving === thread.id ? pendingButton : confirming === thread.id ? confirmButton : archiveButton],
    }));
    if (nextCursor) items.push({ label: '次の50件を表示', action: 'next' });
    items.push({ label: archived ? '通常の履歴に戻る' : 'アーカイブした履歴', action: 'toggle' });
    picker.items = items;
    const retained = items.find(item => item.action === active?.action && item.thread?.id === active?.thread?.id);
    if (retained) picker.activeItems = [retained];
  }
  async function load(): Promise<void> {
    if (closed || loading || archiving) return;
    loading = true; confirming = undefined; errors.clear();
    picker.title = archived ? 'アーカイブしたチャット履歴' : 'チャット履歴';
    picker.busy = true;
    threads = []; nextCursor = undefined; picker.items = [];
    try {
      const page = await host.load(cursor, archived);
      threads = page.threads; nextCursor = page.cursor;
    } catch (error) {
      host.report(error);
      if (!closed) picker.title = `履歴を取得できませんでした：${messageOf(error)}`;
    } finally {
      loading = false;
      if (!closed) { picker.busy = false; render(); }
    }
  }
  async function archive(item: HistoryItem): Promise<void> {
    const thread = item.thread;
    if (closed || loading || archiving || archived || !thread || !threads.some(candidate => candidate.id === thread.id)) return;
    if (confirming !== thread.id) {
      confirming = thread.id; errors.delete(thread.id); render(); return;
    }
    confirming = undefined; archiving = thread.id;
    picker.busy = true; picker.enabled = false; render();
    try {
      await host.archive(thread);
      threads = threads.filter(candidate => candidate.id !== thread.id);
    } catch (error) {
      host.report(error); errors.set(thread.id, `アーカイブできませんでした：${messageOf(error)}`);
    } finally {
      archiving = undefined;
      if (!closed) { picker.busy = false; picker.enabled = true; render(); }
    }
  }
  try {
    return await new Promise<HistorySelection | undefined>(resolve => {
      subscriptions.push(
        picker.onDidHide(() => { closed = true; resolve(undefined); }),
        picker.onDidChangeValue(() => { if (confirming) { confirming = undefined; render(); } }),
        picker.onDidTriggerButton(() => { void load(); }),
        picker.onDidTriggerItemButton(event => { void archive(event.item); }),
        picker.onDidAccept(() => {
          if (loading || archiving) return;
          const selected = picker.selectedItems[0];
          if (!selected) return;
          if (selected.action === 'open' && selected.thread) { resolve({ thread: selected.thread, archived }); picker.hide(); return; }
          if (selected.action === 'next') cursor = nextCursor;
          else { archived = !archived; cursor = undefined; }
          confirming = undefined; picker.value = ''; void load();
        }),
      );
      picker.show();
      void load();
    });
  } finally {
    closed = true;
    for (const subscription of subscriptions) subscription.dispose();
    picker.dispose();
  }
}
