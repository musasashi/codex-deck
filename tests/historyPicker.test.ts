import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { deferred, thread } from './helpers';
import type { Thread } from '../src/core/types';
import type { ConfirmThreadDeletion, ThreadDeletionResult } from '../src/core/threadDeletion';

const bundle = buildSync({ entryPoints: [path.resolve('src/ui/historyPicker.ts')], bundle: true, write: false,
  platform: 'node', format: 'cjs', external: ['vscode'], logLevel: 'silent' }).outputFiles[0]!.text;
type Item = vscode.QuickPickItem & { thread?: Thread; action: string };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function pickerHarness(remove: (thread: Thread, confirm: ConfirmThreadDeletion) => Promise<ThreadDeletionResult>) {
  const callbacks: Record<string, (value?: any) => void> = {};
  const picker = {
    items: [] as Item[], activeItems: [] as Item[], selectedItems: [] as Item[], enabled: true, busy: false, ignoreFocusOut: false,
    show() {}, hide() { callbacks.hide!(); }, dispose() {},
    ...Object.fromEntries(['Hide', 'ChangeValue', 'TriggerButton', 'TriggerItemButton', 'Accept'].map(event => [
      `onDid${event}`, (callback: (value?: any) => void) => { callbacks[event[0]!.toLowerCase() + event.slice(1)] = callback; return { dispose() {} }; },
    ])),
  };
  const dialogs: { message: string; options: vscode.MessageOptions; action: string }[] = [];
  let answer: string | undefined;
  const api = {
    ThemeIcon: class { constructor(readonly id: string) {} },
    window: { createQuickPick: () => picker, showWarningMessage: async (message: string, options: vscode.MessageOptions, action: string) => {
      dialogs.push({ message, options, action }); return answer;
    } },
  };
  const module = { exports: {} as typeof import('../src/ui/historyPicker') };
  new Function('require', 'module', 'exports', bundle)(() => api, module, module.exports);
  const errors: unknown[] = [];
  let loads = 0;
  const result = module.exports.pickHistory({
    async load() { loads++; return { threads: [thread('root'), thread('fork')] }; },
    async archive() { assert.fail('deletion must not archive'); }, delete: remove,
    report: error => errors.push(error),
  });
  return { picker, dialogs, errors, result, loads: () => loads,
    answer(value?: string) { answer = value; },
    click(item = picker.items[0]!) { callbacks.triggerItemButton!({ item }); },
    async archived() { await tick(); picker.selectedItems = [picker.items.find(item => item.action === 'toggle')!]; callbacks.accept!(); await tick(); },
    refresh() { callbacks.triggerButton!(); },
  };
}

for (const approved of [false, true]) test(`archived trash confirms titles and ${approved ? 'removes all deleted rows' : 'preserves rows on cancel'}`, async () => {
  const h = pickerHarness(async (_root, confirm) => ({ deletedIds: await confirm([thread('root'), thread('fork')]) ? ['root', 'fork'] : [] }));
  try {
    await h.archived();
    assert.equal((h.picker.items[0]!.buttons![0]!.iconPath as vscode.ThemeIcon).id, 'trash');
    if (approved) h.answer('まとめて完全に削除');
    h.click(); await tick();
    assert.equal(h.dialogs.length, 1);
    assert.equal(h.dialogs[0]!.options.modal, true);
    assert.match(h.dialogs[0]!.options.detail!, /root[\s\S]*fork[\s\S]*取り消せません/);
    assert.equal(h.picker.items.filter(item => item.thread).length, approved ? 0 : 2);
    assert.equal(h.picker.enabled, true); assert.equal(h.picker.busy, false);
    assert.deepEqual(h.errors, []);
  } finally { h.picker.hide(); await h.result; }
});

test('pending deletes block repeated clicks and refresh; partial failures leave the remaining row retryable', async () => {
  const pending = deferred<ThreadDeletionResult>();
  let calls = 0;
  const h = pickerHarness(async () => { calls++; return pending.promise; });
  try {
    await h.archived();
    const root = h.picker.items[0]!;
    h.click(root); h.click(root); h.refresh();
    assert.equal(h.picker.enabled, false); assert.equal(h.picker.ignoreFocusOut, true);
    assert.equal(h.loads(), 2); assert.equal(calls, 1);
    pending.resolve({ deletedIds: ['fork'], error: new Error('fixture failure') }); await tick();
    assert.equal(h.picker.items.filter(item => item.thread).length, 1);
    assert.match(h.picker.items[0]!.detail!, /fixture failure/);
    assert.equal((h.picker.items[0]!.buttons![0]!.iconPath as vscode.ThemeIcon).id, 'trash');
    assert.equal(h.errors.length, 1); assert.equal(h.picker.enabled, true);
  } finally { h.picker.hide(); await h.result; }
});

test('closing history during reference lookup cancels the later confirmation', async () => {
  const pending = deferred<void>();
  let approved: boolean | undefined;
  const h = pickerHarness(async (root, confirm) => {
    await pending.promise; approved = await confirm([root]); return { deletedIds: [] };
  });
  await h.archived(); h.click(); h.picker.hide(); await h.result;
  pending.resolve(); await tick();
  assert.equal(approved, false); assert.equal(h.dialogs.length, 0);
});
