import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { Task } from '../../src/core/types';
import { testUnreadTasks } from './unread';
import { testTaskTitles } from './titles';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('codex-deck.codex-deck');
  assert.ok(extension, 'extension must be registered');
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('codexDeck.newTask'));
  const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputWebview);
  const started = performance.now();
  const history = vscode.commands.executeCommand('codexDeck.history');
  try {
    await new Promise(resolve => setTimeout(resolve, 350));
    await vscode.commands.executeCommand('type', { text: 'History fixture' });
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    while (!tabs().length && performance.now() - started < 1000) await new Promise(resolve => setTimeout(resolve, 20));
    const elapsed = performance.now() - started;
    assert.equal(tabs().length, 1, 'a history row must be selectable within one second despite slow catalog requests');
    assert.ok(elapsed < 1000, `history selection took ${Math.round(elapsed)}ms`);
    console.log(`Extension Host: history selected in ${Math.round(elapsed)}ms with 2000ms catalog latency.`);
    await history;
    await vscode.commands.executeCommand('codexDeck.copyTaskDeepLink');
    assert.equal(await vscode.env.clipboard.readText(), 'codex://threads/history-fixture');
    await vscode.commands.executeCommand('codexDeck.copyTaskMarkdown');
    assert.equal(await vscode.env.clipboard.readText(), '# History fixture\n');
    await vscode.window.tabGroups.close(tabs()[0]!);
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await history;
  }
  const config = vscode.workspace.getConfiguration('codexDeck', vscode.workspace.workspaceFolders?.[0]?.uri);
  assert.deepEqual(config.get('presets'), [{ model: 'latest', effort: 'high', mode: 'auto-review' }]);
  const first = await vscode.commands.executeCommand<Task>('codexDeck.newTask');
  assert.deepEqual(first.settings, { model: 'latest', effort: 'high', mode: 'auto-review' });
  let second: Task;
  try {
    await config.update('presets', [
      { model: 'test-model', effort: 'test-effort', mode: 'workspace-write' },
      { model: 'latest', effort: 'high', mode: 'auto-review' },
    ], vscode.ConfigurationTarget.Workspace);
    second = await vscode.commands.executeCommand<Task>('codexDeck.newTask');
    assert.deepEqual(second.settings, { model: 'test-model', effort: 'test-effort', mode: 'workspace-write' });
    assert.deepEqual(first.settings, { model: 'latest', effort: 'high', mode: 'auto-review' }, 'editing presets must not change existing tasks');
  } finally {
    await config.update('presets', undefined, vscode.ConfigurationTarget.Workspace);
  }
  assert.ok(first?.id); assert.ok(second?.id); assert.notEqual(first.id, second.id);
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(tabs().length, 2, 'two task editors must be open');
  await vscode.env.clipboard.writeText('unchanged');
  await vscode.commands.executeCommand('codexDeck.copyTaskDeepLink', { id: first.id });
  assert.equal(await vscode.env.clipboard.readText(), 'unchanged', 'a draft must not produce an unreadable link');
  assert.equal(first.threadId, undefined, 'copying a draft must not create a conversation');
  await vscode.commands.executeCommand('codexDeck.copyTaskMarkdown', first.id);
  assert.equal(await vscode.env.clipboard.readText(), '# 新規タスク\n');
  console.log('Extension Host: task deep links, draft copies, Markdown clipboard, and context task selection passed.');
  await vscode.commands.executeCommand('codexDeck.openTask', first.id);
  assert.equal(tabs().length, 2, 'opening an existing task must reuse its tab');
  await vscode.commands.executeCommand('workbench.action.moveEditorToNextGroup');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(tabs().length, 2, 'splitting the editor must retain both tasks');
  await vscode.commands.executeCommand('codexDeck.closeTask', first.id);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(tabs().length, 1, 'close must dispose the corresponding editor');
  await vscode.commands.executeCommand('codexDeck.closeTask', second.id);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(tabs().length, 0);
  await vscode.commands.executeCommand('codexDeck.settings');
  const settingsStarted = performance.now();
  while (!tabs().length && performance.now() - settingsStarted < 2000) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(tabs().length, 1, 'settings must open in an editor tab');
  assert.equal(tabs()[0]?.label, 'Codex Deck 設定');
  await vscode.commands.executeCommand('codexDeck.settings');
  assert.equal(tabs().length, 1, 'settings must reuse its existing tab');
  await vscode.window.tabGroups.close(tabs()[0]!);
  console.log('Extension Host: first preset as task defaults, settings tab, activation, two task tabs, tab reuse, split editors, and close passed.');
  await testUnreadTasks(extension.extensionUri);
  await testTaskTitles(extension.extensionUri);
}
