import { array, object, string, statusLabel, isTaskRunning, type Attachment, type Model, type Task, type Usage } from '../core/types';
import { escapeHtml, renderAttachments, renderItem, renderTranscript } from './render';
import { IMAGE_FORMAT_ERROR, IMAGE_TYPES, MAX_ATTACHMENT_BYTES } from '../core/attachments';
import { parseSlashCommand, permissionOptions } from '../core/composer';
import { latestModel } from '../core/settings';
import { Composer } from './composer';
import { UsageGauges } from './usage';
import { Requests } from './requests';
import { pendingSubmission, reconcilePendingSends, submissionContent, type PendingSend, type Submission } from './submissions';

declare function acquireVsCodeApi(): { postMessage(value: unknown): void; setState(value: unknown): void; getState(): unknown };
const vscode = acquireVsCodeApi();
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const post = (type: string, data: Record<string, unknown> = {}): void => vscode.postMessage({ type, ...data });
let task: Task | undefined;
let connected = false;
let usage: Usage | undefined;
let models: Model[] = [];
let presetCount = 0;
let transcriptHtml = '';
let copiedMessage: string | undefined;
let copyTimer: ReturnType<typeof setTimeout> | undefined;
let attachmentsHtml = '';
let enterBehavior = 'modEnter';
let sending: Submission | undefined;
let pendingSends: PendingSend[] = [];
let pasteSequence = 0;
const pendingPastes = new Set<number>();
let imageError = '';
let draftTimer: ReturnType<typeof setTimeout> | undefined;
let initialFocus = true;
const prompt = $<HTMLTextAreaElement>('prompt');
const saved = object(vscode.getState());
prompt.value = string(saved.draft);
for (const savedSend of array(saved.pendingSends).map(object)) {
  if (typeof savedSend.id !== 'string' || typeof savedSend.text !== 'string') continue;
  pendingSends.push({ id: savedSend.id, text: savedSend.text, skillPaths: array(savedSend.skillPaths).filter((value): value is string => typeof value === 'string'),
    attachments: array(savedSend.attachments) as Attachment[], optimistic: true,
    state: savedSend.state === 'sent' || savedSend.state === 'failed' ? savedSend.state : 'unknown',
    turnId: typeof savedSend.turnId === 'string' ? savedSend.turnId : undefined,
    seenUserMessageIds: array(savedSend.seenUserMessageIds).filter((value): value is string => typeof value === 'string') });
}
const completion = new Composer(prompt, $('completions'), $('skills'), post, saveDraft, renderPermissions, array(saved.skillPaths).filter((value): value is string => typeof value === 'string'));
const usageGauges = new UsageGauges($('usage-gauges'));
const requests = new Requests($('requests'), post);

function saveDraft(): void {
  if (task) vscode.setState({ taskId: task.id, draft: prompt.value, skillPaths: completion.skillPaths(), pendingSends });
}
function updateSendButton(): void {
  $<HTMLButtonElement>('send').disabled = !!sending || !!task?.busy || pendingPastes.size > 0;
}
function draftAttachments(): Attachment[] {
  const submitted = [...pendingSends.flatMap(submission => submission.attachments), ...(sending?.optimistic ? sending.attachments : [])];
  return (task?.attachments ?? []).filter(attachment => !submitted.some(sent => sent.id === attachment.id));
}
function updateAttachments(): void {
  const attachments = draftAttachments();
  const html = renderAttachments(attachments);
  if (html !== attachmentsHtml) { $('attachments').innerHTML = html; attachmentsHtml = html; }
  $('attachments').hidden = !attachments.length;
}
function updateImageStatus(): void {
  const status = $('image-status');
  status.textContent = imageError || (pendingPastes.size ? '画像を読み込み中…' : '');
  status.hidden = !status.textContent;
  status.className = imageError ? 'error-notice' : '';
  updateSendButton();
}
async function pasteImages(files: File[]): Promise<void> {
  imageError = '';
  if (files.some(file => !IMAGE_TYPES.has(file.type) || !file.size || file.size > MAX_ATTACHMENT_BYTES)) {
    imageError = IMAGE_FORMAT_ERROR; updateImageStatus(); return;
  }
  const requestId = ++pasteSequence;
  pendingPastes.add(requestId); updateImageStatus();
  try {
    const urls = await Promise.all(files.map(file => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject();
      reader.onerror = reader.onabort = () => reject();
      reader.readAsDataURL(file);
    })));
    post('pasteImages', { requestId, urls });
  } catch {
    pendingPastes.delete(requestId);
    imageError = '画像を読み込めませんでした。もう一度貼り付けてください。';
    updateImageStatus();
  }
}
prompt.addEventListener('input', () => {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 200);
});

