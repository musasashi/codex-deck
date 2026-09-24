import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatHtml } from '../../src/ui/html';
import { decodeUsage } from '../../src/appServer/client';
import { TaskManager } from '../../src/core/taskManager';
import { questionAnswerText } from '../../src/core/questions';
import { taskReferenceBody } from '../../src/core/taskReferenceText';
import { selectionReference } from '../../src/core/selectionReference';
import { FakeGateway, thread } from '../helpers';
import type { Skill, Task, Usage } from '../../src/core/types';
import { emptyTaskCost } from '../../src/core/cost';
import { withHuggingFaceModels } from '../../src/core/huggingFace';
import { providerModels, validateProviders } from '../../src/core/providers';
import { inducedVoltageAnswer } from '../fixtures/math';

test('Responses tasks only offer their own provider and declared efforts, including the provider default', async ({ page }) => {
  const catalog = providerModels(validateProviders([
    { id: 'one', name: 'First API', baseUrl: 'http://localhost/v1', models: [{ id: 'model', reasoningEfforts: ['low', 'high'] }, { id: 'plain' }] },
    { id: 'two', name: 'Other API', baseUrl: 'http://localhost/v1', models: [{ id: 'model' }] },
  ]));
  const value = task();
  value.settings = { model: 'responses:one:model', effort: 'high', mode: 'read-only' };
  value.modelProvider = 'codex_deck_responses_one';
  value.cost = emptyTaskCost();
  await receive(page, { type: 'state', task: value, models: [...models, ...catalog], connected: true });
  await expect(page.locator('#model option')).toHaveCount(3);
  await expect(page.locator('#model option[value="responses:one:plain"]')).toHaveCount(1);
  await expect(page.locator('#model option[value="responses:two:model"]')).toHaveCount(0);
  await expect(page.locator('#model option[value="catalog-model"]')).toHaveCount(0);
  await expect(page.locator('#effort option')).toHaveText(['モデルの既定値', 'low', 'high']);
  await page.locator('#effort').selectOption('default');
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'settings', model: 'responses:one:model', effort: 'default' });
  await expect(page.locator('#task-cost')).toBeVisible();
  await expect(page.locator('#task-cost')).toHaveAttribute('aria-label', /外部API利用額/);
  await expect(page.locator('#usage-gauges')).toBeHidden();
  await expect(page.locator('#auto-resume')).toBeHidden();
  value.settings = { model: 'responses:one:plain', mode: 'read-only' };
  value.effectiveEffort = 'high';
  await receive(page, { type: 'state', task: value, models: catalog, connected: true });
  await expect(page.locator('#effort')).toHaveValue('default');
  await expect(page.locator('#effort')).toBeDisabled();
  await expect(page.locator('#effort option')).toHaveText(['モデルの既定値']);
});

test('HF task cost replaces quota gauges, updates live, and stays visible after disconnecting', async ({ page }, info) => {
  const value = task();
  value.settings = { model: 'hf:deepseek-ai/DeepSeek-V4-Flash:deepinfra', effort: 'default', mode: 'workspace-write', pricing: { input: 0.1, output: 0.2 } };
  value.modelProvider = 'codex_deck_huggingface';
  value.effectiveEffort = 'max';
  value.cost = { ...emptyTaskCost(), usd: 0.1234 };
  const usage = decodeUsage({ rateLimits: { limitId: 'codex', primary: { usedPercent: 10, windowDurationMins: 300 }, secondary: { usedPercent: 20, windowDurationMins: 10080 } } });
  await state(page, value, usage);
  await expect(page.locator('#task-cost')).toHaveText('$0.1234（概算）');
  await expect(page.locator('#task-cost')).toHaveAttribute('title', /ユーザー設定の単価/);
  await expect(page.locator('#usage-gauges')).toBeHidden();
  await expect(page.locator('#auto-resume')).toBeHidden();
  await expect(page.locator('#effort')).toHaveValue('default');
  await expect(page.locator('#effort')).toBeDisabled();
  await expect(page.locator('#effort option')).toHaveText(['モデルの既定値']);
  await expect(page.locator('#model')).toHaveValue(value.settings.model!);
  await expect(page.locator('#model option[value="catalog-model"]')).toHaveCount(0);
  value.cost.usd = 0.2345;
  await state(page, value, usage, false);
  await expect(page.locator('#task-cost')).toHaveText('$0.2345（概算）');
  await page.setViewportSize({ width: 380, height: 850 });
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(380);
  await page.screenshot({ path: info.outputPath('hf-cost.png'), fullPage: true });
  await state(page, task(), usage);
  await expect(page.locator('#task-cost')).toBeHidden();
  await expect(page.getByRole('meter', { name: 'Codex 5時間枠の残量' })).toBeVisible();
  await expect(page.locator('#auto-resume')).toBeVisible();
});

const theme = `:root{--vscode-editor-background:#181a1e;--vscode-foreground:#e0e3e9;--vscode-descriptionForeground:#a0a7b3;--vscode-widget-border:#353940;--vscode-input-background:#22252b;--vscode-input-foreground:#e0e3e9;--vscode-input-placeholderForeground:#979faa;--vscode-button-background:#b6d8b1;--vscode-button-foreground:#193019;--vscode-button-hoverBackground:#c9e8c5;--vscode-button-secondaryBackground:#353941;--vscode-button-secondaryForeground:#e0e3e9;--vscode-focusBorder:#8eaf8a;--vscode-font-family:system-ui,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:monospace;--vscode-editor-font-size:12px;--vscode-textCodeBlock-background:#121417;--vscode-textLink-foreground:#a9c6ea;--vscode-progressBar-background:#b6d8b1;--vscode-editorWarning-foreground:#e2bd79;--vscode-errorForeground:#f5a59e;--vscode-inputValidation-warningBackground:#302b20;--vscode-editorWidget-background:#22252b;--vscode-dropdown-background:#22252b;--vscode-dropdown-foreground:#e0e3e9;}`;
const models = [{ id: 'catalog-model', label: 'Catalog model', efforts: [{ id: 'new-effort', description: 'from server' }, { id: 'high', description: 'high' }], description: '', defaultEffort: 'new-effort', isDefault: true, inputModalities: ['text', 'image'] }];
function task(): Task { return { id: 'task-1', threadId: 'thread-1', title: 'App Serverとの通信を実装する', cwd: '/workspace/codex-deck', open: true, autoResume: false, claims: [], settings: { mode: 'default' }, status: 'idle', turns: [], requests: [], attachments: [], busy: false, hydrated: true, instructionSources: [] }; }
async function state(page: Page, value: Task, usage?: Usage, connected = true, presetCount = 1, questionPresets: { id: string; name: string }[] = []) { await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), { type: 'state', task: value, models: withHuggingFaceModels(models, [value.settings.model]), usage, connected, presetCount, questionPresets, enterBehavior: 'enter' }); }
async function messages(page: Page) { return page.evaluate(() => (window as unknown as { sent: Record<string, unknown>[] }).sent); }
async function receive(page: Page, data: Record<string, unknown>) { await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data); }
async function sendResult(page: Page, type: 'sent' | 'failure') {
  const request = (await messages(page)).findLast(message => message.type === 'send')!;
  await receive(page, { type, sendId: request.sendId, text: request.text });
}
const skills: Skill[] = [
  { name: 'registered-one', path: '/skills/one/SKILL.md', description: '登録された最初のスキル', scope: 'system' },
  { name: 'registered-two', path: '/skills/two/SKILL.md', description: '登録された二つ目のスキル', scope: 'user' },
];
async function catalog(page: Page, entries = skills, permissionMode = 'workspace-write') {
  const request = (await messages(page)).findLast(message => message.type === 'composerCatalog');
  expect(request).toBeTruthy();
  await receive(page, { type: 'composerCatalog', requestId: request!.requestId, skills: entries, permissionMode });
}
async function fileRequest(page: Page, query: string) {
  await expect.poll(async () => (await messages(page)).findLast(message => message.type === 'fileSearch')?.query).toBe(query);
  return (await messages(page)).findLast(message => message.type === 'fileSearch')!;
}
async function pasteClipboardImages(page: Page, files: { type?: string; size?: number }[] = [{}], filesOnly = false, submitImmediately = false) {
  return page.evaluate(({ files, filesOnly, submitImmediately }) => {
    const data = new DataTransfer();
    for (const [index, file] of files.entries()) {
      const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 150;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#181a1e'; context.fillRect(0, 0, 240, 150);
      context.font = '14px monospace'; context.fillStyle = '#b6d8b1';
      context.fillText(`Screenshot ${index + 1}`, 16, 30);
      context.fillStyle = '#e0e3e9';
      context.fillText('const result =', 16, 68); context.fillText('  await run();', 16, 90);
      context.fillStyle = '#a9c6ea'; context.fillText('3 tests passed', 16, 128);
      const bytes = file.size === undefined ? Uint8Array.from(atob(canvas.toDataURL().split(',')[1]!), char => char.charCodeAt(0)) : new Uint8Array(file.size);
      data.items.add(new File([bytes], `image-${index}.png`, { type: file.type ?? 'image/png' }));
    }
    if (filesOnly) Object.defineProperty(data, 'items', { value: [] });
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    document.getElementById('prompt')!.dispatchEvent(event);
    if (submitImmediately) (document.getElementById('composer') as HTMLFormElement).requestSubmit();
    return event.defaultPrevented;
  }, { files, filesOnly, submitImmediately });
}
async function imageRequest(page: Page, count = 1) {
  await expect.poll(async () => (await messages(page)).filter(message => message.type === 'pasteImages').length).toBe(count);
  return (await messages(page)).filter(message => message.type === 'pasteImages')[count - 1]!;
}
async function acceptImages(page: Page, value: Task, request: Record<string, unknown>) {
  value.attachments.push(...(request.urls as string[]).map((url, index) => ({ id: `image-${request.requestId}-${index}`, label: '貼り付けた画像', input: { type: 'image' as const, url } })));
  await receive(page, { type: 'imagesPasted', requestId: request.requestId, attachments: value.attachments });
}

test.beforeEach(async ({ page }) => {
  const html = chatHtml({ cspSource: 'http://localhost', script: 'http://localhost/webview.js', css: 'http://localhost/chat.css', nonce: 'testing-nonce' });
  await page.addInitScript(() => {
    const state = window as unknown as { sent: unknown[]; acquireVsCodeApi: () => unknown };
    state.sent = [];
    state.acquireVsCodeApi = () => ({ postMessage: (message: unknown) => state.sent.push(message),
      setState: (value: unknown) => sessionStorage.setItem('webviewState', JSON.stringify(value)), getState: () => JSON.parse(sessionStorage.getItem('webviewState') ?? '{}') });
  });
  await page.route('http://localhost/**', async route => {
    const url = route.request().url();
    if (url.endsWith('/webview.js')) await route.fulfill({ contentType: 'text/javascript', body: await readFile('dist/webview.js', 'utf8') });
    else if (url.endsWith('/chat.css')) await route.fulfill({ contentType: 'text/css', body: theme + await readFile('dist/chat.css', 'utf8') });
    else if (/\/fonts\/[\w.-]+\.(woff2?|ttf)$/.test(url)) await route.fulfill({ contentType: `font/${url.split('.').at(-1)}`, body: await readFile(`dist${new URL(url).pathname}`) });
    else await route.fulfill({ contentType: 'text/html', body: html });
  });
  await page.goto('http://localhost/');
  await expect.poll(async () => (await messages(page)).some(message => message.type === 'ready')).toBe(true);
});

async function openSelectionMenu(page: Page, selector: string, point?: { x: number; y: number }) {
  if (point) await page.mouse.click(point.x, point.y, { button: 'right' });
  else await page.locator(selector).click({ button: 'right' });
}

test('reference equations render with bundled fonts and styles under the webview CSP', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => {
    const violations: string[] = [];
    Object.assign(window, { mathCspViolations: violations });
    document.addEventListener('securitypolicyviolation', event => violations.push(event.violatedDirective));
  });
  const value = task();
  value.turns = [{ id: 'math', status: 'completed', items: [{ id: 'reply', kind: 'agentMessage', data: { text: inducedVoltageAnswer } }] }];
  await state(page, value);
  await expect(page.locator('.katex-display')).toHaveCount(2);
  await expect(page.locator('.katex-error')).toHaveCount(0);
  await expect(page.locator('.katex-display .katex-html').first()).toBeVisible();
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return Array.from(document.fonts).filter(font => font.family.startsWith('KaTeX') && font.status === 'loaded').map(font => font.family);
  });
  await page.screenshot({ path: info.outputPath('reference-math.png'), fullPage: true });
  expect(fonts).toContain('KaTeX_Main');
  expect(fonts).toContain('KaTeX_Math');
  expect(await page.locator('.frac-line').first().evaluate(element => parseFloat(getComputedStyle(element).borderBottomWidth))).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as unknown as { mathCspViolations: string[] }).mathCspViolations)).toEqual([]);
  expect(errors).toEqual([]);
});

test('wide display equations scroll within a narrow chat instead of expanding the page', async ({ page }, info) => {
  await page.setViewportSize({ width: 380, height: 850 });
  const value = task();
  value.turns = [{ id: 'math', status: 'completed', items: [{ id: 'reply', kind: 'agentMessage', data: { text: `$$${Array.from({ length: 40 }, (_, index) => `a_{${index}}`).join(' + ')}$$` } }] }];
  await state(page, value);
  const bounds = await page.locator('.katex-display').evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth,
    left: element.getBoundingClientRect().left, formulaLeft: element.querySelector('.katex-html')!.getBoundingClientRect().left }));
  expect(bounds.scrollWidth).toBeGreaterThan(bounds.width);
  expect(bounds.formulaLeft).toBeGreaterThanOrEqual(bounds.left);
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(380);
  await page.screenshot({ path: info.outputPath('wide-math.png'), fullPage: true });
});

