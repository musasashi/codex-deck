import { array, object, string, type PendingRequest, type RequestAnswer } from '../core/types';
import { escapeHtml } from './render';

function requestHtml(request: PendingRequest): string {
  const header = `<h2>${escapeHtml(request.title)}</h2>${request.detail ? `<pre class="request-detail">${escapeHtml(request.detail)}</pre>` : ''}`;
  if (request.kind === 'questions') return `<form class="question-card" data-request="${escapeHtml(request.id)}">
    <div class="question-heading">${header}<button type="button" class="icon-button" data-skip aria-label="質問をスキップ" title="スキップ">×</button></div>
    ${(request.questions ?? []).map((question, index) => `<fieldset class="question"><legend${question.header ? '' : ' class="sr-only"'}>${escapeHtml(question.header || `質問 ${index + 1}`)}</legend>
      <p class="question-title">${escapeHtml(question.question)}</p>
      ${question.options.map((option, optionIndex) => `<label class="answer-option"><input class="sr-only" type="radio" name="option:${escapeHtml(question.id)}" value="${escapeHtml(option.label)}"><span class="answer-number" aria-hidden="true">${optionIndex + 1}</span><span class="answer-label">${escapeHtml(option.label)}${option.description ? `<small>${escapeHtml(option.description)}</small>` : ''}</span></label>`).join('')}
      <label class="question-free-answer"><span class="sr-only">自由入力</span><span class="answer-number" aria-hidden="true">✎</span><input type="${question.secret ? 'password' : 'text'}" data-answer="${escapeHtml(question.id)}" placeholder="${question.options.length ? 'または自分で回答を入力' : '回答を入力'}" autocomplete="off"></label>
    </fieldset>`).join('')}
    <div class="request-actions question-actions"><button type="button" data-skip class="secondary">スキップ</button><button type="submit" aria-label="回答を送信" disabled>送信</button></div>
  </form>`;
  const properties = object(request.schema?.properties);
  const required = array(request.schema?.required);
  const fields = request.kind === 'elicitation' && !request.url ? Object.entries(properties).map(([key, raw]) => {
    const schema = object(raw);
    const label = string(schema.title, key);
    const options = array(schema.enum);
    const attrs = `data-field="${escapeHtml(key)}" data-field-type="${escapeHtml(string(schema.type))}" ${required.includes(key) ? 'required' : ''}`;
    const input = options.length ? `<select ${attrs}><option value="">選択してください</option>${options.map(v => `<option value="${escapeHtml(JSON.stringify(v))}">${escapeHtml(String(v))}</option>`).join('')}</select>`
      : schema.type === 'boolean' ? `<select ${attrs}><option value="">選択してください</option><option value="true">はい</option><option value="false">いいえ</option></select>`
      : schema.type === 'object' || schema.type === 'array' ? `<textarea ${attrs} placeholder="JSON"></textarea>`
      : `<input ${attrs} type="${schema.type === 'number' || schema.type === 'integer' ? 'number' : 'text'}" ${schema.type === 'integer' ? 'step="1"' : schema.type === 'number' ? 'step="any"' : ''}>`;
    return `<label class="free-answer">${escapeHtml(label)}${input}</label>`;
  }).join('') : '';
  return `<form data-request="${escapeHtml(request.id)}">${header}${request.url ? `<p><button type="button" class="inline-link" data-link="${escapeHtml(request.url)}">${escapeHtml(request.url)}</button></p>` : fields}<div class="request-actions">${request.choices.map((label, index) => `<button type="submit" data-choice="${index}" ${index ? 'formnovalidate' : ''} class="${index ? 'secondary' : ''}">${escapeHtml(label)}</button>`).join('')}</div></form>`;
}

function answersFrom(form: HTMLFormElement): Record<string, string[]> {
  const answers: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const input of form.querySelectorAll<HTMLInputElement>('[data-answer]')) {
    const radio = input.closest('fieldset')?.querySelector<HTMLInputElement>('input[type=radio]:checked');
    answers[input.dataset.answer!] = [input.value.trim() || radio?.value || ''];
  }
  return answers;
}

