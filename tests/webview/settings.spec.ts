import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { settingsHtml } from '../../src/ui/settingsHtml';

const models = [
  { id: 'recommended', label: 'Recommended model', description: 'General tasks', isDefault: true, efforts: [{ id: 'medium' }, { id: 'high' }], defaultEffort: 'medium' },
  { id: 'specialized', label: 'Specialized model', description: 'Specialized tasks', isDefault: false, efforts: [{ id: 'future-effort' }], defaultEffort: 'future-effort' },
];
const initialPreset = { model: 'latest', effort: 'high', mode: 'auto-review' };
async function messages(page: Page) { return page.evaluate(() => (window as unknown as { sent: Record<string, unknown>[] }).sent); }
async function receive(page: Page, data: Record<string, unknown>) { await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data); }
async function snapshot(page: Page, extra: Record<string, unknown> = {}) {
  const request = (await messages(page)).at(-1)!;
  await receive(page, { type: 'settingsState', requestId: request.requestId, scope: request.scope, scopes: [{ id: 'user', label: 'ユーザー' }, { id: 'workspace', label: 'ワークスペース' }], presets: [initialPreset], models, ...extra });
}

test.beforeEach(async ({ page }) => {
  const html = settingsHtml({ cspSource: 'http://localhost', script: 'http://localhost/settings.js', css: 'http://localhost/settings.css', nonce: 'test-nonce' });
  await page.addInitScript(() => {
    const state = window as unknown as { sent: unknown[]; acquireVsCodeApi: () => unknown };
    state.sent = [];
    state.acquireVsCodeApi = () => ({ postMessage: (value: unknown) => state.sent.push(value), setState: () => {}, getState: () => ({}) });
  });
  await page.route('http://localhost/**', async route => {
    const url = route.request().url();
    if (url.endsWith('settings.js')) await route.fulfill({ contentType: 'text/javascript', body: await readFile('dist/settings.js', 'utf8') });
    else if (url.endsWith('settings.css')) await route.fulfill({ contentType: 'text/css', body: await readFile('media/settings.css', 'utf8') });
    else await route.fulfill({ contentType: 'text/html', body: html });
  });
  await page.goto('http://localhost/');
  await expect.poll(async () => (await messages(page)).at(-1)?.type).toBe('loadSettings');
});

test('the first preset supplies defaults and uses live dropdowns without saving on load', async ({ page }) => {
  await snapshot(page);
  await expect(page.getByRole('combobox')).toHaveCount(7);
  await expect(page.getByLabel('要約に使うモデル')).toHaveValue('latest');
  await expect(page.getByLabel('要約の推論強度')).toHaveValue('lowest');
  await expect(page.locator('#title-effort option')).toHaveText(['最低 (medium)', 'モデルの既定値', 'medium', 'high']);
  await expect(page.locator('#preset-model-0 option')).toHaveText(['最新モデル (Recommended model)', 'Recommended model', 'Specialized model']);
  await expect(page.getByLabel('推論強度', { exact: true })).toHaveValue('high');
  await expect(page.getByLabel('権限')).toHaveValue('auto-review');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await expect(page.locator('.preset-default')).toHaveText('新規タスクの初期設定');
  await expect(page.getByRole('button', { name: 'プリセット1を削除' })).toBeDisabled();
  expect((await messages(page)).filter(message => message.type === 'saveSettings')).toHaveLength(0);
});

test('task and question presets save their speeds independently', async ({ page }) => {
  const preset = { ...initialPreset, serviceTier: 'fast' };
  const question = { id: 'explain', name: '説明', prompt: '説明してください。', settings: { ...preset } };
  await snapshot(page, { presets: [preset], questionPresets: [question] });
  const taskSpeed = page.locator('#preset-service-tier-0');
  const questionSpeed = page.locator('#question-preset-service-tier-0');
  await expect(taskSpeed).toHaveValue('fast');
  await expect(questionSpeed).toHaveValue('fast');
  await expect(taskSpeed.locator('option')).toHaveText(['Codex設定を引き継ぐ', 'Standard', 'Fast']);
  await taskSpeed.selectOption('default');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const saved = [{ ...initialPreset, serviceTier: 'default' }];
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'saveSettings', presets: saved, questionPresets: [question] });
  await snapshot(page, { saved: true, presets: saved, questionPresets: [question] });
  await expect(taskSpeed).toHaveValue('default');
  await questionSpeed.selectOption('');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  expect((await messages(page)).at(-1)).toMatchObject({ presets: saved, questionPresets: [{ ...question, settings: initialPreset }] });
});