test('dragging an answer exposes a selection menu and appends a quote followed by a comment', async ({ page }, info) => {
  const value = task();
  value.turns = [{ id: 'answer', status: 'completed', items: [{ id: 'reply', kind: 'agentMessage', data: { text: '前の説明。選択した文章です。後の説明。' } }] }];
  await state(page, value);
  const prompt = page.locator('#prompt');
  await prompt.fill('入力中の下書き');
  await prompt.selectText();
  const paragraph = page.locator('.assistant .markdown p');
  const bounds = await paragraph.evaluate(element => {
    const range = document.createRange();
    range.setStart(element.firstChild!, 5);
    range.setEnd(element.firstChild!, 14);
    const box = range.getBoundingClientRect();
    return { left: box.left, right: box.right, y: box.top + box.height / 2 };
  });
  await page.mouse.move(bounds.left, bounds.y);
  await page.mouse.down();
  await page.mouse.move(bounds.right, bounds.y, { steps: 12 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('選択した文章です。');
  await openSelectionMenu(page, '.assistant .markdown p', { x: (bounds.left + bounds.right) / 2, y: bounds.y });
  await expect(page.getByRole('menuitem')).toHaveText(['コピー', 'Codex-Deckで言及']);
  await page.getByRole('menuitem', { name: 'Codex-Deckで言及' }).click();
  const context = (await messages(page)).findLast(message => message.type === 'selectionAction')!;
  expect(context).toMatchObject({ action: 'mention', text: '選択した文章です。' });
  await receive(page, { type: 'selectionResult', requestId: context.requestId });
  await receive(page, { type: 'insertReference', text: selectionReference(context.text as string, `会話「${value.title}」`) });
  const quoted = `入力中の下書き\n\n> 参照元: 会話「${value.title}」\n>\n> 選択した文章です。\n\n`;
  await expect(prompt).toHaveValue(quoted);
  await expect(prompt).toBeFocused();
  expect(await prompt.evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])).toEqual([quoted.length, quoted.length]);
  expect((await messages(page)).some(message => message.type === 'send')).toBe(false);
  await expect(page.locator('#attachments')).toBeHidden();
  await page.keyboard.insertText('この部分を詳しく説明してください。');
  const draft = quoted + 'この部分を詳しく説明してください。';
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('webviewState')!).draft)).toBe(draft);
  await page.reload();
  await state(page, value);
  await expect(prompt).toHaveValue(draft);
  await prompt.press('Enter');
  expect((await messages(page)).findLast(message => message.type === 'send')).toMatchObject({ text: draft, attachmentIds: [] });
  const user = page.locator('.pending-send .message.user');
  await expect(user.locator('.user-quote')).toContainText('選択した文章です。');
  await expect(user.locator('.user-quote')).not.toContainText('この部分を詳しく');
  await expect(user.locator('.user-text').last()).toHaveText('この部分を詳しく説明してください。');
  await page.screenshot({ path: info.outputPath('selection-mention.png'), fullPage: true });
});

test('selection mentions preserve multiline code during streaming and hide outside selected conversation text', async ({ page }) => {
  const value = task();
  value.activeTurnId = 'streaming'; value.status = 'running';
  value.turns = [{ id: 'streaming', status: 'inProgress', items: [{ id: 'reply', kind: 'agentMessage', data: { text: '```ts\nconst x = 1;\n  run(x);\n```' } }] }];
  await state(page, value);
  await openSelectionMenu(page, '.assistant .markdown code');
  await expect(page.getByRole('menu')).toBeHidden();
  await page.locator('.assistant .markdown code').evaluate(element => {
    const text = element.firstChild!;
    window.getSelection()!.setBaseAndExtent(text, text.textContent!.length, text, 0);
  });
  await openSelectionMenu(page, '.assistant .markdown code');
  await expect(page.getByRole('menu')).toBeVisible();
  const context = { text: 'const x = 1;\n  run(x);' };
  value.turns[0]!.items[0]!.data.text += '\n\n追加された説明';
  value.turns[0]!.status = 'completed'; value.activeTurnId = undefined; value.status = 'idle';
  value.unreadTurnId = 'streaming';
  await state(page, value);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(context.text);
  await expect(page.locator('.assistant .markdown')).not.toContainText('追加された説明');
  expect((await messages(page)).filter(message => message.type === 'read')).toEqual([]);
  await page.getByRole('menuitem', { name: 'Codex-Deckで言及' }).click();
  await receive(page, { type: 'insertReference', text: selectionReference(context.text as string, `会話「${value.title}」`) });
  await expect(page.locator('.assistant .markdown')).toContainText('追加された説明');
  expect((await messages(page)).filter(message => message.type === 'read')).toEqual([{ type: 'read', turnId: 'streaming' }]);
  await expect(page.locator('#prompt')).toHaveValue(`> 参照元: 会話「${value.title}」\n>\n> const x = 1;\n>   run(x);\n\n`);
  await page.locator('#prompt').selectText();
  await openSelectionMenu(page, '#prompt');
  await expect(page.getByRole('menu')).toBeHidden();
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await openSelectionMenu(page, '.assistant .markdown code');
  await expect(page.getByRole('menu')).toBeHidden();
});

test('editor references can be added repeatedly while preserving an existing draft and exact selected text', async ({ page }) => {
  await state(page, task());
  const prompt = page.locator('#prompt');
  await prompt.fill('既存のコメント\n');
  await receive(page, { type: 'insertReference', text: selectionReference('  <script>選択文</script>\n\n> 引用内の引用', '/project/文書.md:2:3-4:8') });
  await page.keyboard.insertText('最初のコメント');
  await receive(page, { type: 'insertReference', text: selectionReference('次の選択文', '/project/文書.md:8:1-8:6') });
  const expected = '既存のコメント\n\n> 参照元: /project/文書.md:2:3-4:8\n>\n>   <script>選択文</script>\n> \n> > 引用内の引用\n\n最初のコメント\n\n> 参照元: /project/文書.md:8:1-8:6\n>\n> 次の選択文\n\n';
  await expect(prompt).toHaveValue(expected);
  await expect(prompt).toBeFocused();
  await page.keyboard.insertText('次のコメント');
  await prompt.press('Enter');
  expect((await messages(page)).findLast(message => message.type === 'send')?.text).toBe(expected + '次のコメント');
  const user = page.locator('.pending-send .message.user');
  await expect(user.locator('.user-quote')).toHaveCount(2);
  await expect(user.locator('.user-quote').first()).toContainText('<script>選択文</script>');
  await expect(user.locator('script')).toHaveCount(0);
});

test('empty chat shows only registered skills, dynamic settings, auto-resume toggle and keyboard input', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await receive(page, { type: 'state', task: task(), models, connected: true });
  await catalog(page);
  await expect(page.locator('#skills .skill')).toHaveCount(2);
  await expect(page.locator('#conversation')).toHaveText('$registered-two登録された二つ目のスキル$registered-one登録された最初のスキル');
  await page.getByLabel('使用量回復後に自動継続').check();
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'autoResume', enabled: true });
  await page.getByLabel('モデル', { exact: true }).selectOption('catalog-model');
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'settings', model: 'catalog-model', effort: '' });
  const prompt = page.getByLabel('メッセージ', { exact: true });
  const send = page.getByRole('button', { name: '送信', exact: true });
  await send.hover();
  await expect(send).toHaveAttribute('title', '送信 (Ctrl+Enter)');
  await prompt.fill('通信層を実装してください。');
  await prompt.press('Enter');
  await expect(prompt).toHaveValue('通信層を実装してください。\n');
  await prompt.press('Shift+Enter');
  expect((await messages(page)).filter(message => message.type === 'send')).toHaveLength(0);
  await prompt.press('Control+Enter');
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'send', text: '通信層を実装してください。\n\n' });
  await sendResult(page, 'sent');
  await prompt.fill('Cmdキーでも送信'); await prompt.press('Meta+Enter');
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'send', text: 'Cmdキーでも送信' });
  await sendResult(page, 'sent');
  await state(page, task());
  await send.hover();
  await expect(send).toHaveAttribute('title', '送信 (Enter)');
  await prompt.fill('Enter送信に変更'); await prompt.press('Shift+Enter');
  expect((await messages(page)).filter(message => message.type === 'send')).toHaveLength(2);
  await prompt.press('Enter');
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'send', text: 'Enter送信に変更\n' });
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath('empty-chat.png') });
});

test('new task defaults show the latest catalog model, high effort, and Approve for me', async ({ page }) => {
  const value = task(); value.threadId = undefined;
  value.settings = { model: 'latest', effort: 'high', mode: 'auto-review' };
  await state(page, value); await catalog(page);
  await expect(page.getByLabel('メッセージ', { exact: true })).toBeFocused();
  await expect(page.locator('#model option:checked')).toHaveText('最新モデル (Catalog model)');
  await expect(page.locator('#effort')).toHaveValue('high');
  await expect(page.locator('#mode option:checked')).toHaveText('Approve for me');
  expect((await messages(page)).filter(message => message.type === 'settings')).toHaveLength(0);
  value.settings.model = 'catalog-model';
  await state(page, value);
  await expect(page.locator('#model option:checked')).toHaveText('Catalog model');
  await expect(page.locator('#effort')).toHaveValue('high');
});

for (const order of ['state-first', 'ack-first']) test(`first send renders immediately and reconciles ${order} without clearing the next draft`, async ({ page }, info) => {
  const value = task(); value.threadId = undefined;
  await state(page, value); await catalog(page);
  const prompt = page.getByLabel('メッセージ', { exact: true });
  const text = 'すぐに表示してください。<script>安全に表示</script>';
  await prompt.fill(text);
  const immediate = await page.evaluate(() => {
    const start = performance.now();
    (document.getElementById('composer') as HTMLFormElement).requestSubmit();
    return { elapsed: performance.now() - start, draft: (document.getElementById('prompt') as HTMLTextAreaElement).value,
      text: document.querySelector('.pending-send .user-text')?.textContent,
      status: document.querySelector('.pending-status')?.textContent, skillsHidden: document.getElementById('skills')!.hidden,
      disabled: (document.getElementById('send') as HTMLButtonElement).disabled };
  });
  expect(immediate).toMatchObject({ draft: '', text, status: '送信中…', skillsHidden: true, disabled: true });
  console.log(`First message rendered synchronously in ${immediate.elapsed.toFixed(1)}ms (${order}).`);
  expect((await messages(page)).filter(message => message.type === 'send')).toHaveLength(1);
  const request = (await messages(page)).findLast(message => message.type === 'send')!;
  await state(page, value); await receive(page, { type: 'failure' });
  await receive(page, { type: 'failure', sendId: 'unrelated-send' });
  await expect(page.locator('.pending-send')).toHaveCount(1);
  await expect(page.locator('#skills')).toBeHidden();
  await expect(page.locator('#send')).toBeDisabled();
  await expect(page.locator('#model')).toBeDisabled();
  if (order === 'state-first') await page.screenshot({ path: info.outputPath('sending.png') });
  await prompt.fill(text);
  value.threadId = 'new-thread'; value.status = 'running'; value.activeTurnId = 'first-turn';
  value.turns = [{ id: 'first-turn', status: 'inProgress', items: [{ id: 'first-user', kind: 'userMessage', data: { clientId: request.sendId, content: [{ type: 'text', text }] } }] }];
  if (order === 'ack-first') {
    await sendResult(page, 'sent');
    await expect(page.locator('.pending-status')).toHaveText('送信済み');
    await expect(page.locator('.message.user')).toHaveCount(1);
  }
  await state(page, value);
  if (order === 'state-first') {
    await expect(page.locator('#send')).toBeDisabled();
    await sendResult(page, 'sent');
  }
  await expect(page.locator('.pending-send')).toHaveCount(0);
  await expect(page.locator('.message.user')).toHaveCount(1);
  await expect(page.locator('.user-text')).toHaveText(text);
  await expect(prompt).toHaveValue(text);
  await expect(page.locator('#send')).toBeEnabled();
});

test('first-send failures restore text, exact skill selection and attachments for another attempt', async ({ page }) => {
  const value = task(); value.threadId = undefined;
  await state(page, value); await catalog(page);
  await page.locator('#skills .skill').first().click();
  const prompt = page.getByLabel('メッセージ', { exact: true });
  await prompt.press('End'); await prompt.type('この画像を確認');
  await pasteClipboardImages(page); await acceptImages(page, value, await imageRequest(page));
  await prompt.press('Enter');
  await expect(prompt).toHaveValue('');
  await expect(page.locator('.pending-send img')).toHaveCount(1);
  await expect(page.locator('#attachments')).toBeHidden();
  await sendResult(page, 'failure');
  await expect(prompt).toHaveValue('$registered-two この画像を確認');
  await expect(page.locator('.pending-send')).toHaveCount(0);
  await expect(page.locator('#attachments img')).toHaveCount(1);
  await prompt.press('Enter');
  expect((await messages(page)).findLast(message => message.type === 'send')).toMatchObject({
    text: '$registered-two この画像を確認', skillPaths: ['/skills/two/SKILL.md'], attachmentIds: [value.attachments[0]!.id],
  });
});