function options(select: HTMLSelectElement, values: { id: string; label: string }[], selected: string): void {
  const signature = JSON.stringify(values);
  if (select.dataset.options !== signature) {
    select.replaceChildren(...values.map(value => {
      const option = new Option(value.label, value.id);
      option.hidden = value.id === '';
      return option;
    }));
    select.dataset.options = signature;
  }
  if (selected && !values.some(value => value.id === selected)) select.add(new Option(selected, selected));
  select.value = selected;
}
function renderPermissions(): void {
  if (!task) return;
  const values = permissionOptions(task.settings.mode, task.effectivePermissionMode ?? completion.catalog?.permissionMode);
  if (!completion.catalog && !task.effectivePermissionMode && task.settings.mode === 'default') values[0]!.label = 'Permissions';
  options($<HTMLSelectElement>('mode'), values, task.settings.mode);
}
function detailKey(details: HTMLDetailsElement): string {
  return JSON.stringify([details.closest<HTMLElement>('.turn')?.dataset.turn, details.dataset.item]);
}
function messageActionKey(button: HTMLElement): string {
  return JSON.stringify([button.closest<HTMLElement>('.turn')?.dataset.turn, button.closest<HTMLElement>('.message')?.dataset.messageId, button.dataset.messageAction]);
}
function renderCopyFeedback(): void {
  for (const button of $('transcript').querySelectorAll<HTMLElement>('[data-message-action="copy"]')) {
    const copied = messageActionKey(button) === copiedMessage;
    button.toggleAttribute('data-copied', copied);
    button.title = copied ? 'コピーしました' : 'メッセージをコピー';
    button.setAttribute('aria-label', button.title);
  }
}
function renderPendingSend(submission: PendingSend): string {
  if (!task) return '';
  const { id, state } = submission;
  const content = submissionContent(submission);
  const message = renderItem({ id, kind: 'userMessage', data: { content } }, false);
  const retry = state === 'failed' || state === 'unknown';
  const status = retry ? `${state === 'unknown' ? '送信結果を確認できませんでした。' : '送信できませんでした。'}<button type="button" class="secondary" data-retry-send="${escapeHtml(id)}"${sending || task.busy || isTaskRunning(task) || state === 'unknown' && !task.hydrated ? ' disabled' : ''}>再送</button>` : state === 'sending' ? '送信中…' : '送信済み';
  return `<section class="turn pending-send" data-send="${escapeHtml(id)}">${message}<div class="pending-status" role="status">${status}</div></section>`;
}
function render(): void {
  if (!task) return;
  pendingSends = reconcilePendingSends(pendingSends, task);
  completion.setContext(task, connected, pendingSends.length > 0);
  const busy = !!sending || task.busy;
  usageGauges.render(connected ? usage : undefined);
  $('status').textContent = busy ? '送信中' : statusLabel[task.status];
  $('status-dot').className = `dot ${task.status}`;
  $<HTMLInputElement>('auto-resume').checked = task.autoResume;
  const notice = $('notice');
  const waiting = task.status === 'waiting';
  notice.textContent = waiting ? `使用量の回復を待っています。${task.recoveryAt ? ` 回復予定: ${new Date(task.recoveryAt).toLocaleString()}` : ''}` : task.error ?? (!connected ? 'App Serverに未接続です。メニューから再接続できます。' : '');
  notice.hidden = !notice.textContent;
  notice.className = waiting ? 'waiting-notice' : 'error-notice';
  const conversation = $('conversation');
  const atBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 80;
  const transcript = $('transcript');
  const html = renderTranscript(task) + pendingSends.map(renderPendingSend).join('');
  if (transcriptHtml !== html) {
    const detailStates = new Map([...transcript.querySelectorAll<HTMLDetailsElement>('details[data-item]')].map(details => [
      detailKey(details), { open: details.open, status: details.closest<HTMLElement>('.turn')?.dataset.status },
    ]));
    const activeDetails = document.activeElement?.matches('summary') && transcript.contains(document.activeElement) ? document.activeElement.parentElement as HTMLDetailsElement : undefined;
    const focused = activeDetails ? detailKey(activeDetails) : undefined;
    const activeAction = document.activeElement instanceof HTMLElement && document.activeElement.matches('[data-message-action]') && transcript.contains(document.activeElement) ? messageActionKey(document.activeElement) : undefined;
    transcript.innerHTML = html;
    transcriptHtml = html;
    for (const details of transcript.querySelectorAll<HTMLDetailsElement>('details[data-item]')) {
      const key = detailKey(details);
      const previous = detailStates.get(key);
      const status = details.closest<HTMLElement>('.turn')?.dataset.status;
      if (previous && (!details.classList.contains('turn-progress') || previous.status === status)) details.open = previous.open;
      if (focused === key) details.querySelector('summary')?.focus({ preventScroll: true });
    }
    if (activeAction) [...transcript.querySelectorAll<HTMLButtonElement>('[data-message-action]')].find(button => messageActionKey(button) === activeAction)?.focus({ preventScroll: true });
    renderCopyFeedback();
  }
  const plan = task.plan;
  $('plan').innerHTML = plan ? `<details class="plan"><summary>作業計画</summary><p>${escapeHtml(plan.explanation)}</p><ol>${plan.steps.map(step => `<li>${step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '◉' : '○'} ${escapeHtml(step.step)}</li>`).join('')}</ol></details>` : '';
  if (atBottom) conversation.scrollTop = conversation.scrollHeight;
  requests.render(task.requests, busy, connected);
  updateAttachments();
  const running = isTaskRunning(task);
  $('stop').hidden = !running && !waiting && !task.busy;
  const send = $<HTMLButtonElement>('send');
  updateSendButton();
  send.textContent = running ? '追加入力' : '送信';
  send.title = `${send.textContent} (${enterBehavior === 'modEnter' ? 'Ctrl+Enter / Cmd+Enter' : 'Enter'})`;
  const latest = latestModel(models);
  options($<HTMLSelectElement>('model'), [
    ...(task.settings.model === 'latest' ? [{ id: 'latest', label: latest ? `最新モデル (${latest.label})` : '最新モデル' }] : []),
    { id: '', label: task.effectiveModel || 'モデル' },
    ...models.map(model => ({ id: model.id, label: model.label })),
  ], task.settings.model ?? '');
  const model = task.settings.model === 'latest' ? latest : models.find(model => model.id === (task!.settings.model ?? task!.effectiveModel)) ?? models.find(model => model.isDefault);
  options($<HTMLSelectElement>('effort'), [
    { id: '', label: task.effectiveEffort || '推論の強さ' },
    ...(task.settings.effort === 'default' ? [{ id: 'default', label: model?.defaultEffort || 'モデルの既定値' }] : []),
    ...(model?.efforts ?? []).map(effort => ({ id: effort.id, label: effort.id })),
  ], task.settings.effort ?? '');
  renderPermissions();
  for (const id of ['model', 'effort', 'mode']) $<HTMLSelectElement>(id).disabled = running || busy;
  const cyclePreset = $<HTMLButtonElement>('cycle-preset');
  cyclePreset.disabled = running || busy || !presetCount || !models.length;
  cyclePreset.title = !presetCount ? '設定からプリセットを追加してください' : !models.length ? 'モデル一覧を読み込み中…' : '次のプリセットに切り替え';
  saveDraft();
}
window.addEventListener('message', event => {
  const message = object(event.data);
  if (message.type === 'state') {
    task = message.task as Task;
    models = message.models as Model[];
    presetCount = typeof message.presetCount === 'number' ? message.presetCount : 0;
    enterBehavior = string(message.enterBehavior, 'modEnter');
    connected = message.connected === true;
    usage = message.usage as Usage | undefined;
    render();
    if (initialFocus && !task.threadId) prompt.focus();
    initialFocus = false;
    const last = task.turns.at(-1);
    if (last?.status === 'completed' && last.id === task.unreadTurnId) post('read', { turnId: last.id });
  } else if (message.type === 'messageCopied') {
    copiedMessage = JSON.stringify([message.turnId, message.itemId, 'copy']);
    clearTimeout(copyTimer);
    renderCopyFeedback();
    copyTimer = setTimeout(() => { copiedMessage = undefined; renderCopyFeedback(); }, 1600);
  } else if (message.type === 'sent' && sending && sending.id === message.sendId) {
    if (!sending.optimistic) completion.sent(message.text);
    const pendingSend = pendingSends.find(submission => submission.id === message.sendId);
    if (pendingSend) pendingSend.state = 'sent';
    sending = undefined; render(); prompt.focus();
  } else if (message.type === 'failure') {
    if (typeof message.requestId === 'string') requests.failed(message.requestId);
    else if (sending && sending.id === message.sendId) {
      const pendingSend = pendingSends.find(submission => submission.id === message.sendId);
      if (pendingSend) {
        if (!prompt.value) { completion.restore(pendingSend.text, pendingSend.skillPaths); pendingSends = pendingSends.filter(submission => submission !== pendingSend); }
        else pendingSend.state = 'failed';
      }
      sending = undefined; render();
    }
  }
  else if (message.type === 'imagesPasted' && typeof message.requestId === 'number' && pendingPastes.delete(message.requestId)) {
    if (message.error) imageError = string(message.error);
    else if (task) { task.attachments = array(message.attachments) as Attachment[]; updateAttachments(); }
    updateImageStatus();
  }
  else completion.handleMessage(message);
});
function sendSubmission(submission: Submission, clearDraft: boolean, retryId?: string): void {
  sending = submission;
  if (submission.optimistic) {
    const pendingSend = pendingSubmission(submission, task!);
    const retryIndex = pendingSends.findIndex(submission => submission.id === retryId);
    if (retryIndex < 0) pendingSends.push(pendingSend);
    else pendingSends[retryIndex] = pendingSend;
    if (clearDraft) completion.sent(submission.text);
  }
  completion.submitted();
  render();
  const conversation = $('conversation');
  conversation.scrollTop = conversation.scrollHeight;
  prompt.focus();
  post('send', { sendId: submission.id, text: submission.text, skillPaths: submission.skillPaths, attachmentIds: submission.attachments.map(attachment => attachment.id) });
}
$('composer').addEventListener('submit', event => {
  event.preventDefault();
  if (!task || sending || task.busy || pendingPastes.size || (!prompt.value.trim() && !draftAttachments().length)) return;
  if (completion.beforeSubmit()) return;
  sendSubmission({ id: crypto.randomUUID(), text: prompt.value, skillPaths: completion.skillPaths(), attachments: draftAttachments(),
    optimistic: !parseSlashCommand(prompt.value) }, true);
});
prompt.addEventListener('keydown', event => {
  if (completion.keydown(event)) return;
  if (event.key !== 'Enter' || event.isComposing || event.shiftKey || event.altKey) return;
  if (enterBehavior === 'modEnter' && !event.ctrlKey && !event.metaKey) return;
  event.preventDefault(); $<HTMLFormElement>('composer').requestSubmit();
});
prompt.addEventListener('paste', event => {
  const data = event.clipboardData;
  const items = [...(data?.items ?? [])].filter(item => item.kind === 'file' && item.type.startsWith('image/'));
  const files = items.length ? items.map(item => item.getAsFile()).filter((file): file is File => !!file) : [...(data?.files ?? [])].filter(file => file.type.startsWith('image/'));
  if (!files.length) return;
  event.preventDefault();
  void pasteImages(files);
});
$('auto-resume').addEventListener('change', () => post('autoResume', { enabled: $<HTMLInputElement>('auto-resume').checked }));
for (const [id, type] of [['menu', 'menu'], ['attach', 'attach'], ['stop', 'stop']]) $(id!).addEventListener('click', () => post(type!));
$('cycle-preset').addEventListener('click', () => post('cyclePreset'));
for (const id of ['model', 'effort', 'mode']) $(id).addEventListener('change', () => post('settings', {
  model: $<HTMLSelectElement>('model').value, effort: id === 'model' ? '' : $<HTMLSelectElement>('effort').value, mode: $<HTMLSelectElement>('mode').value,
}));
document.addEventListener('click', event => {
  const target = (event.target as Element).closest<HTMLElement>('[data-link], [data-remove], [data-retry-send], [data-message-action]');
  if (!target) return;
  if (target.dataset.retrySend) {
    const pendingSend = pendingSends.find(submission => submission.id === target.dataset.retrySend);
    if (task && !sending && !task.busy && !isTaskRunning(task) && pendingSend && (pendingSend.state === 'failed' || pendingSend.state === 'unknown' && task.hydrated)) {
      sendSubmission({ ...pendingSend, id: crypto.randomUUID() }, false, pendingSend.id);
    }
  }
  else if (target.dataset.link) { event.preventDefault(); post('openLink', { url: target.dataset.link }); }
  else if (target.dataset.remove) { post('removeAttachment', { id: target.dataset.remove }); prompt.focus(); }
  else if (target.dataset.messageAction) {
    const turnId = target.closest<HTMLElement>('.turn')?.dataset.turn;
    const itemId = target.closest<HTMLElement>('.message')?.dataset.messageId;
    if (turnId && itemId) post(target.dataset.messageAction === 'copy' ? 'copyMessage' : 'forkMessage', { turnId, itemId });
  }
});
post('ready');
