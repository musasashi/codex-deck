import { completionQuery, fileMention, hasSkillMention, insertCompletion, slashCommands, type CompletionQuery } from '../core/composer';
import { array, string, type ComposerCatalog, type FileReference, type JsonObject, type Skill, type Task } from '../core/types';

interface Candidate { label: string; description: string; value: string; skill?: Skill; command?: string }

export class Composer {
  catalog?: ComposerCatalog;
  private cwd = '';
  private connected = false;
  private empty = true;
  private sequence = 0;
  private catalogRequest?: number;
  private catalogError = '';
  private fileRequest?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private query?: CompletionQuery;
  private queryKey = '';
  private dismissedKey = '';
  private candidates: Candidate[] = [];
  private selected = 0;
  private loading = false;
  private error = '';
  private selectedSkills = new Map<string, Skill>();
  private restoredPaths: string[];

  constructor(
    private readonly prompt: HTMLTextAreaElement,
    private readonly popup: HTMLElement,
    private readonly skills: HTMLElement,
    private readonly post: (type: string, data?: Record<string, unknown>) => void,
    private readonly changed: () => void,
    private readonly catalogChanged: () => void,
    restoredPaths: string[],
  ) {
    this.restoredPaths = restoredPaths;
    prompt.addEventListener('input', () => this.refresh());
    prompt.addEventListener('click', () => this.refresh());
    prompt.addEventListener('focus', () => this.refresh());
    prompt.addEventListener('keyup', event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) this.refresh();
    });
    document.addEventListener('selectionchange', () => { if (document.activeElement === prompt) this.refresh(); });
    document.addEventListener('pointerdown', event => {
      if (!popup.contains(event.target as Node) && event.target !== prompt) this.dismiss();
    });
    popup.addEventListener('mousedown', event => event.preventDefault());
    popup.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-candidate]');
      if (button) this.accept(Number(button.dataset.candidate), true);
    });
  }

  setContext(task: Task, connected: boolean, hasPendingMessage = false): void {
    const changed = this.cwd !== task.cwd || this.connected !== connected;
    if (this.cwd && this.cwd !== task.cwd) { this.selectedSkills.clear(); this.restoredPaths = []; }
    this.cwd = task.cwd; this.connected = connected;
    this.empty = !hasPendingMessage && !task.turns.some(turn => turn.items.length);
    if (changed) this.invalidate();
    this.renderSkills();
  }

  private requestCatalog(): void {
    if (!this.connected || this.catalogRequest !== undefined) return;
    this.catalogRequest = ++this.sequence;
    this.post('composerCatalog', { requestId: this.catalogRequest });
  }

  private invalidate(): void {
    this.catalog = undefined; this.catalogError = ''; this.catalogRequest = undefined;
    this.close(); this.queryKey = '';
    this.renderSkills(); this.catalogChanged(); this.requestCatalog();
  }

  handleMessage(message: JsonObject): void {
    if (message.type === 'catalogInvalidated') this.invalidate();
    else if (message.type === 'composerCatalog' && this.catalogRequest !== undefined && message.requestId === this.catalogRequest) {
      this.catalogRequest = undefined;
      this.catalogError = string(message.error);
      this.catalog = { skills: array(message.skills) as Skill[], permissionMode: message.permissionMode as ComposerCatalog['permissionMode'] };
      for (const skill of this.catalog.skills) if (this.restoredPaths.includes(skill.path)) this.selectedSkills.set(skill.path, skill);
      this.restoredPaths = [];
      this.renderSkills(); this.catalogChanged();
      if (this.query?.kind === 'skill') this.refresh(true);
    } else if (message.type === 'fileSearch' && this.fileRequest !== undefined && message.requestId === this.fileRequest) {
      this.fileRequest = undefined; this.loading = false; this.error = string(message.error);
      this.candidates = (array(message.files) as FileReference[]).map(file => {
        const path = file.path + (file.kind === 'directory' && !/[\\/]$/.test(file.path) ? '/' : '');
        return { label: path, description: '', value: fileMention(path) };
      });
      this.renderPopup();
    } else if (message.type === 'insertSkill') this.insertSkill(message.skill as Skill);
    else if (message.type === 'insertMention') this.insertMarker('@');
  }

  private renderSkills(): void {
    const available = [...(this.catalog?.skills ?? [])].sort((a, b) => Number(b.scope === 'user') - Number(a.scope === 'user'));
    this.skills.hidden = !this.empty || available.length === 0;
    const signature = JSON.stringify(available);
    if (this.skills.dataset.skills === signature) return;
    this.skills.dataset.skills = signature;
    this.skills.replaceChildren(...available.map(skill => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'skill'; button.title = skill.path;
      const name = document.createElement('span'); name.textContent = `$${skill.name}`;
      const description = document.createElement('small'); description.textContent = skill.description;
      button.append(name, description);
      button.addEventListener('click', () => this.insertSkill(skill));
      return button;
    }));
  }

  skillPaths(): string[] {
    return [...this.selectedSkills.values()].filter(skill => hasSkillMention(this.prompt.value, skill.name)).map(skill => skill.path);
  }

  private rememberSkill(skill: Skill): void {
    for (const [path, selected] of this.selectedSkills) if (selected.name === skill.name) this.selectedSkills.delete(path);
    this.selectedSkills.set(skill.path, skill);
  }

  private replace(range: { start: number; end: number }, value: string): void {
    const result = insertCompletion(this.prompt.value, range, value);
    this.prompt.value = result.text;
    this.prompt.setSelectionRange(result.caret, result.caret);
    this.close(); this.prompt.focus(); this.changed(); this.refresh();
  }

  private insertSkill(skill: Skill): void {
    if (!skill?.name || !skill.path) return;
    this.rememberSkill(skill);
    const query = completionQuery(this.prompt.value, this.prompt.selectionStart, this.prompt.selectionEnd);
    const range = query?.kind === 'skill' ? query : { start: this.prompt.selectionStart, end: this.prompt.selectionEnd };
    const prefix = range.start && !/[\s([{]$/.test(this.prompt.value.slice(0, range.start)) ? ' ' : '';
    this.replace(range, `${prefix}$${skill.name}`);
  }

  private insertMarker(marker: '@' | '$', replaceCommand = false): void {
    const start = replaceCommand ? 0 : this.prompt.selectionStart;
    const end = replaceCommand ? this.prompt.value.length : this.prompt.selectionEnd;
    const prefix = start && !/[\s([{]$/.test(this.prompt.value.slice(0, start)) ? ' ' : '';
    this.prompt.value = this.prompt.value.slice(0, start) + prefix + marker + this.prompt.value.slice(end);
    this.prompt.setSelectionRange(start + prefix.length + 1, start + prefix.length + 1);
    this.close(); this.prompt.focus(); this.changed(); this.refresh(true);
    if (marker === '$' && this.catalogError) this.requestCatalog();
  }

  /** These commands open an input picker, so they never become a model prompt. */
  beforeSubmit(): boolean {
    const text = this.prompt.value.trim();
    if (text === '/skills' || text === '/mention') { this.insertMarker(text === '/skills' ? '$' : '@', true); return true; }
    if (text === '/') { this.refresh(true); return true; }
    return false;
  }

  submitted(): void { this.dismiss(); }
  sent(text: unknown): void {
    if (this.prompt.value === text) { this.prompt.value = ''; this.selectedSkills.clear(); this.restoredPaths = []; }
    this.dismiss();
  }
  restore(text: string, skillPaths: string[]): void {
    this.prompt.value = text;
    this.restoredPaths = skillPaths;
    for (const skill of this.catalog?.skills ?? []) if (skillPaths.includes(skill.path)) this.rememberSkill(skill);
    this.dismiss();
  }

  keydown(event: KeyboardEvent): boolean {
    if (event.isComposing || event.keyCode === 229) return true;
    if (this.popup.hidden || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
    if (event.key === 'Escape') { event.preventDefault(); this.dismiss(); return true; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (this.candidates.length) this.selected = (this.selected + (event.key === 'ArrowDown' ? 1 : -1) + this.candidates.length) % this.candidates.length;
      this.renderPopup(); return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      // Loading, failed and empty lookups also consume Enter to prevent accidental sends.
      event.preventDefault();
      if (this.candidates.length) this.accept(this.selected, event.key === 'Enter');
      return true;
    }
    return false;
  }

  private accept(index: number, execute: boolean): void {
    const candidate = this.candidates[index], query = this.query;
    if (!candidate || !query) return;
    if (candidate.skill) this.rememberSkill(candidate.skill);
    this.replace(query, candidate.value);
    if (execute && candidate.command) (this.prompt.form as HTMLFormElement).requestSubmit();
  }

  private close(): void {
    clearTimeout(this.timer); this.fileRequest = undefined; this.query = undefined;
    this.candidates = []; this.popup.hidden = true;
    this.prompt.setAttribute('aria-expanded', 'false'); this.prompt.removeAttribute('aria-activedescendant');
  }
  private dismiss(): void {
    this.dismissedKey = this.key(); this.close();
  }
  private key(): string { return JSON.stringify([this.prompt.value, this.prompt.selectionStart, this.prompt.selectionEnd]); }

  private refresh(force = false): void {
    const key = this.key();
    if (key !== this.dismissedKey) this.dismissedKey = '';
    if (!force && (key === this.queryKey || key === this.dismissedKey)) return;
    this.close(); this.queryKey = key;
    this.query = completionQuery(this.prompt.value, this.prompt.selectionStart, this.prompt.selectionEnd);
    if (!this.query) return;
    this.selected = 0; this.loading = false; this.error = '';
    const { kind, query } = this.query;
    const filter = query.toLocaleLowerCase();
    if (kind === 'command') this.candidates = slashCommands.filter(command => command.name.startsWith(filter))
      .map(command => ({ label: `/${command.name}`, description: command.description, value: `/${command.name}`, command: command.name }));
    else if (kind === 'skill') {
      this.candidates = (this.catalog?.skills ?? []).filter(skill => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(filter))
        .map(skill => ({ label: `$${skill.name}`, description: skill.description, value: `$${skill.name}`, skill }));
      this.loading = !this.catalog && this.connected;
      this.error = this.catalogError || (!this.connected ? 'App Serverに未接続です。' : '');
    } else {
      this.loading = this.connected;
      if (!this.connected) this.error = 'App Serverに未接続です。';
      else if (query.length > 1000) { this.loading = false; this.error = '検索するパスが長すぎます。'; }
      else {
        const requestId = ++this.sequence;
        this.fileRequest = requestId;
        this.timer = setTimeout(() => this.post('fileSearch', { requestId, query }), 100);
      }
    }
    this.renderPopup();
  }

  private renderPopup(): void {
    if (!this.query) return;
    this.popup.hidden = false;
    this.prompt.setAttribute('aria-expanded', 'true');
    this.popup.replaceChildren();
    const list = document.createElement('div'); list.id = 'completion-list'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', '入力候補');
    for (const [index, candidate] of this.candidates.entries()) {
      const button = document.createElement('button');
      button.type = 'button'; button.tabIndex = -1; button.id = `completion-${index}`; button.dataset.candidate = String(index);
      button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === this.selected));
      const label = document.createElement('span'); label.textContent = candidate.label;
      const description = document.createElement('small'); description.textContent = candidate.description;
      button.append(label, description); list.append(button);
    }
    const hint = document.createElement('div'); hint.className = 'completion-hint'; hint.setAttribute('role', 'status');
    hint.textContent = this.error || (this.loading ? '検索中…' : this.candidates.length ? '↑↓ 選択 · Enter 確定 · Tab 挿入 · Esc 閉じる' : this.query.kind === 'file' && !this.query.query ? 'ファイル名を入力してください。' : '候補がありません。');
    this.popup.append(list, hint);
    if (this.candidates.length) {
      this.prompt.setAttribute('aria-activedescendant', `completion-${this.selected}`);
      list.children[this.selected]?.scrollIntoView({ block: 'nearest' });
    } else this.prompt.removeAttribute('aria-activedescendant');
  }
}