test('retry preserves the next draft and new attachments and ignores an older send failure', async ({ page }, info) => {
  const value = task(); value.threadId = undefined;
  await state(page, value); await catalog(page);
  const prompt = page.getByLabel('メッセージ', { exact: true });
  await page.locator('#skills .skill').first().click();
  await prompt.press('End'); await prompt.type('最初の指示');
  await pasteClipboardImages(page); await acceptImages(page, value, await imageRequest(page));
  await prompt.press('Enter');
  const first = (await messages(page)).findLast(message => message.type === 'send')!;
  await prompt.fill('次の指示');
  await pasteClipboardImages(page); await acceptImages(page, value, await imageRequest(page, 2));
  await sendResult(page, 'failure');
  await expect(prompt).toHaveValue('次の指示');
  await expect(page.locator('#attachments img')).toHaveCount(1);
  await expect(page.locator('.pending-send img')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('send-failure.png') });
  await page.getByRole('button', { name: '再送', exact: true }).click();
  const retry = (await messages(page)).findLast(message => message.type === 'send')!;
  expect(retry).toMatchObject({ text: first.text, skillPaths: first.skillPaths, attachmentIds: first.attachmentIds });
  expect(retry.sendId).not.toBe(first.sendId);
  await receive(page, { type: 'failure', sendId: first.sendId });
  await expect(page.locator('.pending-status')).toHaveText('送信中…');
  await expect(page.locator('#send')).toBeDisabled();
  value.turns = [{ id: 'retry-turn', status: 'inProgress', items: [{ id: 'retry-user', kind: 'userMessage', data: { clientId: retry.sendId,
    content: [{ type: 'text', text: retry.text }, value.attachments[0]!.input] } }] }];
  value.attachments.shift();
  await state(page, value); await sendResult(page, 'sent');
  await expect(prompt).toHaveValue('次の指示');
  await expect(page.locator('#attachments img')).toHaveCount(1);
  await expect(page.locator('.pending-send')).toHaveCount(0);
  await expect(page.locator('.message.user')).toHaveCount(1);
});

test('reloading during a first send retains the pending content and reconciles restored history without resending', async ({ page }) => {
  const value = task(); value.threadId = undefined;
  await state(page, value);
  const prompt = page.getByLabel('メッセージ', { exact: true });
  await prompt.fill('保存する指示'); await prompt.press('Enter');
  const request = (await messages(page)).findLast(message => message.type === 'send')!;
  await prompt.fill('次に書いた下書き');
  await state(page, value);
  await page.reload(); await state(page, value);
  await expect(page.locator('.pending-send .user-text')).toHaveText('保存する指示');
  await expect(prompt).toHaveValue('次に書いた下書き');
  expect((await messages(page)).filter(message => message.type === 'send')).toHaveLength(0);
  value.turns = [{ id: 'restored', status: 'completed', items: [{ id: 'user', kind: 'userMessage', data: { clientId: request.sendId, content: [{ type: 'text', text: request.text }] } }] }];
  await state(page, value);
  await expect(page.locator('.pending-send')).toHaveCount(0);
  await expect(page.locator('.message.user')).toHaveCount(1);
  await expect(prompt).toHaveValue('次に書いた下書き');
});

for (const running of [false, true]) for (const order of ['state-first', 'ack-first']) test(`follow-up input renders immediately ${running ? 'during a command' : 'after completion'} and reconciles ${order}`, async ({ page }) => {
  const value = task();
  const text = 'テストも確認してください。<script>安全に表示</script>';
  value.status = running ? 'running' : 'idle'; value.activeTurnId = running ? 'existing-turn' : undefined;
  value.turns = [{ id: 'existing-turn', status: running ? 'inProgress' : 'completed', items: [
    { id: 'existing-user', kind: 'userMessage', data: { content: [{ type: 'text', text }] } },
    { id: 'command', kind: 'commandExecution', data: { command: 'npm test', status: running ? 'inProgress' : 'completed', aggregatedOutput: 'テストを実行' } },
  ] }];
  await state(page, value);
  const prompt = page.getByLabel('メッセージ', { exact: true });
  await prompt.fill(text);
  const immediate = await page.evaluate(() => {
    (document.getElementById('composer') as HTMLFormElement).requestSubmit();
    return { draft: (document.getElementById('prompt') as HTMLTextAreaElement).value,
      text: document.querySelector('.pending-send .user-text')?.textContent,
      status: document.querySelector('.pending-status')?.textContent,
      disabled: (document.getElementById('send') as HTMLButtonElement).disabled };
  });
  expect(immediate).toEqual({ draft: '', text, status: '送信中…', disabled: true });
  const request = (await messages(page)).findLast(message => message.type === 'send')!;
  expect((await messages(page)).filter(message => message.type === 'send')).toHaveLength(1);
  value.busy = true;
  value.turns[0]!.items[1]!.data.aggregatedOutput = 'コマンドの出力が更新されました';
  await state(page, value);
  await expect(page.locator('.user-text')).toHaveText([text, text]);
  await expect(page.locator('.pending-send')).toHaveCount(1);
  await prompt.fill(text);
  if (order === 'ack-first') {
    await sendResult(page, 'sent');
    await expect(page.locator('.pending-status')).toHaveText('送信済み');
    await expect(page.locator('.user-text')).toHaveText([text, text]);
  }
  const item = { id: 'followup-user', kind: 'userMessage', data: {
    ...(running ? {} : { clientId: request.sendId }), content: [{ type: 'text', text, text_elements: [] }],
  } };
  if (running) value.turns[0]!.items.push(item);
  else value.turns.push({ id: 'followup-turn', status: 'inProgress', items: [item] });
  value.busy = false; value.status = 'running'; value.activeTurnId = value.turns.at(-1)!.id;
  await state(page, value);
  if (order === 'state-first') {
    await expect(page.locator('#send')).toBeDisabled();
    await sendResult(page, 'sent');
  }
  await expect(page.locator('.pending-send')).toHaveCount(0);
  await expect(page.locator('.user-text')).toHaveText([text, text]);
  await expect(prompt).toHaveValue(text);
  await expect(page.getByRole('button', { name: '追加入力', exact: true })).toBeEnabled();
});

test('identical queued follow-ups each wait for their own message across updates and reloads', async ({ page }, info) => {
  const value = task(); value.status = 'running'; value.activeTurnId = 'active';
  const text = '同じ指示を追加';
  value.turns = [{ id: 'active', status: 'inProgress', items: [
    { id: 'initial', kind: 'userMessage', data: { content: [{ type: 'text', text }] } },
    { id: 'command', kind: 'commandExecution', data: { command: 'npm test', status: 'inProgress' } },
  ] }];
  await state(page, value);
  const prompt = page.getByLabel('メッセージ', { exact: true });
  for (let index = 0; index < 2; index++) {
    await prompt.fill(text); await prompt.press('Enter'); await sendResult(page, 'sent');
  }
  expect((await messages(page)).filter(message => message.type === 'send')).toHaveLength(2);
  await expect(page.locator('.pending-send .user-text')).toHaveText([text, text]);
  await expect(page.locator('.user-text')).toHaveText([text, text, text]);
  await page.screenshot({ path: info.outputPath('queued-followups.png') });
  value.turns[0]!.items.push({ id: 'followup-1', kind: 'userMessage', data: { clientId: null, content: [{ type: 'text', text, text_elements: [] }] } });
  await state(page, value); await state(page, value);
  await expect(page.locator('.pending-send')).toHaveCount(1);
  await expect(page.locator('.user-text')).toHaveText([text, text, text]);
  await prompt.fill('次の下書き'); await state(page, value);
  await page.reload(); await state(page, value);
  await expect(page.locator('.pending-send .user-text')).toHaveText(text);
  await expect(page.locator('.pending-status')).toHaveText('送信済み');
  await expect(prompt).toHaveValue('次の下書き');
  value.turns[0]!.items.push({ id: 'followup-2', kind: 'userMessage', data: { content: [{ type: 'text', text }] } });
  await state(page, value);
  await expect(page.locator('.pending-send')).toHaveCount(0);
  await expect(page.locator('.user-text')).toHaveText([text, text, text]);
  expect((await messages(page)).filter(message => message.type === 'send')).toHaveLength(0);
});

test('a failed follow-up preserves earlier queued input, attachments and the next draft', async ({ page }) => {
  const value = task(); value.status = 'running'; value.activeTurnId = 'active';
  value.turns = [{ id: 'active', status: 'inProgress', items: [{ id: 'command', kind: 'commandExecution', data: { command: 'npm test', status: 'inProgress' } }] }];
  await state(page, value);
  const prompt = page.getByLabel('メッセージ', { exact: true });
  await prompt.fill('先に送った指示'); await prompt.press('Enter'); await sendResult(page, 'sent');
  await pasteClipboardImages(page); await acceptImages(page, value, await imageRequest(page));
  await prompt.fill('この画像も確認'); await prompt.press('Enter');
  await sendResult(page, 'failure');
  await expect(prompt).toHaveValue('この画像も確認');
  await expect(page.locator('.pending-send .user-text')).toHaveText('先に送った指示');
  await expect(page.locator('#attachments img')).toHaveCount(1);
  await prompt.press('Enter');
  await prompt.fill('次の下書き');
  await sendResult(page, 'failure');
  await expect(prompt).toHaveValue('次の下書き');
  await expect(page.locator('.pending-send .user-text')).toHaveText(['先に送った指示', 'この画像も確認']);
  await expect(page.locator('.pending-send img')).toHaveCount(1);
  await expect(page.locator('#attachments')).toBeHidden();
  await expect(page.getByRole('button', { name: '再送', exact: true })).toBeDisabled();
  await prompt.press('Enter');
  expect((await messages(page)).findLast(message => message.type === 'send')).toMatchObject({ text: '次の下書き', attachmentIds: [] });
  await expect(page.locator('.pending-send .user-text')).toHaveText(['先に送った指示', 'この画像も確認', '次の下書き']);
});

test('the icon-only preset button requests each switch and reflects settings from the host', async ({ page }) => {
  const value = task();
  await state(page, value, undefined, true, 3);
  const cycle = page.getByRole('button', { name: 'プリセットを切り替え' });
  await expect(cycle).toBeEnabled();
  await expect(cycle).toHaveText('');
  await cycle.click();
  await cycle.press('Enter');
  await cycle.press('Space');
  expect((await messages(page)).filter(message => message.type === 'cyclePreset')).toHaveLength(3);
  expect((await messages(page)).filter(message => message.type === 'settings')).toHaveLength(0);
  const beforeSwitch = await cycle.boundingBox();
  value.settings = { model: 'catalog-model', effort: 'new-effort', mode: 'read-only' };
  await state(page, value, undefined, true, 3);
  await expect(page.locator('#model')).toHaveValue('catalog-model');
  await expect(page.locator('#effort')).toHaveValue('new-effort');
  await expect(page.locator('#mode')).toHaveValue('read-only');
  expect((await cycle.boundingBox())!.x).toBeCloseTo(beforeSwitch!.x, 1);
  for (const status of ['running', 'approval', 'input'] as const) {
    value.status = status; await state(page, value);
    await expect(cycle).toBeDisabled();
  }
  value.status = 'idle'; value.busy = true; await state(page, value);
  await expect(cycle).toBeDisabled();
  value.busy = false; value.activeTurnId = 'turn-1'; await state(page, value);
  await expect(cycle).toBeDisabled();
  value.activeTurnId = undefined; await state(page, value);
  await expect(cycle).toBeEnabled();
});

test('Codex remaining gauges precede the model and show persistent hover and keyboard details', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const value = task(); value.settings = { model: 'latest', effort: 'high', mode: 'auto-review' };
  const usage = decodeUsage({ rateLimitsByLimitId: {
    codex_other: { primary: { usedPercent: 99, windowDurationMins: 300 } },
    codex: { primary: { usedPercent: 66, windowDurationMins: 10_080, resetsAt: 2_000_000_000 }, secondary: { usedPercent: 28, windowDurationMins: 300, resetsAt: 1_999_999_000 } },
  } });
  await state(page, value, usage);
  const fiveHour = page.getByRole('meter', { name: 'Codex 5時間枠の残量' });
  const weekly = page.getByRole('meter', { name: 'Codex 週次枠の残量' });
  await expect(page.getByRole('meter')).toHaveCount(2);
  await expect(fiveHour).toHaveAttribute('aria-valuenow', '72');
  await expect(weekly).toHaveAttribute('aria-valuenow', '34');
  await expect(page.locator('#composer .usage-value')).toHaveText(['72%', '34%']);
  const boxes = await Promise.all([fiveHour.boundingBox(), weekly.boundingBox(), page.locator('#model').boundingBox(), page.locator('#cycle-preset').boundingBox(), page.locator('#send').boundingBox()]);
  expect(boxes[0]!.x + boxes[0]!.width).toBeLessThan(boxes[1]!.x);
  expect(boxes[1]!.x + boxes[1]!.width).toBeLessThan(boxes[2]!.x);
  expect(boxes[2]!.x + boxes[2]!.width).toBeLessThan(boxes[3]!.x);
  expect(boxes[3]!.x + boxes[3]!.width).toBeLessThan(boxes[4]!.x);
  await page.screenshot({ path: info.outputPath('usage-gauges.png') });
  await fiveHour.hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toContainText('Codex · 5時間枠');
  await expect(tooltip).toContainText('残り 72%');
  await expect(tooltip).toContainText('リセット予定:');
  await tooltip.hover();
  await expect(tooltip).toBeVisible();
  await page.screenshot({ path: info.outputPath('usage-hover.png') });
  await page.getByLabel('メッセージ', { exact: true }).hover({ position: { x: 15, y: 12 } });
  await expect(tooltip).toHaveCount(0);
  await weekly.focus();
  await expect(tooltip).toContainText('Codex · 週次枠');
  usage.buckets.find(bucket => bucket.id === 'codex')!.windows[0]!.usedPercent = 85;
  await state(page, value, usage);
  await expect(weekly).toBeFocused();
  await expect(tooltip).toContainText('残り 15%');
  await weekly.press('Escape');
  await expect(tooltip).toHaveCount(0);
  await fiveHour.hover();
  await expect(tooltip).toContainText('5時間枠');
  await page.getByLabel('メッセージ', { exact: true }).press('Escape');
  await expect(tooltip).toHaveCount(0);
  await page.getByLabel('メッセージ', { exact: true }).hover({ position: { x: 15, y: 12 } });
  await page.setViewportSize({ width: 380, height: 800 });
  await fiveHour.hover();
  await expect(tooltip).toContainText('5時間枠');
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(380);
  const splitModel = await page.locator('#model').boundingBox();
  const splitWeek = await weekly.boundingBox();
  const splitPreset = await page.locator('#cycle-preset').boundingBox();
  const splitSend = await page.locator('#send').boundingBox();
  expect(splitWeek!.x + splitWeek!.width).toBeLessThan(splitModel!.x);
  expect(splitModel!.x + splitModel!.width).toBeLessThan(splitPreset!.x);
  expect(splitPreset!.x + splitPreset!.width).toBeLessThan(splitSend!.x);
  expect(splitModel!.y).toBeLessThan(splitWeek!.y + splitWeek!.height);
  value.settings = { model: 'catalog-model', effort: 'new-effort', mode: 'read-only' };
  await state(page, value, usage);
  expect((await page.locator('#cycle-preset').boundingBox())!.x).toBeCloseTo(splitPreset!.x, 1);
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(380);
  await page.screenshot({ path: info.outputPath('usage-split.png') });
  expect(errors).toEqual([]);
});

