import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { TaskManager } from '../../src/core/taskManager';
import { readTitleEffort, readTitleModel } from '../../src/core/settings';
import { TaskPanels, TaskTree } from '../../src/ui/panels';
import { deferred, FakeGateway } from '../helpers';

async function until(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(condition(), message);
}

export async function testTaskTitles(uri: vscode.Uri): Promise<void> {
  const folder = vscode.workspace.workspaceFolders![0]!.uri;
  const config = vscode.workspace.getConfiguration('codexDeck', folder);
  assert.equal(config.get('titleModel'), 'latest');
  assert.equal(config.get('titleEffort'), 'lowest');
  const gateway = new FakeGateway();
  const title = deferred<string>();
  let selectedModel: string | undefined;
  let selectedEffort: string | undefined;
  gateway.generateTitle = async request => { selectedModel = request.model; selectedEffort = request.effort; return title.promise; };
  const manager = new TaskManager(gateway, { async save() {} }, [], { schedule: false,
    titleModel: cwd => readTitleModel(vscode.workspace.getConfiguration('codexDeck', vscode.Uri.file(cwd)).get('titleModel')),
    titleEffort: cwd => readTitleEffort(vscode.workspace.getConfiguration('codexDeck', vscode.Uri.file(cwd)).get('titleEffort')),
  });
  const panels = new TaskPanels(uri, manager, {
    models: [], async connect() {}, report(error) { throw error; },
    async command(_task, message) {
      if (message.type === 'composerCatalog') return { type: 'composerCatalog', requestId: message.requestId, skills: [] };
    },
  });
  const tree = new TaskTree(uri, manager);
  const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs);
  try {
    const task = manager.create(folder.fsPath);
    panels.open(task);
    await config.update('titleModel', 'summary-model', vscode.ConfigurationTarget.Workspace);
    await config.update('titleEffort', 'high', vscode.ConfigurationTarget.Workspace);
    await manager.send(task.id, 'ログインでエラーが出ます\n原因を調べて修正してください。');
    await until(() => selectedModel !== undefined && tabs().some(tab => tab.label === 'ログインでエラーが出ます'), 'the provisional name must be shown before generation completes');
    assert.equal(selectedModel, 'summary-model', 'the title job must use the current workspace setting');
    assert.equal(selectedEffort, 'high', 'the title job must use the current workspace effort');
    assert.equal(task.settings.model, undefined, 'title settings must not change the task model');
    assert.equal(task.settings.effort, undefined, 'title settings must not change the task effort');
    title.resolve('ログインエラーを修正');
    await until(() => tabs().some(tab => tab.label === 'ログインエラーを修正'), 'generated names must update the editor tab');
    assert.equal(tree.getTreeItem(task).label, 'ログインエラーを修正');
    assert.equal(task.status, 'running');
    assert.equal(task.unreadTurnId, undefined);
    await manager.rename(task.id, 'ログイン調査');
    await until(() => tabs().some(tab => tab.label === 'ログイン調査'), 'manual names must update the same tab');
    assert.equal(tree.getTreeItem(task).label, 'ログイン調査');
    console.log('Extension Host: workspace title model and effort, provisional and generated tab names, task tree, manual rename, and task isolation passed.');
  } finally {
    await config.update('titleModel', undefined, vscode.ConfigurationTarget.Workspace);
    await config.update('titleEffort', undefined, vscode.ConfigurationTarget.Workspace);
    tree.dispose(); panels.dispose(); manager.dispose(); await manager.flush();
  }
}