test('presets can be added, edited, reordered and deleted before saving the complete list', async ({ page }, info) => {
  await snapshot(page);
  await page.getByLabel('保存先').selectOption('workspace'); await snapshot(page);
  await page.getByRole('button', { name: 'プリセットを追加', exact: true }).click();
  const second = page.getByRole('group', { name: 'プリセット2', exact: true });
  await second.getByLabel('モデル', { exact: true }).selectOption('specialized');
  await expect(second.getByLabel('推論強度', { exact: true })).toHaveValue('future-effort');
  await second.getByLabel('権限').selectOption('read-only');
  await page.getByRole('button', { name: 'プリセットを追加', exact: true }).click();
  await page.getByRole('group', { name: 'プリセット3', exact: true }).getByLabel('権限').selectOption('danger-full-access');
  await page.getByRole('button', { name: 'プリセット2を上へ' }).click();
  await expect(page.locator('#preset-model-0')).toHaveValue('specialized');
  await expect(page.locator('#preset-model-0')).toBeFocused();
  await expect(page.locator('.preset-default')).toHaveCount(1);
  await page.getByRole('button', { name: 'プリセット3を削除' }).click();
  await expect(page.locator('.preset-card')).toHaveCount(2);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const presets = [{ model: 'specialized', effort: 'future-effort', mode: 'read-only' }, initialPreset];
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'saveSettings', scope: 'workspace', presets });
  await expect(page.getByRole('button', { name: 'プリセットを追加', exact: true })).toBeDisabled();
  await snapshot(page, { saved: true, presets });
  await page.setViewportSize({ width: 380, height: 800 });
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(380);
  await page.screenshot({ path: info.outputPath('preset-settings.png'), fullPage: true });
  await page.getByRole('button', { name: 'プリセット1を下へ' }).click();
  await expect(page.locator('#preset-model-0')).toHaveValue('latest');
  await page.getByRole('button', { name: 'プリセット1を削除' }).click();
  await expect(page.locator('#preset-model-0')).toHaveValue('specialized');
  await expect(page.getByRole('button', { name: 'プリセット1を削除' })).toBeDisabled();
});

test('preset drafts survive save failures and unavailable models must be repaired or removed', async ({ page }) => {
  await snapshot(page, { presets: [initialPreset, { model: 'missing', effort: 'high', mode: 'workspace-write' }] });
  await expect(page.locator('#preset-model-1 option:checked')).toContainText('候補にありません');
  await page.getByRole('button', { name: 'プリセットを追加', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'プリセット2を削除' }).click();
  await page.locator('#preset-mode-1').selectOption('read-only');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await receive(page, { type: 'settingsError', requestId: (await messages(page)).at(-1)!.requestId, message: '保存できませんでした。' });
  await expect(page.locator('.preset-card')).toHaveCount(2);
  await expect(page.locator('#preset-mode-1')).toHaveValue('read-only');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await receive(page, { type: 'reload' });
  await expect(page.locator('#preset-mode-1')).toHaveValue('read-only');
});

test('changing model replaces effort choices and saves the selected values to the selected scope', async ({ page }) => {
  await snapshot(page);
  await page.getByLabel('保存先').selectOption('workspace'); await snapshot(page);
  await page.getByLabel('モデル', { exact: true }).selectOption('specialized');
  await expect(page.locator('#preset-effort-0 option')).toHaveText(['モデルの既定値', 'future-effort']);
  await expect(page.getByLabel('推論強度', { exact: true })).toHaveValue('future-effort');
  await page.getByLabel('権限').selectOption('read-only');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const settings = { model: 'specialized', effort: 'future-effort', mode: 'read-only' };
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'saveSettings', scope: 'workspace', presets: [settings] });
  await snapshot(page, { saved: true, presets: [settings] });
  await expect(page.getByRole('status')).toHaveText('設定を保存しました。');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
});

test('reload discovers added models and stale responses do not replace the newest catalog', async ({ page }) => {
  const old = (await messages(page)).at(-1)!;
  await snapshot(page);
  await page.getByRole('button', { name: '候補を再読み込み' }).click();
  const updated = [...models, { ...models[0], id: 'new-model', label: 'New model' }];
  await snapshot(page, { models: updated });
  await receive(page, { type: 'settingsState', requestId: old.requestId, scope: 'user', presets: [initialPreset], models: [] });
  await expect(page.locator('#preset-model-0 option')).toHaveText(['最新モデル (Recommended model)', 'Recommended model', 'Specialized model', 'New model']);
});