export class Requests {
  private forms = new Map<string, { form: HTMLFormElement; signature: string; request: PendingRequest }>();
  private submitting = new Set<string>();
  private disabled = false;

  constructor(private readonly container: HTMLElement, private readonly post: (type: string, data?: Record<string, unknown>) => void) {
    container.addEventListener('submit', event => {
      event.preventDefault();
      const choice = (event as SubmitEvent).submitter?.dataset.choice;
      this.submit(event.target as HTMLFormElement, false, choice === undefined ? undefined : Number(choice));
    });
    container.addEventListener('click', event => {
      const skip = (event.target as HTMLElement).closest<HTMLElement>('[data-skip]');
      if (skip) this.submit(skip.closest('form')!, true);
    });
    container.addEventListener('input', event => {
      const input = event.target as HTMLInputElement;
      if (input.matches('[data-answer]')) {
        for (const radio of input.closest('fieldset')!.querySelectorAll<HTMLInputElement>('input[type=radio]')) radio.checked = false;
      } else if (input.type === 'radio') {
        input.closest('fieldset')!.querySelector<HTMLInputElement>('[data-answer]')!.value = '';
      }
      const form = input.closest('form');
      if (form) this.update(form);
    });
    container.addEventListener('keydown', event => {
      if (event.key === 'Enter' && event.isComposing) event.preventDefault();
    });
  }

  render(requests: PendingRequest[], busy: boolean, connected: boolean): void {
    this.disabled = busy || !connected;
    const ids = new Set(requests.map(request => request.id));
    for (const [id, { form }] of this.forms) {
      if (!ids.has(id)) { form.remove(); this.forms.delete(id); this.submitting.delete(id); }
    }
    for (const [index, request] of requests.entries()) {
      const signature = JSON.stringify(request);
      let entry = this.forms.get(request.id);
      if (!entry || entry.signature !== signature) {
        const template = document.createElement('template');
        template.innerHTML = requestHtml(request);
        const form = template.content.firstElementChild as HTMLFormElement;
        entry?.form.replaceWith(form);
        entry = { form, signature, request };
        this.forms.set(request.id, entry);
      }
      const current = this.container.children[index];
      if (current !== entry.form) this.container.insertBefore(entry.form, current ?? null);
      this.update(entry.form);
    }
    this.container.hidden = !requests.length;
  }

  failed(requestId: string): void {
    this.submitting.delete(requestId);
    const entry = this.forms.get(requestId);
    if (entry) this.update(entry.form);
  }

  private update(form: HTMLFormElement): void {
    const disabled = this.disabled || this.submitting.has(form.dataset.request!);
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement | HTMLSelectElement>('input, button, textarea, select')) control.disabled = disabled;
    if (form.classList.contains('question-card')) {
      const answers = Object.values(answersFrom(form));
      form.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled = disabled || !answers.length || answers.some(values => !values[0]);
    }
  }

  private submit(form: HTMLFormElement, skip: boolean, choice?: number): void {
    const id = form.dataset.request!;
    const entry = this.forms.get(id);
    if (!entry || this.disabled || this.submitting.has(id)) return;
    const request = entry.request;
    let answer: RequestAnswer;
    if (request.kind === 'questions') {
      const answers = answersFrom(form);
      if (!skip && (!Object.keys(answers).length || Object.values(answers).some(values => !values[0]))) return;
      answer = skip ? { skip: true } : { answers };
    } else {
      const content: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      try {
        for (const input of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-field]')) {
          if (request.kind === 'elicitation' && choice !== 0) break;
          if (!input.value) continue;
          content[input.dataset.field!] = input.tagName === 'SELECT' || ['number', 'integer', 'boolean', 'object', 'array'].includes(input.dataset.fieldType ?? '') ? JSON.parse(input.value) : input.value;
        }
      } catch { this.post('invalidJson'); return; }
      answer = { choice, content: request.url ? null : content };
    }
    this.submitting.add(id);
    this.update(form);
    this.post('answer', { requestId: id, answer });
  }
}