test('weekly-only accounts show one gauge and missing balances never become zero percent', async ({ page }, info) => {
  const value = task();
  const usage = decodeUsage({ rateLimits: { limitId: 'codex', planType: 'pro', primary: { usedPercent: 12.5, windowDurationMins: 10_080 }, secondary: null } });
  await state(page, value, usage);
  const weekly = page.getByRole('meter', { name: 'Codex 週次枠の残量' });
  await expect(page.getByRole('meter')).toHaveCount(1);
  await expect(weekly).toHaveAttribute('aria-valuetext', '残り87.5%');
  await weekly.hover();
  await expect(page.getByRole('tooltip')).toHaveText('Codex · 週次枠残り 87.5%');
  await page.screenshot({ path: info.outputPath('usage-weekly-only.png') });
  usage.buckets[0]!.windows[0]!.usedPercent = 110;
  await state(page, value, usage);
  await expect(weekly).toHaveAttribute('aria-valuenow', '0');
  await state(page, value, undefined);
  await expect(page.locator('#usage-gauges')).toBeHidden();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await state(page, value, usage, false);
  await expect(page.locator('#usage-gauges')).toBeHidden();
  await state(page, value, decodeUsage({ rateLimits: { primary: { usedPercent: 20 } } }));
  await expect(page.locator('#usage-gauges')).toBeHidden();
});

test('weekly hover lists reset ticket expirations and sends only a confirmation request on the first click', async ({ page }, info) => {
  // acquireVsCodeApi only records messages in this fixture; there is no extension or real account bridge.
  await page.route('**/*', route => route.request().url().startsWith('http://localhost/') ? route.fallback() : route.abort());
  const value = task();
  const usage = decodeUsage({ rateLimits: { limitId: 'codex', primary: { usedPercent: 20, windowDurationMins: 300 }, secondary: { usedPercent: 80, windowDurationMins: 10_080 } },
    rateLimitResetCredits: { availableCount: 2, credits: [
      { id: 'fake-one', resetType: 'codexRateLimits', status: 'available', title: 'ボーナスチケット', expiresAt: 4_000_000_000 },
      { id: 'fake-two', resetType: 'codexRateLimits', status: 'available', title: '追加チケット', expiresAt: null },
    ] } });
  await state(page, value, usage);
  await page.getByRole('meter', { name: 'Codex 5時間枠の残量' }).hover();
  await expect(page.getByRole('tooltip')).not.toContainText('チケット');
  const weekly = page.getByRole('meter', { name: 'Codex 週次枠の残量' });
  await weekly.hover();
  const popup = page.getByRole('dialog', { name: 'Codex 週次枠' });
  await expect(popup).toContainText('リセットチケット · 残り2枚');
  await expect(popup).toContainText('有効期限: 2096/');
  await expect(popup).toContainText('有効期限: なし');
  await expect(popup.getByRole('button')).toHaveCount(2);
  const use = popup.getByRole('button', { name: 'ボーナスチケットを使用' });
  await use.hover();
  await expect(popup).toBeVisible();
  expect((await messages(page)).filter(message => message.type === 'requestResetCredit')).toHaveLength(0);
  await page.setViewportSize({ width: 380, height: 700 });
  await weekly.hover();
  await expect(popup).toBeVisible();
  const box = (await popup.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(380); expect(box.y).toBeGreaterThanOrEqual(0);
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(380);
  await page.screenshot({ path: info.outputPath('weekly-reset-tickets.png') });
  await use.click();
  await use.evaluate(button => (button as HTMLButtonElement).click());
  await expect(use).toBeDisabled();
  await expect(popup.getByRole('button', { name: '追加チケットを使用' })).toBeDisabled();
  const requests = (await messages(page)).filter(message => message.type === 'requestResetCredit');
  expect(requests).toHaveLength(1); expect(requests[0]).toMatchObject({ creditId: 'fake-one', requestId: expect.any(String) });
  expect((await messages(page)).some(message => String(message.type).includes('consume'))).toBe(false);
  await receive(page, { type: 'resetCreditResult', requestId: 'stale-response' });
  await expect(use).toBeDisabled();
  await receive(page, { type: 'resetCreditResult', requestId: requests[0]!.requestId }); // Simulated cancellation.
  await expect(use).toBeEnabled();
  await expect(popup).toContainText('残り2枚');
  await use.click();
  const retry = (await messages(page)).findLast(message => message.type === 'requestResetCredit')!;
  await receive(page, { type: 'resetCreditResult', requestId: retry.requestId, error: 'テスト用の通信エラー' });
  await expect(popup.getByRole('status')).toHaveText('テスト用の通信エラー');
  await expect(use).toBeEnabled();
});

test('ticket popovers support keyboard focus, streaming updates, Escape and refreshed balances', async ({ page }) => {
  const value = task();
  const usage = decodeUsage({ rateLimits: { primary: { usedPercent: 80, windowDurationMins: 10_080 } },
    rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'fake', resetType: 'codexRateLimits', status: 'available', title: '<img src=x onerror=alert(1)>', expiresAt: null }] } });
  await state(page, value, usage);
  const weekly = page.getByRole('meter', { name: 'Codex 週次枠の残量' });
  const popup = page.getByRole('dialog', { name: 'Codex 週次枠' });
  await weekly.focus();
  await weekly.press('Tab');
  const use = popup.getByRole('button');
  await expect(use).toBeFocused();
  await expect(popup.locator('img')).toHaveCount(0);
  await state(page, value, usage);
  await expect(use).toBeFocused();
  await expect(popup).toBeVisible();
  await use.press('Escape');
  await expect(weekly).toBeFocused();
  await expect(popup).toHaveCount(0);
  await page.getByLabel('メッセージ', { exact: true }).focus();
  await weekly.focus();
  await weekly.press('Tab');
  await use.press('Enter');
  const request = (await messages(page)).findLast(message => message.type === 'requestResetCredit')!;
  expect(request.creditId).toBe('fake');
  usage.resetCredits = { availableCount: 0, credits: [] };
  usage.buckets[0]!.windows[0]!.usedPercent = 0;
  await state(page, value, usage);
  await receive(page, { type: 'resetCreditResult', requestId: request.requestId, message: 'テスト用のリセット完了' });
  await weekly.focus();
  await expect(popup).toContainText('残り0枚');
  await expect(popup).toContainText('使用可能なチケットはありません。');
  await expect(popup.getByRole('button')).toHaveCount(0);
  await expect(weekly).toHaveAttribute('aria-valuenow', '100');
  await state(page, value, usage, false);
  await expect(popup).toHaveCount(0);
});

test('expired tickets and count-only summaries never offer an unverified use button', async ({ page }) => {
  const usage = decodeUsage({ rateLimits: { primary: { usedPercent: 90, windowDurationMins: 10_080 } },
    rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'expired', resetType: 'codexRateLimits', status: 'available', expiresAt: 1 }] } });
  await state(page, task(), usage);
  const weekly = page.getByRole('meter', { name: 'Codex 週次枠の残量' });
  await weekly.hover();
  const popup = page.getByRole('dialog', { name: 'Codex 週次枠' });
  await expect(popup).toContainText('残り0枚');
  await expect(popup.getByRole('button')).toHaveCount(0);
  usage.resetCredits = { availableCount: 3 };
  await state(page, task(), usage);
  await expect(popup).toContainText('残り3枚');
  await expect(popup).toContainText('チケットの詳細を取得できません');
  await expect(popup.getByRole('button')).toHaveCount(0);
  expect((await messages(page)).filter(message => message.type === 'requestResetCredit')).toHaveLength(0);
});

test('clipboard images appear inside the composer with removable previews and block sends until attached', async ({ page }, info) => {
  const value = task(); await state(page, value);
  const prompt = page.getByLabel('メッセージ', { exact: true });
  const send = page.getByRole('button', { name: '送信', exact: true });
  await prompt.fill('test');
  expect(await pasteClipboardImages(page, [{}, {}], false, true)).toBe(true);
  expect((await messages(page)).filter(message => message.type === 'send')).toHaveLength(0);
  const request = await imageRequest(page);
  expect(request.urls).toHaveLength(2);
  await expect(send).toBeDisabled();
  await expect(page.locator('#image-status')).toHaveText('画像を読み込み中…');
  await state(page, value); await receive(page, { type: 'failure' });
  await prompt.press('Enter');
  expect((await messages(page)).filter(message => message.type === 'send')).toHaveLength(0);
  await acceptImages(page, value, request);
  await expect(send).toBeEnabled();
  await expect(page.locator('#image-status')).toBeHidden();
  const previews = page.locator('#composer .attachment-image img');
  await expect(previews).toHaveCount(2);
  await expect.poll(() => previews.first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(240);
  await expect(prompt).toHaveValue('test');
  expect((await previews.first().boundingBox())!.y).toBeLessThan((await prompt.boundingBox())!.y);
  await page.screenshot({ path: info.outputPath('clipboard-images.png') });
  await page.setViewportSize({ width: 380, height: 800 });
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(380);
  await page.screenshot({ path: info.outputPath('clipboard-images-split.png') });
  await page.getByRole('button', { name: '貼り付けた画像を削除' }).first().click();
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'removeAttachment', id: value.attachments[0]!.id });
  expect((await messages(page)).filter(message => message.type === 'send')).toHaveLength(0);
  await expect(prompt).toBeFocused();
  value.attachments.shift(); await state(page, value);
  await expect(previews).toHaveCount(1);
});

test('image-only drafts survive send failures and show the sent image in the conversation', async ({ page }) => {
  const value = task(); value.threadId = undefined; await state(page, value);
  await pasteClipboardImages(page);
  await acceptImages(page, value, await imageRequest(page));
  const prompt = page.getByLabel('メッセージ', { exact: true });
  await prompt.press('Enter');
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'send', text: '', skillPaths: [] });
  await sendResult(page, 'failure');
  await expect(page.locator('#attachments img')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '送信', exact: true })).toBeEnabled();
  await prompt.fill('この画像を確認してください。'); await prompt.press('Enter');
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'send', text: 'この画像を確認してください。' });
  await expect(prompt).toHaveValue('');
  const request = (await messages(page)).findLast(message => message.type === 'send')!;
  value.turns = [{ id: 'image-turn', status: 'inProgress', items: [{ id: 'user', kind: 'userMessage', data: { clientId: request.sendId, content: [{ type: 'text', text: 'この画像を確認してください。' }, value.attachments[0]!.input] } }] }];
  value.attachments = []; await state(page, value);
  await sendResult(page, 'sent');
  await expect(prompt).toHaveValue('');
  await expect(page.locator('#attachments')).toBeHidden();
  await expect(page.locator('#transcript img')).toBeVisible();
});

test('invalid images and read failures show errors and allow a subsequent paste', async ({ page }) => {
  const value = task(); await state(page, value);
  const status = page.locator('#image-status');
  for (const file of [{ size: 8 * 1024 * 1024 + 1 }, { type: 'image/svg+xml' }, { size: 0 }]) {
    expect(await pasteClipboardImages(page, [file])).toBe(true);
    await expect(status).toHaveText('8MB以下のPNG・JPEG・WebP・GIF画像を使用してください。');
  }
  await page.evaluate(() => {
    const read = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function () {
      FileReader.prototype.readAsDataURL = read;
      this.dispatchEvent(new ProgressEvent('error'));
    };
  });
  await pasteClipboardImages(page);
  await expect(status).toHaveText('画像を読み込めませんでした。もう一度貼り付けてください。');
  expect((await messages(page)).filter(message => message.type === 'pasteImages')).toHaveLength(0);
  await expect(page.getByRole('button', { name: '送信', exact: true })).toBeEnabled();
  await pasteClipboardImages(page);
  const rejected = await imageRequest(page);
  await receive(page, { type: 'imagesPasted', requestId: rejected.requestId, error: '画像を添付できませんでした。' });
  await expect(status).toHaveText('画像を添付できませんでした。');
  await expect(page.getByRole('button', { name: '送信', exact: true })).toBeEnabled();
  await pasteClipboardImages(page);
  await acceptImages(page, value, await imageRequest(page, 2));
  await expect(status).toBeHidden();
  await expect(page.locator('#attachments img')).toHaveCount(1);
});