test('save errors keep the draft and show an inline message that allows retry', async ({ page }) => {
  await snapshot(page);
  await page.getByLabel('推論強度', { exact: true }).selectOption('medium');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await receive(page, { type: 'settingsError', requestId: (await messages(page)).at(-1)!.requestId, message: '設定を保存できませんでした。' });
  await expect(page.getByRole('status')).toHaveText('設定を保存できませんでした。');
  await expect(page.getByLabel('推論強度', { exact: true })).toHaveValue('medium');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await receive(page, { type: 'reload' });
  await expect(page.getByLabel('推論強度', { exact: true })).toHaveValue('medium');
});

test('a failed scope load cannot save values from the previous scope', async ({ page }) => {
  await snapshot(page);
  await page.getByLabel('推論強度', { exact: true }).selectOption('medium');
  await page.getByLabel('保存先').selectOption('workspace');
  await receive(page, { type: 'settingsError', requestId: (await messages(page)).at(-1)!.requestId, message: '候補を取得できません。' });
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await expect(page.getByLabel('モデル', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '候補を再読み込み' }).click();
  await snapshot(page);
  await expect(page.getByLabel('モデル', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('推論強度', { exact: true })).toHaveValue('high');
});

test('catalog metadata is rendered as text and settings fit a split editor', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  const text = '<img src=x onerror=alert(1)>' + 'long'.repeat(60);
  await snapshot(page, { models: [{ ...models[0], label: text, description: text }] });
  await page.getByLabel('モデル', { exact: true }).selectOption('recommended');
  await expect(page.locator('#preset-model-description-0')).toHaveText(text);
  await expect(page.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(380);
});

test('title model and effort are saved independently of task presets and survive save failures', async ({ page }, info) => {
  await snapshot(page);
  await page.getByLabel('保存先').selectOption('workspace'); await snapshot(page);
  await page.getByLabel('要約に使うモデル').selectOption('specialized');
  await page.getByLabel('要約の推論強度').selectOption('future-effort');
  await expect(page.locator('#preset-model-0')).toHaveValue('latest');
  await expect(page.locator('#preset-effort-0')).toHaveValue('high');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'saveSettings', scope: 'workspace', titleModel: 'specialized', titleEffort: 'future-effort', presets: [initialPreset] });
  await expect(page.getByLabel('要約の推論強度')).toBeDisabled();
  await receive(page, { type: 'settingsError', requestId: (await messages(page)).at(-1)!.requestId, message: '保存できませんでした。' });
  await expect(page.getByLabel('要約に使うモデル')).toHaveValue('specialized');
  await expect(page.getByLabel('要約の推論強度')).toHaveValue('future-effort');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await snapshot(page, { saved: true, titleModel: 'specialized', titleEffort: 'future-effort' });
  await expect(page.getByLabel('要約に使うモデル')).toHaveValue('specialized');
  await expect(page.getByLabel('要約の推論強度')).toHaveValue('future-effort');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 380, height: 800 });
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(380);
  await page.screenshot({ path: info.outputPath('title-model-settings.png'), fullPage: true });
  await page.getByRole('button', { name: '候補を再読み込み' }).click();
  await snapshot(page, { titleModel: 'specialized', titleEffort: 'future-effort' });
  await expect(page.getByLabel('要約に使うモデル')).toHaveValue('specialized');
  await expect(page.getByLabel('要約の推論強度')).toHaveValue('future-effort');
});

test('title model changes retain supported efforts and replace unsupported selections with lowest', async ({ page }) => {
  await snapshot(page);
  await page.getByLabel('要約の推論強度').selectOption('high');
  await page.getByLabel('要約に使うモデル').selectOption('recommended');
  await expect(page.getByLabel('要約の推論強度')).toHaveValue('high');
  await page.getByLabel('要約に使うモデル').selectOption('specialized');
  await expect(page.locator('#title-effort option')).toHaveText(['最低 (future-effort)', 'モデルの既定値', 'future-effort']);
  await expect(page.getByLabel('要約の推論強度')).toHaveValue('lowest');
  await page.getByLabel('要約の推論強度').selectOption('default');
  await page.getByLabel('要約に使うモデル').selectOption('latest');
  await expect(page.getByLabel('要約の推論強度')).toHaveValue('default');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'saveSettings', titleModel: 'latest', titleEffort: 'default' });
});

test('an unavailable saved title effort must be repaired before saving', async ({ page }) => {
  await snapshot(page, { titleEffort: 'unavailable' });
  await expect(page.locator('#title-effort option:checked')).toContainText('候補にありません');
  await page.getByLabel('推論強度', { exact: true }).selectOption('medium');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await page.getByLabel('要約の推論強度').selectOption('lowest');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'saveSettings', titleEffort: 'lowest' });
});

