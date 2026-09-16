import type { QuestionPresetMenuItem } from '../core/questionPresets';

export function selectedTranscriptText(transcript: HTMLElement): string | undefined {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  if (!transcript.contains(selection.getRangeAt(0).commonAncestorContainer)) return;
  const text = selection.toString();
  return text.trim() ? text : undefined;
}

export class SelectionMenu {
  private readonly menu = document.createElement('div');
  private previousFocus?: HTMLElement;
  private pending?: string;
  private signature = '';
  constructor(private readonly transcript: HTMLElement,
    private readonly state: () => { taskId?: string; hasThread: boolean; presets: QuestionPresetMenuItem[] },
    private readonly post: (type: string, data: Record<string, unknown>) => void,
    private readonly onClose: () => void) {
    this.menu.id = 'selection-menu';
    this.menu.setAttribute('role', 'menu');
    this.menu.setAttribute('aria-label', '選択した文章の操作');
    this.menu.hidden = true;
    document.body.append(this.menu);
    document.addEventListener('contextmenu', event => {
      if (!(event.target instanceof Node) || !transcript.contains(event.target)) { this.close(false); return; }
      const text = selectedTranscriptText(transcript);
      if (!text || !this.state().taskId) return;
      event.preventDefault(); event.stopPropagation();
      const rect = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
      this.open(text, event.clientX || rect?.left || 8, event.clientY || rect?.bottom || 8);
    }, true);
    document.addEventListener('keydown', event => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      const text = selectedTranscriptText(transcript);
      if (!text || !this.state().taskId || this.opened) return;
      event.preventDefault(); event.stopPropagation();
      const rect = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
      this.open(text, rect.left, rect.bottom);
    });
    // Keep the transcript selection intact when clicking a menu item.
    this.menu.addEventListener('mousedown', event => event.preventDefault());
    this.menu.addEventListener('keydown', event => {
      const buttons = [...this.menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      let next: number | undefined;
      if (event.key === 'ArrowDown') next = (index + 1) % buttons.length;
      if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = buttons.length - 1;
      if (next !== undefined) { event.preventDefault(); event.stopPropagation(); buttons[next]?.focus(); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); }
      if (event.key === 'Tab') this.close();
    });
    document.addEventListener('pointerdown', event => { if (!this.menu.contains(event.target as Node)) this.close(false); }, true);
    document.addEventListener('scroll', event => { if (!this.menu.contains(event.target as Node)) this.close(false); }, true);
    window.addEventListener('blur', () => this.close(false));
    window.addEventListener('resize', () => this.close(false));
  }
  get opened(): boolean { return !this.menu.hidden; }
  refresh(): void {
    const signature = JSON.stringify(this.state());
    if (signature !== this.signature) { this.signature = signature; this.close(false); }
  }
  finished(requestId: string): void { if (this.pending === requestId) this.pending = undefined; }
  private open(text: string, x: number, y: number): void {
    if (!this.opened) this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const state = this.state();
    this.menu.replaceChildren();
    const add = (label: string, action: string, questionPresetId?: string): void => {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = label; button.setAttribute('role', 'menuitem'); button.tabIndex = -1;
      button.disabled = !!this.pending || action === 'question' && !state.hasThread;
      button.addEventListener('click', () => {
        if (this.pending || !this.opened) return;
        const requestId = crypto.randomUUID();
        this.pending = requestId;
        this.close(false);
        this.post('selectionAction', { action, text, requestId, ...(questionPresetId !== undefined ? { questionPresetId } : {}) });
      });
      this.menu.append(button);
    };
    add('コピー', 'copy'); add('Codex-Deckで言及', 'mention');
    if (state.presets.length) {
      const separator = document.createElement('div'); separator.setAttribute('role', 'separator'); this.menu.append(separator);
      for (const preset of state.presets) add(preset.name || '（名前未設定）', 'question', preset.id);
    }
    this.menu.hidden = false;
    const rect = this.menu.getBoundingClientRect();
    this.menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    this.menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    this.menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }
  private close(restoreFocus = true): void {
    if (!this.opened) return;
    this.menu.hidden = true;
    if (restoreFocus && this.previousFocus?.isConnected) this.previousFocus.focus({ preventScroll: true });
    this.onClose();
  }
}
