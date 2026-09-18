import { Marked } from 'marked';
import { array, object, string, type Attachment, type Item, type Task, type Turn } from '../core/types';
import { isImageDataUrl } from '../core/attachments';
import { taskReferenceBody } from '../core/taskReferenceText';
import { mathExtensions } from './math';

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const copyIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><g class="copy-icon"><rect x="2" y="5" width="9" height="9" rx="2"/><path d="M5 5V4a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-1"/></g><path class="copied-icon" d="m3 8 3 3 7-7"/></svg>';
const markdown = new Marked({ breaks: true, gfm: true, extensions: mathExtensions });
markdown.use({ renderer: {
  html({ text }) { return escapeHtml(text); },
  link({ href, tokens }) { return `<button class="inline-link" data-link="${escapeHtml(href)}">${this.parser.parseInline(tokens)}</button>`; },
  image({ href, text }) { return `<button class="inline-link" data-link="${escapeHtml(href)}">画像: ${escapeHtml(text || '開く')}</button>`; },
  code({ text, lang }) {
    const language = (lang ?? '').match(/^\S+/)?.[0];
    return `<div class="code-block"><pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(text)}</code></pre><button type="button" class="code-copy" data-code-action="copy" aria-label="コードをコピー" title="コードをコピー">${copyIcon}</button></div>`;
  },
} });
export function renderMarkdown(text: string): string { return markdown.parse(text, { async: false }); }
function renderUserText(text: string): string {
  const tokens = markdown.lexer(text);
  if (!tokens.some(token => token.type === 'blockquote')) return `<div class="user-text">${escapeHtml(text)}</div>`;
  const blocks: { quote: boolean; text: string }[] = [];
  for (const token of tokens) {
    const quote = token.type === 'blockquote';
    const previous = blocks.at(-1);
    if (!quote && previous && !previous.quote) previous.text += token.raw;
    else blocks.push({ quote, text: quote ? token.text : token.raw });
  }
  return blocks.map(block => {
    const content = escapeHtml(block.text.replace(/^\n+|\n+$/g, ''));
    if (!content) return '';
    return block.quote ? `<blockquote class="user-quote">${content}</blockquote>` : `<div class="user-text">${content}</div>`;
  }).join('');
}
export function renderAttachments(attachments: Attachment[]): string {
  return attachments.map(({ id, label, input }) => {
    const preview = input.type === 'image' && isImageDataUrl(input.url);
    return `<span class="attachment${preview ? ' attachment-image' : ''}" role="listitem" title="${escapeHtml(label)}">${preview ? `<img src="${escapeHtml(input.url!)}" alt="${escapeHtml(label)}">` : escapeHtml(label)}<button type="button" data-remove="${escapeHtml(id)}" aria-label="${escapeHtml(label)}を削除" title="添付を削除">×</button></span>`;
  }).join('');
}
function detail(title: string, content: string, id: string): string { return `<details data-item="${escapeHtml(id)}"><summary>${escapeHtml(title)}</summary>${content}</details>`; }
const pre = (value: string): string => `<pre><code>${escapeHtml(value)}</code></pre>`;
interface MessageOptions { timestamp?: number; canFork: boolean }
const messageTime = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const messageWeekday = new Intl.DateTimeFormat('ja-JP', { weekday: 'long' });
function message(item: Item, content: string, options?: MessageOptions, references = ''): string {
  const user = item.kind === 'userMessage';
  let footer = '';
  if (options) {
    const date = options.timestamp === undefined ? undefined : new Date(options.timestamp);
    const time = date && Number.isFinite(date.getTime()) ? `<time datetime="${date.toISOString()}" title="${escapeHtml(date.toLocaleString('ja-JP'))}">${messageTime.format(date)} (${messageWeekday.format(date)})</time>` : '';
    const copy = `<button type="button" class="message-action" data-message-action="copy" aria-label="メッセージをコピー" title="メッセージをコピー">${copyIcon}</button>`;
    const fork = user ? '' : `<button type="button" class="message-action" data-message-action="fork" aria-label="新しいチャットに分岐" title="新しいチャットに分岐"${options.canFork ? '' : ' disabled'}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8h3c3 0 3-4.5 6-4.5h2m-3-2.5 3 2.5-3 2.5M5 8c3 0 3 4.5 6 4.5h2m-3-2.5 3 2.5-3 2.5"/></svg></button>`;
    const actions = `<div class="message-actions">${copy}${fork}</div>`;
    footer = `<div class="message-footer">${user ? time + actions : actions + time}</div>`;
  }
  return `<article class="message ${user ? 'user' : 'assistant'}" data-message-id="${escapeHtml(item.id)}">${user ? `<div class="user-bubble">${content}</div>` : content}${references}${footer}</article>`;
}
export function renderItem(item: Item, automatic: boolean, options?: MessageOptions): string {
  const d = item.data;
  switch (item.kind) {
    case 'userMessage': {
      const references: string[] = [];
      const content = array(d.content).map((value, index) => {
        const input = object(value);
        // The first input is the user's original text, even if it contains our markers.
        const reference = index > 0 && input.type === 'text' ? taskReferenceBody(string(input.text)) : undefined;
        if (reference !== undefined) { references.push(reference); return ''; }
        if (input.type === 'image' && isImageDataUrl(input.url)) return `<img class="user-image" src="${escapeHtml(input.url)}" alt="添付画像" loading="lazy">`;
        return input.type === 'text' ? renderUserText(string(input.text)) : `<span class="input-tag">${escapeHtml(input.type === 'skill' ? `$${string(input.name)}` : string(input.path) || '画像')}</span>`;
      }).join('');
      const context = references.length ? `<details class="message-references" data-item="${escapeHtml(`references:${item.id}`)}"><summary>参照情報 · ${references.length}件（Codex Deckが自動追加）</summary>${references.map(text => `<div class="reference-text">${escapeHtml(text)}</div>`).join('')}</details>` : '';
      return message(item, `${automatic ? '<span class="automatic">自動送信 · 使用量回復後の継続</span>' : ''}${content}`, options, context);
    }
    case 'agentMessage': case 'plan': return message(item, `${item.kind === 'plan' ? '<div class="message-label">PLAN</div>' : ''}<div class="markdown">${renderMarkdown(string(d.text))}</div>`, options);
    case 'reasoning': return '';
    case 'commandExecution': return detail(`${string(d.status) === 'inProgress' ? '実行中' : 'コマンド'} · ${string(d.command)}`, pre(string(d.aggregatedOutput)) + (typeof d.exitCode === 'number' ? `<small>終了コード: ${d.exitCode}</small>` : ''), item.id);
    case 'fileChange': return detail('ファイルの変更', array(d.changes).map(v => { const change = object(v); return `<p>${escapeHtml(string(change.path))}</p>${pre(string(change.diff))}`; }).join(''), item.id);
    case 'mcpToolCall': case 'dynamicToolCall': return detail(`${string(d.server)} ${string(d.tool)} · ${string(d.status)}`.trim(), pre(JSON.stringify({ arguments: d.arguments, result: d.result ?? d.contentItems, error: d.error }, null, 2)), item.id);
    case 'webSearch': return detail(`Web検索 · ${string(d.query)}`, pre(JSON.stringify(d.action ?? {}, null, 2)), item.id);
    case 'enteredReviewMode': return `<p class="activity">レビュー開始 · ${escapeHtml(string(d.review))}</p>`;
    case 'exitedReviewMode': return message(item, `<div class="message-label">REVIEW</div><div class="markdown">${renderMarkdown(string(d.review))}</div>`, options);
    case 'contextCompaction': return '<p class="activity">会話を圧縮しました</p>';
    case 'imageView': return detail('画像を確認', `<button class="inline-link" data-link="${escapeHtml(string(d.path))}">${escapeHtml(string(d.path))}</button>`, item.id);
    default: return detail(item.kind, pre(JSON.stringify(d, null, 2)), item.id);
  }
}
export function renderTranscript(task: Task): string {
  return task.turns.map(turn => {
    let labeled = false;
    const firstInput = turn.items.find(item => item.kind === 'userMessage');
    const lastReply = turn.items.findLast(item => ['agentMessage', 'plan', 'exitedReviewMode'].includes(item.kind));
    // phase is nullable; only promote an unclassified reply once the turn succeeds.
    const finalReply = turn.status === 'completed' && lastReply?.kind === 'agentMessage' && lastReply.data.phase == null ? lastReply : undefined;
    const blocks: { html: string; progressId?: string }[] = [];
    let progress: typeof blocks[number] | undefined;
    for (const item of turn.items) {
      const auto = item.kind === 'userMessage' && !labeled && task.claims.some(claim => claim.turnId === turn.id || claim.clientId === item.data.clientId);
      if (auto) labeled = true;
      const html = renderItem(item, auto, {
        timestamp: item === firstInput ? turn.startedAt : item === lastReply ? turn.completedAt : undefined,
        canFork: !!task.threadId && turn.status !== 'inProgress' && task.activeTurnId !== turn.id,
      });
      if (!html) continue;
      const visible = item.kind === 'userMessage' || item.kind === 'plan' || item.kind === 'exitedReviewMode'
        || item.kind === 'agentMessage' && (item.data.phase === 'final_answer' || item === finalReply);
      if (visible) {
        progress = undefined;
        blocks.push({ html });
      } else {
        if (!progress) { progress = { html: '', progressId: `progress:${item.id}` }; blocks.push(progress); }
        progress.html += html;
      }
    }
    const lastProgress = blocks.findLast(block => block.progressId);
    const content = blocks.map(block => block.progressId
      ? `<details class="turn-progress" data-item="${escapeHtml(block.progressId)}"${turn.status === 'inProgress' ? ' open' : ''}><summary>${block === lastProgress ? progressLabel(turn) : '途中経過'}</summary><div class="progress-content">${block.html}</div></details>`
      : block.html).join('');
    return `<section class="turn" data-turn="${escapeHtml(turn.id)}" data-status="${escapeHtml(turn.status)}">${content}${turn.error ? `<p class="turn-error">${escapeHtml(turn.error.message)}</p>` : ''}</section>`;
  }).join('');
}

function progressLabel(turn: Turn): string {
  if (turn.status === 'inProgress') return '作業中';
  const duration = turn.durationMs ?? (turn.startedAt !== undefined && turn.completedAt !== undefined ? turn.completedAt - turn.startedAt : undefined);
  if (duration === undefined || !Number.isFinite(duration) || duration < 0) return '作業しました';
  const seconds = Math.floor(duration / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return `${hours ? `${hours}h ` : ''}${minutes ? `${minutes % 60}m ` : ''}${seconds % 60}s作業しました`;
}