test('successive pastes keep sending disabled until every image batch is acknowledged', async ({ page }) => {
  const value = task(); await state(page, value);
  await pasteClipboardImages(page); const first = await imageRequest(page);
  await pasteClipboardImages(page); const second = await imageRequest(page, 2);
  await acceptImages(page, value, first);
  await expect(page.getByRole('button', { name: '送信', exact: true })).toBeDisabled();
  await receive(page, { type: 'imagesPasted', requestId: first.requestId, attachments: [] });
  await expect(page.getByRole('button', { name: '送信', exact: true })).toBeDisabled();
  await expect(page.locator('#attachments img')).toHaveCount(1);
  await acceptImages(page, value, second);
  await expect(page.locator('#attachments img')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '送信', exact: true })).toBeEnabled();
});

test('text and non-image pastes keep native behavior, and clipboard files work without items', async ({ page }) => {
  const value = task(); await state(page, value);
  const prevented = await page.evaluate(() => {
    const data = new DataTransfer(); data.setData('text/plain', '通常の貼り付け');
    data.items.add(new File(['text'], 'notes.txt', { type: 'text/plain' }));
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    document.getElementById('prompt')!.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(false);
  expect((await messages(page)).filter(message => message.type === 'pasteImages')).toHaveLength(0);
  expect(await pasteClipboardImages(page, [{}], true)).toBe(true);
  await acceptImages(page, value, await imageRequest(page));
  await expect(page.locator('#attachments img')).toHaveCount(1);
});

for (const active of [false, true]) test(`multiple deep links stay compact when pasted and ${active ? 'steered into an active turn' : 'sent as a new turn'}`, async ({ page }, info) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-deck-ui-references-'));
  const gateway = new FakeGateway();
  const answers = ['参照元だけにある最初の回答', '参照元だけにある二番目の回答'];
  for (const [index, id] of ['first', 'second'].entries()) {
    const source = thread(id);
    source.turns = [{ id: `${id}-turn`, status: 'completed', items: [{ id: `${id}-answer`, kind: 'agentMessage', data: { text: answers[index] } }] }];
    gateway.threads.set(id, source);
  }
  const reads: string[] = [];
  gateway.threadReader = async id => { reads.push(id); return structuredClone(gateway.threads.get(id)!); };
  const manager = new TaskManager(gateway, { async save() {} }, [], { schedule: false, referenceTempRoot: directory });
  try {
    const value = manager.create('/project');
    if (active) await manager.send(value.id, 'このタスクで作業してください。');
    await state(page, value);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const text = '[最初の会話](codex://threads/first)[二番目の会話](codex://threads/second)\ncodex://threads/first、codex://threads/second を参照してください。';
    await page.evaluate(text => navigator.clipboard.writeText(text), text);
    const prompt = page.getByLabel('メッセージ', { exact: true });
    await prompt.focus(); await prompt.press('ControlOrMeta+V');
    await expect(prompt).toHaveValue(text);
    expect(reads).toEqual([]);
    await prompt.press('Enter');
    const request = (await messages(page)).findLast(message => message.type === 'send')!;
    expect(request.text).toBe(text);
    await expect(page.locator('.pending-send .user-text')).toHaveText(text);
    await manager.send(value.id, request.text as string, [], { clientId: request.sendId as string });
    expect(reads).toEqual(['first', 'second']);
    const input = (active ? gateway.steered.at(-1) : gateway.sent.at(-1))!.input;
    expect(input).toHaveLength(3);
    for (const [index, reference] of input.slice(1).entries()) {
      const snapshot = /^スナップショット: (.+)$/m.exec(taskReferenceBody(reference.text!)!);
      expect(snapshot).toBeTruthy();
      const filename = JSON.parse(snapshot![1]!);
      expect(await readFile(filename, 'utf8')).toContain(answers[index]);
      expect(reference.text!.length).toBeLessThan(500);
    }
    if (active) gateway.events.emit({ type: 'item', threadId: value.threadId!, turnId: value.activeTurnId!, completed: true,
      item: { id: 'steered-user', kind: 'userMessage', data: { content: input } } });
    await state(page, value); await sendResult(page, 'sent');
    await expect(prompt).toHaveValue('');
    await expect(page.locator('.pending-send')).toHaveCount(0);
    const message = page.locator('.message.user').last();
    await expect(message.locator('.user-text')).toHaveCount(1);
    await expect(message.locator('.user-bubble')).toHaveText(text);
    const references = message.locator(':scope > .message-references');
    await expect(references.locator('summary')).toHaveText('参照情報 · 2件（Codex Deckが自動追加）');
    await expect(references).not.toHaveAttribute('open');
    await expect(references.locator('.reference-text').first()).toBeHidden();
    for (const answer of answers) await expect(page.locator('#conversation')).not.toContainText(answer);
    await page.screenshot({ path: info.outputPath('multiple-deep-links.png') });
    await references.locator('summary').click();
    await expect(references.locator('.reference-text')).toHaveCount(2);
    for (const [index, id] of ['first', 'second'].entries()) {
      await expect(references.locator('.reference-text').nth(index)).toBeVisible();
      await expect(references.locator('.reference-text').nth(index)).toContainText(`参照会話: codex://threads/${id}`);
      await expect(references.locator('.reference-text').nth(index)).toContainText('必要に応じてスナップショットを読んでください。');
    }
    value.turns.at(-1)!.items.push({ id: 'progress', kind: 'agentMessage', data: { text: '会話を確認します。', phase: 'commentary' } });
    await state(page, value);
    await expect(references).toHaveAttribute('open', '');
    if (active) await page.setViewportSize({ width: 390, height: 850 });
    await page.screenshot({ path: info.outputPath('multiple-deep-links-expanded.png') });
    await page.reload(); await state(page, value);
    await expect(message.locator('.user-bubble')).toHaveText(text);
    await expect(references).not.toHaveAttribute('open');
    await expect(page.locator('.pending-send')).toHaveCount(0);
  } finally { manager.dispose(); await manager.flush(); await rm(directory, { recursive: true, force: true }); }
});

test('skill selection inserts a token and sends exact skill paths only while their mentions remain in the draft', async ({ page }) => {
  await state(page, task()); await catalog(page);
  const prompt = page.getByLabel('メッセージ', { exact: true });
  await page.getByRole('button', { name: '$registered-two 登録された二つ目のスキル' }).click();
  await expect(prompt).toHaveValue('$registered-two ');
  expect((await messages(page)).filter(message => message.type === 'send')).toHaveLength(0);
  await prompt.press('End'); await prompt.pressSequentially('Use this'); await prompt.press('Enter');
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'send', text: '$registered-two Use this', skillPaths: ['/skills/two/SKILL.md'] });
  await sendResult(page, 'failure');
  await prompt.fill('スキル指定を取り消した'); await prompt.press('Enter');
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'send', text: 'スキル指定を取り消した', skillPaths: [] });
});

test('slash commands filter locally, use keyboard selection, and skills/mention open inline pickers', async ({ page }) => {
  await state(page, task()); await catalog(page);
  const prompt = page.getByLabel('メッセージ', { exact: true });
  await prompt.fill('/');
  await expect(page.getByRole('option', { name: '/model モデルと推論の強さを選択' })).toBeVisible();
  await prompt.press('Escape');
  await prompt.pressSequentially('m');
  await expect(page.locator('#completion-list [role=option]')).toHaveCount(3);
  await prompt.press('Backspace');
  await expect(page.locator('#completion-list [role=option]')).toHaveCount(21);
  await prompt.press('ArrowDown'); await prompt.press('Tab');
  await expect(prompt).toHaveValue('/permissions ');
  expect((await messages(page)).filter(message => message.type === 'send')).toHaveLength(0);
  await prompt.fill('/per'); await prompt.press('Enter');
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'send', text: '/permissions ' });
  await sendResult(page, 'sent');
  await prompt.fill('/skills'); await prompt.press('Enter');
  await expect(prompt).toHaveValue('$');
  await expect(page.locator('#completion-list [role=option]')).toHaveCount(2);
  await prompt.press('ArrowDown'); await prompt.press('Enter');
  await expect(prompt).toHaveValue('$registered-two ');
  expect((await messages(page)).filter(message => message.type === 'send')).toHaveLength(1);
  await prompt.fill('/mention'); await page.getByRole('button', { name: '送信', exact: true }).click();
  await expect(prompt).toHaveValue('@');
  await fileRequest(page, '');
  expect((await messages(page)).filter(message => message.type === 'send')).toHaveLength(1);
});

for (const enterBehavior of ['modEnter', 'enter']) test(`Tab-completed slash commands execute on Enter with ${enterBehavior} settings`, async ({ page }) => {
  const value = task();
  value.settings.collaborationMode = 'plan';
  const update = () => receive(page, { type: 'state', task: value, models, connected: true, enterBehavior });
  await update(); await catalog(page);
  const prompt = page.getByLabel('メッセージ', { exact: true });
  await expect(page.locator('#plan-mode')).toBeVisible();
  for (const [index, name] of ['plan', 'permissions'].entries()) {
    await prompt.fill(`/${name}`);
    await prompt.press('Tab');
    await expect(prompt).toHaveValue(`/${name} `);
    await expect(page.locator('#completions')).toBeHidden();
    expect((await messages(page)).filter(message => message.type === 'send')).toHaveLength(index);
    await prompt.press('Enter');
    expect((await messages(page)).filter(message => message.type === 'send')).toHaveLength(index + 1);
    expect((await messages(page)).at(-1)).toMatchObject({ type: 'send', text: `/${name} ` });
    value.settings.collaborationMode = 'default';
    await update(); await sendResult(page, 'sent');
    await expect(prompt).toHaveValue('');
    await expect(page.locator('#plan-mode')).toBeHidden();
  }
});

test('Tab completion keeps Shift+Enter as a newline and command arguments use the configured send key', async ({ page }) => {
  await receive(page, { type: 'state', task: task(), models, connected: true, enterBehavior: 'modEnter' });
  await catalog(page);
  const prompt = page.getByLabel('メッセージ', { exact: true });
  await prompt.fill('/plan'); await prompt.press('Tab'); await prompt.press('Shift+Enter');
  await expect(prompt).toHaveValue('/plan \n');
  expect((await messages(page)).filter(message => message.type === 'send')).toHaveLength(0);
  for (const text of ['通常のメッセージ', '/plan 計画してください', '/unknown ']) {
    await prompt.fill(text); await prompt.press('Enter');
    await expect(prompt).toHaveValue(`${text}\n`);
    expect((await messages(page)).filter(message => message.type === 'send')).toHaveLength(0);
  }
  await prompt.fill('/plan 計画してください'); await prompt.press('Control+Enter');
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'send', text: '/plan 計画してください' });
});

test('plan commands complete and submit with attachments while the current mode stays visible', async ({ page }, info) => {
  const value = task();
  await state(page, value); await catalog(page);
  const prompt = page.getByLabel('メッセージ', { exact: true });
  await expect(page.locator('#plan-mode')).toBeHidden();
  await prompt.fill('/pl');
  await expect(page.getByRole('option', { name: '/plan プランモードを切り替え・続けて指示を入力' })).toBeVisible();
  await prompt.press('Enter');
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'send', text: '/plan ' });
  value.settings.collaborationMode = 'plan';
  await state(page, value); await sendResult(page, 'sent');
  await expect(prompt).toHaveValue('');
  await expect(page.locator('#plan-mode')).toHaveText('プランモード · /plan で通常モードに戻る');
  await pasteClipboardImages(page); await acceptImages(page, value, await imageRequest(page));
  await prompt.fill('/plan $registered-one この画像の画面を設計してください');
  await prompt.press('Enter');
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'send', text: '/plan $registered-one この画像の画面を設計してください', attachmentIds: value.attachments.map(attachment => attachment.id) });
  await sendResult(page, 'failure');
  await expect(prompt).toHaveValue('/plan $registered-one この画像の画面を設計してください');
  await expect(page.locator('#plan-mode')).toBeVisible();
  await page.setViewportSize({ width: 380, height: 850 });
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(380);
  await page.screenshot({ path: info.outputPath('plan-mode.png'), fullPage: true });
  value.settings.collaborationMode = 'default';
  await state(page, value);
  await expect(page.locator('#plan-mode')).toBeHidden();
});

test('file lookup inserts a quoted path on Enter without submitting, and ignores stale responses after edits or Escape', async ({ page }, info) => {
  await state(page, task()); await catalog(page);
  const prompt = page.getByLabel('メッセージ', { exact: true });
  await prompt.fill('確認 @src');
  const first = await fileRequest(page, 'src');
  await prompt.press('Enter');
  expect((await messages(page)).filter(message => message.type === 'send')).toHaveLength(0);
  await prompt.fill('確認 @docs'); const second = await fileRequest(page, 'docs');
  await receive(page, { type: 'fileSearch', requestId: second.requestId, files: [{ path: 'docs/new file.md', kind: 'file' }] });
  await receive(page, { type: 'fileSearch', requestId: first.requestId, files: [{ path: 'src/stale.ts', kind: 'file' }] });
  await expect(page.getByRole('option', { name: 'docs/new file.md' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'src/stale.ts' })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('file-completion.png') });
  await prompt.press('Enter');
  await expect(prompt).toHaveValue('確認 "docs/new file.md" ');
  expect((await messages(page)).filter(message => message.type === 'send')).toHaveLength(0);
  await prompt.fill('@again'); const third = await fileRequest(page, 'again');
  await prompt.press('Escape');
  await receive(page, { type: 'fileSearch', requestId: third.requestId, files: [{ path: 'again.md', kind: 'file' }] });
  await expect(page.locator('#completions')).toBeHidden();
  await prompt.fill('確認 "docs/new file.md" を読んで'); await prompt.press('Enter');
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'send', text: '確認 "docs/new file.md" を読んで', skillPaths: [] });
});

