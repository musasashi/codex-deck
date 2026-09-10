import { _electron as electron, expect } from '@playwright/test';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

async function main(): Promise<void> {
  const folder = await mkdtemp(path.join(tmpdir(), 'codex-deck-history-'));
  const workspace = path.join(folder, 'workspace');
  const userData = path.join(folder, 'user-data');
  const log = path.join(folder, 'rpc.jsonl');
  await mkdir(workspace);
  await mkdir(path.join(userData, 'User'), { recursive: true });
  await writeFile(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'codexDeck.cliPath': path.resolve('tests/fixtures/mock-codex.cjs'),
    'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none',
  }));
  const executablePath = process.env.CODEX_DECK_VSCODE ?? await downloadAndUnzipVSCode({ cachePath: path.join(tmpdir(), 'codex-deck-vscode-test') });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined) env[key] = value;
  const app = await electron.launch({
    executablePath,
    args: [workspace, `--extensionDevelopmentPath=${process.cwd()}`, '--user-data-dir', userData, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--no-sandbox', '--disable-gpu'],
    env: { ...env, CODEX_DECK_TEST_RPC_LOG: log, CODEX_DECK_TEST_HISTORY_COUNT: '55', CODEX_DECK_TEST_ARCHIVE_FAIL_ONCE: 'history-fixture-3', CODEX_DECK_TEST_ARCHIVE_DELAY_MS: '400' },
  });
  const page = await app.firstWindow();
  try {
    await page.locator('.monaco-workbench').waitFor();
    const picker = page.locator('.quick-input-widget');
    const input = picker.locator('input');
    const row = (title: string) => picker.getByRole('option', { name: new RegExp(`^${title}, `) });
    const requests = async (method: string, threadId?: string) => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      .filter(request => request.method === method && (!threadId || request.params.threadId === threadId));
    const history = async () => {
      await page.keyboard.press('Control+Shift+P');
      await input.fill('>Codex Deck: チャット履歴');
      await picker.getByText('Codex Deck: チャット履歴', { exact: true }).click();
      await expect(input).toHaveAttribute('placeholder', 'タイトル・フォルダーで検索');
      await expect(picker.locator('.codicon-archive').first()).toBeVisible();
    };
    const archive = async (title: string) => {
      await input.fill(title);
      const button = row(title).locator('.codicon-archive');
      await button.hover();
      const box = await button.boundingBox(); assert.ok(box);
      await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2, { delay: 80 });
    };
    await history();
    const first = row('History fixture');
    const button = first.locator('.codicon-archive');
    await button.hover();
    const before = await button.boundingBox(); assert.ok(before);
    await button.click();
    const confirm = first.locator('.codicon-check');
    await expect(confirm).toBeVisible();
    const after = await confirm.boundingBox(); assert.ok(after);
    assert.deepEqual(after, before, 'confirmation must keep the exact button position and size');
    assert.equal((await requests('thread/archive')).length, 0, 'the first click must not archive');
    await page.mouse.click(before.x + before.width / 2, before.y + before.height / 2);
    await expect.poll(async () => (await requests('thread/archive', 'history-fixture')).length).toBe(1);
    await page.mouse.dblclick(before.x + before.width / 2, before.y + before.height / 2);
    await expect(first).toHaveCount(0);
    assert.equal((await requests('thread/archive')).length, 1, 'pending clicks must not send duplicate requests');
    await expect(picker).toBeVisible();
    assert.equal((await requests('thread/resume')).length, 0, 'archive clicks must not open the chat');

    await archive('History fixture 2');
    await expect(row('History fixture 2')).toHaveCount(0);
    assert.equal((await requests('thread/archive', 'history-fixture-2')).length, 1, 'a double click must archive exactly once');
    await archive('History fixture 3');
    await expect(row('History fixture 3')).toContainText('Archive fixture failure');
    await expect(row('History fixture 3').locator('.codicon-archive')).toBeVisible();
    await archive('History fixture 3');
    await expect(row('History fixture 3')).toHaveCount(0);
    assert.equal((await requests('thread/archive', 'history-fixture-3')).length, 2, 'failed archives must remain retryable');

    await input.fill('History fixture 4');
    await row('History fixture 4').locator('.codicon-archive').click();
    await expect(row('History fixture 4').locator('.codicon-check')).toBeVisible();
    await input.fill('History fixture 5');
    await input.fill('History fixture 4');
    await expect(row('History fixture 4').locator('.codicon-archive')).toBeVisible();
    assert.equal((await requests('thread/archive', 'history-fixture-4')).length, 0, 'changing the search must cancel confirmation');
    await page.keyboard.press('Escape');
    await history();
    await input.fill('History fixture 4');
    await expect(row('History fixture 4').locator('.codicon-archive')).toBeVisible();

    await input.fill('次の50件を表示');
    await picker.getByText('次の50件を表示', { exact: true }).click();
    await expect(row('History fixture 55')).toBeVisible();
    await picker.getByText('アーカイブした履歴', { exact: true }).click();
    await expect(row('History fixture')).toBeVisible();
    await expect(picker.locator('.codicon-archive')).toHaveCount(0);
    await picker.getByText('History fixture', { exact: true }).click();
    await expect(picker).toBeHidden();
    await expect.poll(async () => (await requests('thread/unarchive', 'history-fixture')).length).toBe(1);
    await expect(page.locator('.tab').filter({ hasText: 'History fixture' })).toBeVisible();
    await history();
    await archive('History fixture');
    await expect(row('History fixture')).toHaveCount(0);
    await expect(page.locator('.tab').filter({ hasText: 'History fixture' })).toHaveCount(0);
    await expect(picker).toBeVisible();
    console.log('History UI passed: same-position confirmation, double click, duplicate prevention, inline failure and retry, confirmation reset, pagination, restore, and open-tab cleanup.');
  } catch (error) {
    await page.screenshot({ path: path.join(folder, 'failure.png') });
    console.error(`History test artifacts: ${folder}`);
    throw error;
  } finally { await app.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
