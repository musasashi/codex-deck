import * as vscode from 'vscode';
import { messageOf, type Thread } from '../core/types';
import type { ConfirmThreadDeletion, ThreadDeletionResult } from '../core/threadDeletion';

interface HistoryHost {
  load(cursor: string | undefined, archived: boolean): Promise<{ threads: Thread[]; cursor?: string }>;
  archive(thread: Thread): Promise<void>;
  delete(thread: Thread, confirm: ConfirmThreadDeletion): Promise<ThreadDeletionResult>;
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
  const deleteButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: '完全に削除' };
  const deletingButton = { iconPath: new vscode.ThemeIcon('loading~spin'), tooltip: '削除対象を確認・削除中…' };
  let threads: Thread[] = [];
  let cursor: string | undefined;
  let nextCursor: string | undefined;
  let archived = false;
  let confirming: string | undefined;
  let archiving: string | undefined;
  let deleting: string | undefined;
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
      detail: deleting === thread.id ? '削除対象を確認・削除中…' : archiving === thread.id ? 'アーカイブ中…' : confirming === thread.id ? '確認：右のチェックをもう一度クリックしてアーカイブ'
        : errors.get(thread.id) ?? `${archived ? '復元して開く · ' : ''}${thread.updatedAt ? new Date(thread.updatedAt * 1000).toLocaleString() : ' '}`,
      buttons: archived ? [deleting === thread.id ? deletingButton : deleteButton] : [archiving === thread.id ? pendingButton : confirming === thread.id ? confirmButton : archiveButton],
    }));
    if (nextCursor) items.push({ label: '次の50件を表示', action: 'next' });
    items.push({ label: archived ? '通常の履歴に戻る' : 'アーカイブした履歴', action: 'toggle' });
    picker.items = items;
    const retained = items.find(item => item.action === active?.action && item.thread?.id === active?.thread?.id);
    if (retained) picker.activeItems = [retained];
  }
  async function load(): Promise<void> {
    if (closed || loading || archiving || deleting) return;
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
    if (closed || loading || archiving || deleting || archived || !thread || !threads.some(candidate => candidate.id === thread.id)) return;
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
  async function remove(item: HistoryItem): Promise<void> {
    const thread = item.thread;
    if (closed || loading || archiving || deleting || !archived || !thread || !threads.some(candidate => candidate.id === thread.id)) return;
    deleting = thread.id; errors.delete(thread.id);
    picker.busy = true; picker.enabled = false; picker.ignoreFocusOut = true; render();
    try {
      const result = await host.delete(thread, async targets => {
        if (closed) return false;
        const bulk = targets.length > 1;
        const action = bulk ? 'まとめて完全に削除' : '完全に削除';
        const title = targets[0]!.title;
        const chosen = await vscode.window.showWarningMessage(
          bulk ? `「${title}」と関連するチャットをまとめて完全に削除しますか？` : `「${title}」を完全に削除しますか？`,
          { modal: true, detail: `${bulk ? 'この履歴を参照する分岐先・子チャットも削除対象です。アーカイブ状態にかかわらず、以下のチャットを削除します。\n\n' : ''}削除するチャット（${targets.length}件）:\n${targets.map(target => `・${target.title}`).join('\n')}\n\nこの操作は取り消せません。` },
          action,
        );
        return !closed && chosen === action;
      });
      const deleted = new Set(result.deletedIds);
      threads = threads.filter(candidate => !deleted.has(candidate.id));
      if (result.error) throw result.error;
    } catch (error) {
      host.report(error); errors.set(thread.id, `完全削除できませんでした：${messageOf(error)}`);
    } finally {
      deleting = undefined;
      if (!closed) { picker.busy = false; picker.enabled = true; picker.ignoreFocusOut = false; render(); }
    }
  }
  try {
    return await new Promise<HistorySelection | undefined>(resolve => {
      subscriptions.push(
        picker.onDidHide(() => { closed = true; resolve(undefined); }),
        picker.onDidChangeValue(() => { if (confirming) { confirming = undefined; render(); } }),
        picker.onDidTriggerButton(() => { void load(); }),
        picker.onDidTriggerItemButton(event => { if (archived) void remove(event.item); else void archive(event.item); }),
        picker.onDidAccept(() => {
          if (loading || archiving || deleting) return;
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