test('IME Enter and empty/error lookups do not send partial input; file completion works in the middle of a draft', async ({ page }) => {
  await state(page, task()); await catalog(page);
  const prompt = page.getByLabel('メッセージ', { exact: true });
  await prompt.fill('日本語を入力中');
  await prompt.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  expect((await messages(page)).filter(message => message.type === 'send')).toHaveLength(0);
  await prompt.fill('@missing'); const first = await fileRequest(page, 'missing');
  await receive(page, { type: 'fileSearch', requestId: first.requestId, files: [], error: '検索できませんでした。' });
  await prompt.press('Enter');
  expect((await messages(page)).filter(message => message.type === 'send')).toHaveLength(0);
  await prompt.fill('before @src/old.ts after');
  await prompt.evaluate((element: HTMLTextAreaElement) => { element.setSelectionRange(11, 11); element.dispatchEvent(new Event('click')); });
  const second = await fileRequest(page, 'src');
  await receive(page, { type: 'fileSearch', requestId: second.requestId, files: [{ path: 'src/new.ts', kind: 'file' }] });
  await prompt.press('Tab');
  await expect(prompt).toHaveValue('before src/new.ts after');
  expect((await messages(page)).filter(message => message.type === 'send')).toHaveLength(0);
});

test('catalog invalidation and workspace changes refresh skills; empty catalogs have no suggestions or headings', async ({ page }) => {
  const value = task(); await state(page, value); await catalog(page);
  await receive(page, { type: 'catalogInvalidated' });
  const old = (await messages(page)).findLast(message => message.type === 'composerCatalog')!;
  value.cwd = '/another'; await state(page, value);
  await catalog(page, [], 'auto-review');
  await receive(page, { type: 'composerCatalog', requestId: old.requestId, skills });
  await expect(page.locator('#skills')).toBeHidden();
  await expect(page.locator('#conversation')).toBeEmpty();
});

test('CLI permission names reflect inherited settings and rendering does not change permissions', async ({ page }) => {
  const value = task(); await state(page, value); await catalog(page, skills, 'auto-review');
  const mode = page.getByLabel('Permissions', { exact: true });
  await expect(mode.locator('option')).toHaveText(['Ask for approval', 'Approve for me', 'Full Access']);
  await expect(mode).toHaveValue('default');
  expect((await messages(page)).filter(message => message.type === 'settings')).toHaveLength(0);
  await mode.selectOption('workspace-write');
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'settings', mode: 'workspace-write' });
  value.settings.mode = 'workspace-write'; await state(page, value);
  await mode.selectOption('auto-review');
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'settings', mode: 'auto-review' });
});

test('unset CLI defaults are not mislabeled Custom and resolve when the server returns thread permissions', async ({ page }) => {
  const value = task(); await state(page, value); await catalog(page, skills, 'default');
  const mode = page.getByLabel('Permissions', { exact: true });
  await expect(mode.locator('option:checked')).toHaveText('Permissions');
  value.effectivePermissionMode = 'workspace-write'; await state(page, value);
  await expect(mode.locator('option:checked')).toHaveText('Ask for approval');
  await expect(mode).toHaveValue('default');
  expect((await messages(page)).filter(message => message.type === 'settings')).toHaveLength(0);
});

test('registered metadata is rendered as text and long skill/file names fit split editors', async ({ page }, info) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await state(page, task());
  const long = '<img src=x onerror=alert(1)>' + 'long'.repeat(80);
  await catalog(page, [{ name: long, description: long, path: '/skills/test/SKILL.md', scope: 'user' }]);
  await expect(page.locator('#skills img')).toHaveCount(0);
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(380);
  await page.getByLabel('メッセージ', { exact: true }).fill('@long'); const request = await fileRequest(page, 'long');
  await receive(page, { type: 'fileSearch', requestId: request.requestId, files: [{ path: long, kind: 'file' }] });
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(380);
  await page.screenshot({ path: info.outputPath('split-completion.png') });
});

test('read acknowledgements require the completed unread turn to be rendered', async ({ page }) => {
  const value = task();
  value.unreadTurnId = 'answer';
  value.hydrated = false;
  await state(page, value);
  expect((await messages(page)).filter(message => message.type === 'read')).toEqual([]);
  value.hydrated = true;
  value.turns = [{ id: 'answer', status: 'inProgress', items: [] }];
  await state(page, value);
  expect((await messages(page)).filter(message => message.type === 'read')).toEqual([]);
  value.turns = [{ id: 'answer', status: 'completed', items: [{ id: 'agent', kind: 'agentMessage', data: { text: 'The answer is ready.' } }] }];
  await state(page, value);
  await expect(page.getByText('The answer is ready.', { exact: true })).toBeVisible();
  expect((await messages(page)).filter(message => message.type === 'read')).toEqual([{ type: 'read', turnId: 'answer' }]);
  value.unreadTurnId = undefined;
  await state(page, value);
  expect((await messages(page)).filter(message => message.type === 'read')).toHaveLength(1);
});

test('code block copy buttons appear on hover or focus and copy only their code', async ({ page }) => {
  const value = task();
  const codeText = 'const value = "<tag>";\n  run(value);';
  value.turns = [{ id: 'code', status: 'completed', items: [
    { id: 'reply', kind: 'agentMessage', data: { text: `回答です。\n\n\`\`\`ts\n${codeText}\n\`\`\`\n\n完了しました。` } },
  ] }];
  await state(page, value);
  const block = page.locator('.code-block');
  const button = block.locator('.code-copy');
  await expect(button).toHaveAccessibleName('コードをコピー');
  await expect(block.locator('code')).toHaveText(codeText);
  await page.mouse.move(1, 1);
  await expect(button).toHaveCSS('opacity', '0');
  await block.locator('pre').hover();
  await expect(button).toHaveCSS('opacity', '1');
  await button.click();
  const request = (await messages(page)).at(-1)!;
  expect(request).toEqual({ type: 'copyCode', requestId: 1, text: codeText });
  await receive(page, { type: 'codeCopied', requestId: request.requestId });
  await expect(button).toHaveAccessibleName('コピーしました');
  await expect(button.locator('.copied-icon')).toBeVisible();
  await page.locator('#prompt').hover();
  await page.locator('#prompt').focus();
  await expect(button).toHaveCSS('opacity', '0');
  await button.focus();
  await expect(button).toHaveCSS('opacity', '1');
});

test('message hover actions match their role, stay below the text, and address the selected message', async ({ page }, info) => {
  const value = task();
  value.turns = [{ id: 'earlier', status: 'completed', startedAt: Date.UTC(2026, 8, 9, 4, 29), completedAt: Date.UTC(2026, 8, 9, 4, 30), items: [
    { id: 'user', kind: 'userMessage', data: { content: [{ type: 'text', text: 'modelloader/VS2022/DevelopTools/ このフォルダは何？' }] } },
    { id: 'reply', kind: 'agentMessage', data: { text: '描画用の `GridLineView` コントロールを参照しています。\n\n要するに、開発用ツールをまとめたフォルダーです。' } },
  ] }, { id: 'later', status: 'completed', items: [
    { id: 'reply', kind: 'agentMessage', data: { text: '追加の回答です。' } },
  ] }];
  await state(page, value);
  const turn = page.locator('.turn[data-turn="earlier"]');
  const user = turn.locator('.message.user');
  const reply = turn.locator('.message.assistant');
  const later = page.locator('.turn[data-turn="later"] .message');
  const userCopy = user.locator('[data-message-action="copy"]');
  const replyCopy = reply.locator('[data-message-action="copy"]');
  const fork = reply.getByRole('button', { name: '新しいチャットに分岐' });
  await page.mouse.move(1, 1);
  await expect(user.locator('.message-footer')).toHaveCSS('opacity', '0');
  await expect(reply.locator('.message-footer')).toHaveCSS('opacity', '0');
  await expect(user.getByRole('button', { name: '新しいチャットに分岐' })).toHaveCount(0);
  const beforeHover = await reply.boundingBox();
  await user.locator('.user-bubble').hover();
  await expect(user.locator('.message-footer')).toHaveCSS('opacity', '1');
  await expect(reply.locator('.message-footer')).toHaveCSS('opacity', '0');
  const bubbleBox = (await user.locator('.user-bubble').boundingBox())!;
  const userCopyBox = (await userCopy.boundingBox())!;
  expect(userCopyBox.y).toBeGreaterThanOrEqual(bubbleBox.y + bubbleBox.height);
  expect(userCopyBox.x + userCopyBox.width).toBeCloseTo(bubbleBox.x + bubbleBox.width, 0);
  await expect(user.locator('time')).toHaveAttribute('datetime', '2026-09-09T04:29:00.000Z');
  await expect(userCopy).toHaveAttribute('title', 'メッセージをコピー');
  await page.screenshot({ path: info.outputPath('user-message-hover.png') });
  await userCopy.locator('svg').click();
  expect((await messages(page)).at(-1)).toEqual({ type: 'copyMessage', turnId: 'earlier', itemId: 'user' });
  await receive(page, { type: 'messageCopied', turnId: 'earlier', itemId: 'user' });
  await expect(userCopy).toHaveAccessibleName('コピーしました');
  await expect(userCopy.locator('.copied-icon')).toBeVisible();
  await page.locator('#prompt').focus();
  await reply.locator('.markdown').hover();
  await expect(user.locator('.message-footer')).toHaveCSS('opacity', '0');
  await expect(reply.locator('.message-footer')).toHaveCSS('opacity', '1');
  expect(await reply.boundingBox()).toEqual(beforeHover);
  const replyCopyBox = (await replyCopy.boundingBox())!;
  const markdownBox = (await reply.locator('.markdown').boundingBox())!;
  expect(replyCopyBox.x).toBeCloseTo(markdownBox.x, 0);
  expect(replyCopyBox.y).toBeGreaterThanOrEqual(markdownBox.y + markdownBox.height);
  expect((await fork.boundingBox())!.x).toBeGreaterThan(replyCopyBox.x);
  await page.screenshot({ path: info.outputPath('assistant-message-hover.png') });
  await fork.locator('svg').click();
  expect((await messages(page)).at(-1)).toEqual({ type: 'forkMessage', turnId: 'earlier', itemId: 'reply' });
  await replyCopy.click();
  expect((await messages(page)).at(-1)).toEqual({ type: 'copyMessage', turnId: 'earlier', itemId: 'reply' });
  await receive(page, { type: 'messageCopied', turnId: 'earlier', itemId: 'reply' });
  await expect(replyCopy).toHaveAttribute('data-copied');
  await expect(later.locator('[data-message-action="copy"]')).not.toHaveAttribute('data-copied');
  await expect(later.locator('time')).toHaveCount(0);

  await page.locator('#prompt').hover();
  await userCopy.focus();
  await userCopy.press('Tab');
  await expect(replyCopy).toBeFocused();
  await expect(reply.locator('.message-footer')).toHaveCSS('opacity', '1');
  value.status = 'running'; value.activeTurnId = 'later'; value.turns[1]!.status = 'inProgress';
  value.turns[1]!.items[0]!.data.phase = 'final_answer';
  value.turns[1]!.items[0]!.data.text += '処理中です。';
  await state(page, value);
  await expect(replyCopy).toBeFocused();
  await expect(fork).toBeEnabled();
  await expect(later.getByRole('button', { name: '新しいチャットに分岐' })).toBeDisabled();
  await replyCopy.press('Tab');
  await fork.press('Enter');
  expect((await messages(page)).at(-1)).toEqual({ type: 'forkMessage', turnId: 'earlier', itemId: 'reply' });
  await expect(replyCopy).toHaveAccessibleName('メッセージをコピー');
  await page.setViewportSize({ width: 380, height: 800 });
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(380);
  expect(await page.locator('#conversation').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('message-actions-split.png') });
  value.turns[0]!.items[0]!.data.content = [{ type: 'text', text: 'はい' }];
  await state(page, value);
  const shortBubble = (await user.locator('.user-bubble').boundingBox())!;
  const messageBox = (await user.boundingBox())!;
  expect(shortBubble.width).toBeLessThan(messageBox.width);
  expect(shortBubble.x + shortBubble.width).toBeCloseTo(messageBox.x + messageBox.width, 0);
});

