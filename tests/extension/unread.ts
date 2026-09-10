import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { TaskManager } from '../../src/core/taskManager';
import { TaskPanels, TaskTree } from '../../src/ui/panels';
import { FakeGateway, thread } from '../helpers';

async function until(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(condition(), message);
}

export async function testUnreadTasks(uri: vscode.Uri): Promise<void> {
  const gateway = new FakeGateway();
  const manager = new TaskManager(gateway, { async save() {} }, [], { schedule: false });
  const panels = new TaskPanels(uri, manager, {
    models: [], async connect() {}, report(error) { throw error; },
    async command(_task, message) {
      if (message.type === 'composerCatalog') return { type: 'composerCatalog', requestId: message.requestId, skills: [] };
    },
  });
  const tree = new TaskTree(uri, manager);
  let decorationChanges = 0;
  const subscription = tree.onDidChangeFileDecorations(() => { decorationChanges++; });
  try {
    const firstThread = thread('unread-first');
    const secondThread = thread('unread-second');
    gateway.threads.set(firstThread.id, firstThread);
    gateway.threads.set(secondThread.id, secondThread);
    const first = manager.adoptThread(firstThread);
    const second = manager.adoptThread(secondThread);
    panels.open(first);
    gateway.finish(first.threadId!, 'active-answer', 'completed');
    await until(() => !first.unreadTurnId, 'an answer rendered in the active task must be read');

    panels.open(second);
    await until(() => panels.activeId === second.id, 'the second task must become active');
    gateway.finish(first.threadId!, 'background-answer', 'completed');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(first.unreadTurnId, 'background-answer', 'hidden webviews must not acknowledge answers');
    const item = tree.getTreeItem(first);
    const decoration = tree.provideFileDecoration(item.resourceUri!);
    assert.equal(decoration?.badge, '●');
    assert.equal(decoration?.color?.id, 'notificationsInfoIcon.foreground');
    assert.match(item.accessibilityInformation!.label, /回答完了・未読/);
    assert.ok(decorationChanges > 0, 'completion must refresh the tree decorations');
    assert.equal(tree.provideFileDecoration(vscode.Uri.file('/unrelated')), undefined);

    panels.open(first);
    await until(() => !first.unreadTurnId, 'selecting the task must clear its unread answer after rendering');
    assert.equal(tree.provideFileDecoration(item.resourceUri!), undefined);
    await vscode.commands.executeCommand('workbench.action.moveEditorToNextGroup');
    await until(() => panels.activeId === first.id && vscode.window.tabGroups.all.length > 1, 'the first task must be active in a split editor');
    gateway.finish(second.threadId!, 'split-answer', 'completed');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(second.unreadTurnId, 'split-answer', 'a visible task in an inactive editor group must remain unread');
    panels.open(second);
    await until(() => !second.unreadTurnId, 'activating the other editor group must mark its answer read');
    gateway.finish(first.threadId!, 'closed-answer', 'completed');
    panels.close(first.id);
    assert.equal(tree.provideFileDecoration(item.resourceUri!), undefined, 'closed tasks must not have a decoration');
    console.log('Extension Host: unread decorations, rendered acknowledgements, hidden tasks, split editors, and close passed.');
  } finally {
    subscription.dispose();
    tree.dispose();
    panels.dispose();
    manager.dispose();
    await manager.flush();
  }
}