test('unavailable title models and failed scope loads cannot be saved', async ({ page }) => {
  await snapshot(page, { titleModel: 'unavailable' });
  await expect(page.locator('#title-model option:checked')).toContainText('候補にありません');
  await page.getByLabel('推論強度', { exact: true }).selectOption('medium');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await page.getByLabel('要約に使うモデル').selectOption('latest');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await page.getByLabel('保存先').selectOption('workspace');
  await receive(page, { type: 'settingsError', requestId: (await messages(page)).at(-1)!.requestId, message: '候補を取得できません。' });
  await expect(page.getByLabel('要約に使うモデル')).toBeDisabled();
  await expect(page.getByLabel('要約の推論強度')).toBeDisabled();
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
});

test('question presets have independent model settings, reorder by identity, and keep drafts on failure', async ({ page }, info) => {
  await snapshot(page);
  await page.getByLabel('保存先').selectOption('workspace'); await snapshot(page);
  const save = page.getByRole('button', { name: '保存', exact: true });
  await page.getByRole('button', { name: '質問プリセットを追加', exact: true }).click();
  const first = page.getByRole('group', { name: '質問プリセット1', exact: true });
  await expect(first.getByLabel('表示名')).toBeFocused();
  await expect(save).toBeDisabled();
  await first.getByLabel('表示名').fill('かみ砕いて');
  await first.getByLabel('質問文').fill('具体例を交えて\n説明してください。');
  await first.getByLabel('モデル', { exact: true }).selectOption('specialized');
  await first.getByLabel('権限', { exact: true }).selectOption('read-only');
  await expect(first.getByLabel('推論強度', { exact: true })).toHaveValue('future-effort');
  await page.getByRole('button', { name: '質問プリセットを追加', exact: true }).click();
  const second = page.getByRole('group', { name: '質問プリセット2', exact: true });
  await second.getByLabel('表示名').fill('理解を確認');
  await second.getByLabel('質問文').fill('この文章の前提を説明してください。');
  await save.click();
  const request = (await messages(page)).at(-1)!;
  expect(request).toMatchObject({ type: 'saveSettings', scope: 'workspace', presets: [initialPreset], questionPresets: [
    { name: 'かみ砕いて', prompt: '具体例を交えて\n説明してください。', settings: { model: 'specialized', effort: 'future-effort', mode: 'read-only' } },
    { name: '理解を確認', settings: initialPreset },
  ] });
  const questions = request.questionPresets as { id: string; name: string; settings: unknown }[];
  expect(questions[0]!.id).not.toBe(questions[1]!.id);
  await receive(page, { type: 'settingsError', requestId: request.requestId, message: '保存に失敗しました' });
  await expect(first.getByLabel('質問文')).toHaveValue('具体例を交えて\n説明してください。');
  await page.getByRole('button', { name: '質問プリセット2を上へ', exact: true }).click();
  await page.locator('#preset-model-0').selectOption('specialized');
  await save.click();
  expect((await messages(page)).at(-1)?.questionPresets).toEqual([questions[1], questions[0]]);
  await snapshot(page, { saved: true, questionPresets: [questions[1], questions[0]] });
  await page.setViewportSize({ width: 380, height: 850 });
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(380);
  await page.locator('#question-presets').screenshot({ path: info.outputPath('question-presets.png') });
  await page.getByRole('button', { name: '質問プリセット2を削除', exact: true }).click();
  await page.getByRole('button', { name: '質問プリセット1を削除', exact: true }).click();
  await expect(page.getByRole('button', { name: '質問プリセットを追加', exact: true })).toBeFocused();
  await save.click();
  expect((await messages(page)).at(-1)?.questionPresets).toEqual([]);
});

test('an unavailable question model can be replaced with a catalog model', async ({ page }) => {
  await snapshot(page, { questionPresets: [{ id: 'ask', name: '質問', prompt: '解説して', settings: { model: 'missing', effort: 'default', mode: 'read-only' } }] });
  const question = page.getByRole('group', { name: '質問プリセット1', exact: true });
  const save = page.getByRole('button', { name: '保存', exact: true });
  await question.getByLabel('質問文').fill('説明してください');
  await expect(save).toBeDisabled();
  await question.getByLabel('モデル', { exact: true }).selectOption('specialized');
  await question.getByLabel('推論強度', { exact: true }).selectOption('future-effort');
  await save.click();
  expect((await messages(page)).at(-1)).toMatchObject({ questionPresets: [{ settings: { model: 'specialized', effort: 'future-effort', mode: 'read-only' } }] });
});