test('completed work is collapsed above the final answer and preserves keyboard and nested tool state', async ({ page }, info) => {
  const value = task();
  value.turns = [{ id: 'completed', status: 'completed', durationMs: 712_345, items: [
    { id: 'user', kind: 'userMessage', data: { content: [{ type: 'text', text: '途中経過の表示を合わせてください。' }] } },
    { id: 'commentary', kind: 'agentMessage', data: { phase: 'commentary', text: '会話表示の実装を確認しています。' } },
    { id: 'command', kind: 'commandExecution', data: { command: 'npm test', status: 'completed', aggregatedOutput: '32 tests passed', exitCode: 0 } },
    { id: 'files', kind: 'fileChange', data: { changes: [{ path: 'src/webview/render.ts', diff: '+ progress group' }] } },
    { id: 'final', kind: 'agentMessage', data: { phase: 'final_answer', text: '途中経過を折りたたむ表示に変更しました。\n\n- 作業時間の行から詳細を開閉できます。\n- 最終回答は常に表示します。\n\n型チェックと画面テストが成功しました。' } },
  ] }];
  await state(page, value);
  const turn = page.locator('.turn[data-turn="completed"]');
  const progress = turn.locator('.turn-progress');
  const summary = progress.locator(':scope > summary');
  await expect(summary).toHaveText('11m 52s作業しました');
  await expect(progress).not.toHaveAttribute('open');
  await expect(page.getByText('会話表示の実装を確認しています。')).toBeHidden();
  await expect(page.getByText('コマンド · npm test')).toBeHidden();
  await expect(page.getByText('途中経過を折りたたむ表示に変更しました。', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('progress-collapsed.png') });

  await summary.focus(); await summary.press('Enter');
  await expect(page.getByText('会話表示の実装を確認しています。')).toBeVisible();
  await expect(page.getByText('32 tests passed')).toBeHidden();
  const command = turn.getByText('コマンド · npm test', { exact: true });
  await command.click();
  value.turns[0]!.items[2]!.data.aggregatedOutput = '33 tests passed';
  await state(page, value);
  await expect(turn.getByText('33 tests passed')).toBeVisible();
  await expect(command).toBeFocused();
  await page.screenshot({ path: info.outputPath('progress-expanded.png') });

  value.turns.push({ ...structuredClone(value.turns[0]!), id: 'another', durationMs: 2500 });
  await state(page, value);
  await expect(page.locator('.turn[data-turn="another"] .turn-progress')).not.toHaveAttribute('open');
  await expect(page.locator('.turn[data-turn="another"] details[data-item="command"]')).not.toHaveAttribute('open');
  await expect(turn.getByText('33 tests passed')).toBeVisible();
  await summary.click();
  value.turns[0]!.items[1]!.data.text = '確認を完了しました。';
  await state(page, value);
  await expect(progress).not.toHaveAttribute('open');
  await expect(summary).toBeFocused();
  await page.setViewportSize({ width: 380, height: 800 });
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(380);
  await page.screenshot({ path: info.outputPath('progress-split.png') });
});

test('live commentary remains visible while the final answer streams and collapses on completion', async ({ page }) => {
  const value = task(); value.status = 'running'; value.activeTurnId = 'live';
  value.turns = [{ id: 'live', status: 'inProgress', startedAt: 1_000_000, items: [
    { id: 'commentary', kind: 'agentMessage', data: { phase: 'commentary', text: '調査を進めています。' } },
  ] }];
  await state(page, value);
  const progress = page.locator('.turn-progress');
  await expect(progress.locator(':scope > summary')).toHaveText('作業中');
  await expect(progress).toHaveAttribute('open');
  await expect(page.getByText('調査を進めています。')).toBeVisible();
  value.turns[0]!.items.push({ id: 'command', kind: 'commandExecution', data: { command: 'npm test', status: 'inProgress', aggregatedOutput: '32 tests passed' } });
  await state(page, value);
  const command = progress.locator('details[data-item="command"]');
  await expect(command.locator(':scope > summary')).toBeVisible();
  await command.locator(':scope > summary').click();
  value.turns[0]!.items.push({ id: 'final', kind: 'agentMessage', data: { phase: 'final_answer', text: '調査結果です。' } });
  await state(page, value);
  await expect(page.getByText('調査結果です。')).toBeVisible();
  await expect(progress).toHaveAttribute('open');
  await expect(page.getByText('32 tests passed')).toBeVisible();
  value.status = 'idle'; value.activeTurnId = undefined;
  value.turns[0]!.status = 'completed'; value.turns[0]!.completedAt = 1_061_000;
  await state(page, value);
  await expect(progress.locator(':scope > summary')).toHaveText('1m 1s作業しました');
  await expect(progress).not.toHaveAttribute('open');
  await expect(page.getByText('調査を進めています。')).toBeHidden();
  await expect(page.getByText('32 tests passed')).toBeHidden();
  await expect(page.getByText('調査結果です。')).toBeVisible();
  await progress.locator(':scope > summary').click();
  value.turns[0]!.items.at(-1)!.data.text = '調査結果をまとめました。';
  await state(page, value);
  await expect(progress).toHaveAttribute('open');
  await expect(page.getByText('32 tests passed')).toBeVisible();
  await expect(page.getByText('調査結果をまとめました。')).toBeVisible();
});

test('manual progress toggles survive streaming and every live group collapses only for the finished turn', async ({ page }) => {
  const value = task(); value.status = 'running'; value.activeTurnId = 'live';
  value.turns = [{ id: 'previous', status: 'completed', items: [
    { id: 'commentary', kind: 'agentMessage', data: { phase: 'commentary', text: '前の作業の途中経過です。' } },
  ] }, { id: 'live', status: 'inProgress', items: [
    { id: 'commentary', kind: 'agentMessage', data: { phase: 'commentary', text: '調査を進めています。' } },
  ] }];
  await state(page, value);
  const previous = page.locator('.turn[data-turn="previous"] .turn-progress');
  const progress = page.locator('.turn[data-turn="live"] .turn-progress');
  await previous.locator(':scope > summary').click();
  await progress.locator(':scope > summary').click();
  value.turns[1]!.items[0]!.data.text = '調査を続けています。';
  await state(page, value);
  await expect(previous).toHaveAttribute('open');
  await expect(progress).not.toHaveAttribute('open');
  await expect(page.getByText('調査を続けています。')).toBeHidden();
  value.turns[1]!.items.push(
    { id: 'steer', kind: 'userMessage', data: { content: [{ type: 'text', text: 'テストも確認して' }] } },
    { id: 'command', kind: 'commandExecution', data: { command: 'npm test', status: 'inProgress' } },
  );
  await state(page, value);
  await expect(progress).toHaveCount(2);
  await expect(progress.first()).not.toHaveAttribute('open');
  await expect(progress.last()).toHaveAttribute('open');
  await expect(page.getByText('テストも確認して', { exact: true })).toBeVisible();
  await expect(page.getByText('実行中 · npm test', { exact: true })).toBeVisible();
  await progress.first().locator(':scope > summary').click();
  value.status = 'idle'; value.activeTurnId = undefined;
  value.turns[1]!.status = 'completed';
  await state(page, value);
  await expect(progress.first()).not.toHaveAttribute('open');
  await expect(progress.last()).not.toHaveAttribute('open');
  await expect(previous).toHaveAttribute('open');
});

test('nullable reply phases and steering preserve the final answer and user message order', async ({ page }) => {
  const value = task();
  value.turns = [{ id: 'steered', status: 'completed', items: [
    { id: 'user', kind: 'userMessage', data: { content: [{ type: 'text', text: '表示を修正して' }] } },
    { id: 'commentary', kind: 'agentMessage', data: { phase: null, text: '表示を確認します。' } },
    { id: 'steer', kind: 'userMessage', data: { content: [{ type: 'text', text: '矢印も合わせて' }] } },
    { id: 'command', kind: 'commandExecution', data: { command: 'npm test', status: 'completed' } },
    { id: 'final', kind: 'agentMessage', data: { phase: null, text: '矢印も合わせました。' } },
  ] }, { id: 'answer-only', status: 'completed', items: [
    { id: 'reasoning', kind: 'reasoning', data: { summary: [], content: [] } },
    { id: 'answer', kind: 'agentMessage', data: { phase: 'final_answer', text: '確認しました。' } },
  ] }];
  await state(page, value);
  await expect(page.locator('.turn[data-turn="steered"] > *')).toHaveText(['表示を修正して', '途中経過表示を確認します。', '矢印も合わせて', '作業しましたコマンド · npm test', '矢印も合わせました。']);
  await expect(page.getByText('表示を確認します。', { exact: true })).toBeHidden();
  await expect(page.getByText('矢印も合わせて', { exact: true })).toBeVisible();
  await expect(page.getByText('矢印も合わせました。', { exact: true })).toBeVisible();
  await expect(page.locator('.turn[data-turn="answer-only"] details')).toHaveCount(0);
  value.turns[0]!.startedAt = Date.UTC(2026, 8, 9, 4, 29);
  await state(page, value);
  await expect(page.locator('[data-message-id="user"] time')).toHaveCount(1);
  await expect(page.locator('[data-message-id="steer"] time')).toHaveCount(0);
});

test('upstream retry diagnostics stay visible without blocking input and clear when the model responds', async ({ page }, info) => {
  const gateway = new FakeGateway();
  const manager = new TaskManager(gateway, { async save() {} }, [], { schedule: false });
  const value = thread(); gateway.threads.set(value.id, value);
  const current = manager.adoptThread(value);
  try {
    await manager.send(current.id, '応答を確認して');
    const turnId = current.activeTurnId!;
    const error = { message: 'Reconnecting... 1/5\nstream disconnected; request ID fixture-request <img src=x>' };
    gateway.events.emit({ type: 'error', threadId: value.id, turnId, error, willRetry: true });
    await state(page, current);
    await expect(page.locator('#status')).toHaveText('再試行中');
    await expect(page.locator('#notice')).toBeVisible();
    await expect(page.locator('#notice-text')).toHaveText(`Codexが再試行しています。\n${error.message}`);
    await expect(page.locator('#notice img')).toHaveCount(0);
    await expect(page.locator('#stop')).toBeVisible();
    await expect(page.locator('#stop')).toBeEnabled();
    await page.locator('#prompt').fill('途中で入力したメモ');
    await expect(page.locator('#send')).toBeEnabled();
    await expect(page.locator('#send')).toHaveText('追加入力');
    await page.screenshot({ path: info.outputPath('stream-retry.png') });
    gateway.events.emit({ type: 'tokens', threadId: value.id, value: {} });
    await state(page, current);
    await expect(page.locator('#notice')).toBeVisible();
    gateway.events.emit({ type: 'delta', threadId: value.id, turnId, itemId: 'answer', kind: 'agentMessage', field: 'text', text: '回答を再開しました。' });
    await state(page, current);
    await expect(page.locator('#notice')).toBeHidden();
    await expect(page.locator('#status')).toHaveText('実行中');
    await expect(page.locator('#prompt')).toHaveValue('途中で入力したメモ');
    const fatal = { message: 'Retries exhausted\nrequest ID fixture-request' };
    gateway.events.emit({ type: 'error', threadId: value.id, turnId, error: fatal, willRetry: false });
    await state(page, current);
    await expect(page.locator('#notice-text')).toHaveText(fatal.message);
    gateway.events.emit({ type: 'turn', threadId: value.id, turn: { id: turnId, status: 'failed', items: [], error: fatal }, completed: true });
    await state(page, current);
    await expect(page.locator('#notice-text')).toHaveText(fatal.message);
    await expect(page.locator('#status')).toHaveText('エラー');
    await expect(page.locator('#stop')).toBeHidden();
    expect(gateway.sent).toHaveLength(1);
  } finally { manager.dispose(); }
});

test('streaming, quota wait and questions preserve unsent answers across updates', async ({ page }, info) => {
  const value = task(); value.autoResume = true; value.status = 'waiting'; value.recoveryAt = Date.now() + 600_000;
  value.claims = [{ stoppedTurnId: 'old-stop', clientId: 'automatic-client', turnId: 'turn-1' }];
  value.turns = [{ id: 'turn-1', status: 'failed', error: { kind: 'usageLimitExceeded', message: '使用量の上限に達しました。' }, items: [
    { id: 'user-1', kind: 'userMessage', data: { content: [{ type: 'text', text: '作業を続けてください。' }] } },
    { id: 'agent-1', kind: 'agentMessage', data: { text: '通信層を追加しました。\n\n- 要求IDで応答を照合\n- 未対応の要求にはエラーを返却\n\n```ts\nawait client.startThread(cwd);\n```' } },
    { id: 'command-1', kind: 'commandExecution', data: { command: 'npm test', status: 'completed', aggregatedOutput: '32 tests passed', exitCode: 0 } },
  ] }];
  await state(page, value);
  await expect(page.getByText('自動送信 · 使用量回復後の継続')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('回復予定');
  await expect(page.locator('.turn-error')).toBeVisible();
  await page.locator('.turn-progress > summary').click();
  await page.getByText('コマンド · npm test').click();
  await expect(page.getByText('32 tests passed')).toBeVisible();
  await page.screenshot({ path: info.outputPath('usage-wait.png') });
  value.status = 'input'; value.requests = [{ id: 'number:11', threadId: 'thread-1', turnId: 'turn-1', kind: 'questions', title: 'Codexからの質問', detail: '', choices: [], blocking: true, questions: [{ id: 'direction', header: '実装方針', question: '対象範囲を指定してください。', secret: false, options: [{ label: 'すべて', description: '全体に適用します。' }] }] }];
  await state(page, value);
  await page.getByLabel('自由入力').fill('まず接続層を進めてください。');
  value.turns[0]!.items[1]!.data.text = '新しいストリーム通知';
  await state(page, value);
  await expect(page.getByLabel('自由入力')).toHaveValue('まず接続層を進めてください。');
  await page.getByRole('button', { name: '回答を送信', exact: true }).click();
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'answer', requestId: 'number:11', answer: { answers: { direction: ['まず接続層を進めてください。'] } } });
});

test('async message questions show selectable cards after completion and submit one answer', async ({ page }, info) => {
  const value = task(); value.status = 'input';
  value.requests = [{ id: 'message:question', threadId: 'thread-1', turnId: 'turn-1', kind: 'questions', source: 'agentMessage', title: '質問', detail: '', choices: [], blocking: false,
    questions: [{ id: '0', header: '', question: 'AかBどちらにしますか？', secret: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }] }];
  await state(page, value);
  const send = page.getByRole('button', { name: '回答を送信', exact: true });
  await expect(send).toBeDisabled();
  await expect(page.locator('#stop')).toBeHidden();
  await expect(page.locator('#send')).toHaveText('送信');
  await expect(page.locator('#model')).toBeEnabled();
  await page.getByLabel('メッセージ', { exact: true }).fill('入力中の作業指示');
  await page.locator('.answer-label').filter({ hasText: /^B$/ }).click();
  await expect(page.getByRole('radio', { name: 'B', exact: true })).toBeChecked();
  await expect(send).toBeEnabled();
  await page.screenshot({ path: info.outputPath('question-card.png') });
  await send.click();
  await expect(send).toBeDisabled();
  await page.locator('.question-card').evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect((await messages(page)).filter(message => message.type === 'answer')).toEqual([{ type: 'answer', requestId: 'message:question', answer: { answers: { '0': ['B'] } } }]);
  await expect(page.getByLabel('メッセージ', { exact: true })).toHaveValue('入力中の作業指示');
  await receive(page, { type: 'failure', requestId: 'message:question' });
  await expect(send).toBeEnabled();
  await expect(page.getByRole('radio', { name: 'B', exact: true })).toBeChecked();
  await send.click();
  const text = questionAnswerText(value.requests[0]!, { answers: { '0': ['B'] } });
  value.requests = []; value.status = 'running'; value.activeTurnId = 'next';
  value.turns = [{ id: 'next', status: 'inProgress', items: [{ id: 'answer', kind: 'userMessage', data: { content: [{ type: 'text', text }] } }] }];
  await state(page, value);
  await expect(page.locator('#requests')).toBeHidden();
  const answer = page.locator('.message.user');
  await expect(answer.locator('blockquote')).toHaveText('AかBどちらにしますか？');
  await expect(answer.locator('blockquote')).toHaveCSS('border-left-style', 'solid');
  await expect(answer.locator('.user-text')).toHaveText('B');
  await page.screenshot({ path: info.outputPath('question-answer.png') });
  await page.reload(); await state(page, value);
  await expect(answer.locator('blockquote')).toHaveText('AかBどちらにしますか？');
  await expect(answer.locator('.user-text')).toHaveText('B');
});

test('multiple questions require answers and freely switch between options and text', async ({ page }) => {
  const value = task(); value.status = 'input';
  value.requests = [{ id: 'number:12', threadId: 'thread-1', kind: 'questions', title: '質問', detail: '', choices: [], blocking: true, questions: [
    { id: 'direction', header: '方針', question: '実装方針を選んでください。', secret: false, options: [{ label: 'A', description: '推奨の方針' }, { label: 'B', description: '' }, { label: 'C', description: '' }] },
    { id: 'notes', header: '補足', question: '補足を入力してください。', secret: false, options: [] },
    { id: 'secret', header: '秘密', question: '秘密の回答', secret: true, options: [] },
  ] }];
  await state(page, value);
  const questions = page.locator('.question');
  const send = page.getByRole('button', { name: '回答を送信', exact: true });
  await questions.nth(0).getByRole('radio', { name: 'B', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(send).toBeDisabled();
  await questions.nth(0).getByLabel('自由入力').fill('独自案');
  await expect(questions.nth(0).locator('input[type=radio]:checked')).toHaveCount(0);
  await questions.nth(0).getByRole('radio', { name: 'C', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(questions.nth(0).getByLabel('自由入力')).toHaveValue('');
  await questions.nth(1).getByLabel('自由入力').fill('補足です');
  await expect(send).toBeDisabled();
  await questions.nth(2).getByLabel('自由入力').fill('秘密です');
  await expect(questions.nth(2).getByLabel('自由入力')).toHaveAttribute('type', 'password');
  await expect(send).toBeEnabled();
  await questions.nth(1).getByLabel('自由入力').press('Enter');
  expect((await messages(page)).filter(message => message.type === 'answer')).toEqual([{ type: 'answer', requestId: 'number:12', answer: { answers: { direction: ['C'], notes: ['補足です'], secret: ['秘密です'] } } }]);
});

test('request additions and removals preserve the other card draft, selection, and focus', async ({ page }) => {
  const value = task(); value.status = 'input';
  const first = { id: 'number:21', threadId: 'thread-1', kind: 'questions' as const, title: '質問', detail: '', choices: [], blocking: true, questions: [
    { id: 'direction', header: '方針', question: '方針は？', secret: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] },
    { id: 'notes', header: '補足', question: '補足は？', secret: false, options: [] },
  ] };
  value.requests = [first]; await state(page, value);
  const card = page.locator('form[data-request="number:21"]');
  await card.getByText('A', { exact: true }).click();
  await card.getByLabel('自由入力').nth(1).fill('入力中の回答');
  value.requests.push({ ...first, id: 'number:22' }); await state(page, value);
  await expect(card.getByLabel('自由入力').nth(1)).toHaveValue('入力中の回答');
  await expect(card.getByLabel('自由入力').nth(1)).toBeFocused();
  value.requests.pop(); await state(page, value);
  await expect(card.getByLabel('自由入力').nth(1)).toHaveValue('入力中の回答');
  await expect(card.getByRole('radio', { name: 'A', exact: true })).toBeChecked();
  await expect(card.getByLabel('自由入力').nth(1)).toBeFocused();
});

test('skip and close dismiss unanswered questions explicitly and stay disabled when disconnected', async ({ page }) => {
  const value = task(); value.status = 'input';
  const request = { id: 'number:31', threadId: 'thread-1', kind: 'questions' as const, title: '質問', detail: '', choices: [], blocking: true,
    questions: [{ id: 'answer', header: '', question: '回答は？', secret: false, options: [] }] };
  value.requests = [request]; await state(page, value);
  await page.getByRole('button', { name: 'スキップ', exact: true }).click();
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'answer', requestId: 'number:31', answer: { skip: true } });
  value.requests = [{ ...request, id: 'number:32' }]; await state(page, value);
  await page.getByRole('button', { name: '質問をスキップ', exact: true }).click();
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'answer', requestId: 'number:32', answer: { skip: true } });
  value.requests = [{ ...request, id: 'number:33' }]; await state(page, value, undefined, false);
  await expect(page.getByRole('button', { name: 'スキップ', exact: true })).toBeDisabled();
  await expect(page.getByLabel('自由入力')).toBeDisabled();
});

test('question cards escape model text and fit split views with long options', async ({ page }, info) => {
  await page.setViewportSize({ width: 380, height: 800 });
  const value = task(); value.status = 'input';
  value.requests = [{ id: 'number:41', threadId: 'thread-1', kind: 'questions', title: '質問', detail: '', choices: [], blocking: true,
    questions: [{ id: 'question', header: '', question: '<img src=x onerror="alert(1)">', secret: false, options: [{ label: 'very-long-option-'.repeat(15), description: '説明'.repeat(30) }] }] }];
  await state(page, value);
  await expect(page.locator('.question-card img')).toHaveCount(0);
  await expect(page.locator('.question-title')).toHaveText('<img src=x onerror="alert(1)">');
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(380);
  expect(await page.locator('#requests').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.getByRole('button', { name: 'スキップ', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'スキップ', exact: true })).toBeInViewport();
  await page.screenshot({ path: info.outputPath('question-split-view.png') });
});

test('MCP requests can be declined without filling required fields; split views have no horizontal overflow', async ({ page }, info) => {
  await page.setViewportSize({ width: 380, height: 800 });
  const value = task(); value.status = 'approval'; value.requests = [{ id: 'number:2', threadId: 'thread-1', kind: 'elicitation', title: 'MCP: service', detail: '入力を確認してください。', blocking: true, choices: ['回答を送信', '拒否', 'キャンセル'], schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', title: 'メール' } } } }];
  await state(page, value);
  await page.getByRole('button', { name: '拒否', exact: true }).click();
  expect((await messages(page)).at(-1)).toMatchObject({ type: 'answer', answer: { choice: 1 } });
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(380);
  await page.screenshot({ path: info.outputPath('split-view.png') });
});

test('selection menu lists questions in order, preserves the selected text, and dispatches only once', async ({ page }, info) => {
  await page.setViewportSize({ width: 340, height: 500 });
  const value = task();
  value.turns = [{ id: 'answer', status: 'completed', items: [{ id: 'reply', kind: 'agentMessage', data: { text: '選択する説明です。' } }] }];
  const questions = [{ id: 'example', name: '具体例で' }, { id: 'simple', name: 'かみ砕いて' }];
  await state(page, value, undefined, true, 1, questions);
  await page.locator('#prompt').fill('元の下書き');
  await page.locator('.assistant .markdown p').selectText();
  await openSelectionMenu(page, '.assistant .markdown p');
  await expect(page.getByRole('menuitem')).toHaveText(['コピー', 'Codex-Deckで言及', '具体例で', 'かみ砕いて']);
  await expect(page.getByRole('menuitem', { name: '質問プリセットを設定' })).toHaveCount(0);
  // Selection may disappear while the menu has keyboard focus; actions still use the snapshot.
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.getByRole('menuitem', { name: '具体例で' }).evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
  const actions = (await messages(page)).filter(message => message.type === 'selectionAction');
  expect(actions).toHaveLength(1);
  expect(actions[0]).toMatchObject({ action: 'question', questionPresetId: 'example', text: '選択する説明です。' });
  await expect(page.locator('#prompt')).toHaveValue('元の下書き');
  expect((await messages(page)).some(message => message.type === 'send')).toBe(false);
  await receive(page, { type: 'selectionResult', requestId: actions[0]!.requestId });
  await state(page, value, undefined, true, 1, [...questions].reverse());
  await page.locator('.assistant .markdown p').selectText();
  await page.locator('.assistant .markdown p').dispatchEvent('contextmenu', { clientX: 339, clientY: 499 });
  await expect(page.getByRole('menuitem')).toHaveText(['コピー', 'Codex-Deckで言及', 'かみ砕いて', '具体例で']);
  const box = await page.getByRole('menu').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(340); expect(box!.y + box!.height).toBeLessThanOrEqual(500);
  await page.screenshot({ path: info.outputPath('question-selection-menu.png'), fullPage: true });
  await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toBeHidden();
  await page.locator('.assistant .markdown p').selectText();
  await page.locator('#conversation').focus();
  await page.keyboard.press('Shift+F10'); await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: '具体例で' })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('menuitem', { name: 'かみ砕いて' })).toBeFocused();
  await page.keyboard.press('Enter');
  expect((await messages(page)).filter(message => message.type === 'selectionAction').at(-1)).toMatchObject({ action: 'question', questionPresetId: 'simple' });
});

test('selection copy preserves code and a failed action allows another attempt', async ({ page }) => {
  const value = task();
  value.turns = [{ id: 'answer', status: 'completed', items: [{ id: 'reply', kind: 'agentMessage', data: { text: '```ts\n  const x = 1;\n\n  run(x);\n```' } }] }];
  await state(page, value);
  const code = page.locator('.assistant .markdown code');
  await code.selectText(); await openSelectionMenu(page, '.assistant .markdown code');
  await page.getByRole('menuitem', { name: 'コピー', exact: true }).click();
  const request = (await messages(page)).findLast(message => message.type === 'selectionAction')!;
  expect(request).toMatchObject({ action: 'copy', text: '  const x = 1;\n\n  run(x);' });
  value.error = '処理に失敗しました';
  await state(page, value); await receive(page, { type: 'selectionResult', requestId: request.requestId });
  await code.selectText(); await openSelectionMenu(page, '.assistant .markdown code');
  await expect(page.getByRole('menuitem', { name: 'コピー', exact: true })).toBeEnabled();
  await page.locator('#prompt').click(); await expect(page.getByRole('menu')).toBeHidden();
});

for (const outcome of ['sent', 'failure', 'unknown'] as const) test(`an initial question sends once and preserves the existing ${outcome} recovery behavior`, async ({ page }) => {
  const value = task(); value.threadId = undefined;
  await state(page, value);
  const initial = { type: 'initialQuestion', sendId: `initial-${outcome}`, text: '質問: 解説してください\n\n> 参照元: 会話「元の会話」\n>\n> 選択文\n\n元の会話: codex://threads/source' };
  await receive(page, initial); await receive(page, initial);
  expect((await messages(page)).filter(message => message.type === 'send')).toHaveLength(1);
  expect((await messages(page)).findLast(message => message.type === 'send')).toMatchObject({ sendId: initial.sendId, text: initial.text, attachmentIds: [], skillPaths: [] });
  await expect(page.locator('.pending-send .user-quote')).toContainText('選択文');
  if (outcome !== 'unknown') await receive(page, { type: outcome, sendId: initial.sendId, text: initial.text });
  await page.reload(); await state(page, value); await receive(page, initial);
  expect((await messages(page)).filter(message => message.type === 'send')).toEqual([]);
  if (outcome === 'failure') {
    await expect(page.locator('#prompt')).toHaveValue(initial.text);
    await page.locator('#prompt').press('Enter');
    expect((await messages(page)).findLast(message => message.type === 'send')).toMatchObject({ text: initial.text });
  } else {
    await expect(page.locator('#prompt')).toHaveValue('');
    await expect(page.locator('.pending-send')).toHaveCount(1);
  }
});
