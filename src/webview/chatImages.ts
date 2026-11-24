import { isImageDataUrl } from '../core/attachments';
import { array, object, string, type JsonObject } from '../core/types';

export class ChatImages {
  private cwd?: string;
  // Undefined marks an outstanding request. Store resource URIs, never the contents of local files.
  private readonly sources = new Map<string, string | undefined>();
  constructor(private readonly transcript: HTMLElement,
    private readonly post: (type: string, data: Record<string, unknown>) => void) {
    const conversation = transcript.closest('main')!;
    transcript.addEventListener('load', event => {
      const thumb = event.target;
      if (!(thumb instanceof HTMLImageElement) || !thumb.closest('[data-chat-image]')) return;
      const atBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 80;
      thumb.classList.add('loaded');
      if (atBottom) conversation.scrollTop = conversation.scrollHeight;
    }, true);
    transcript.addEventListener('error', event => {
      const thumb = event.target;
      if (!(thumb instanceof HTMLImageElement)) return;
      const button = thumb.closest<HTMLButtonElement>('[data-chat-image]');
      if (button) { thumb.hidden = true; button.title = '画像ファイルを開く'; }
    }, true);
    transcript.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-chat-image]');
      const thumb = button?.querySelector('img');
      if (!button || !thumb || (thumb.hidden && thumb.hasAttribute('src'))) return;
      const full = button.dataset.link!;
      const href = this.sources.get(full) === '' ? button.dataset.chatImage || full : full;
      if (this.sources.get(href) === '') return;
      event.stopPropagation();
      this.post('openChatImage', { href, label: button.textContent || '画像' });
    });
  }

  render(cwd: string): void {
    if (this.cwd !== cwd) { this.sources.clear(); this.cwd = cwd; }
    const links = new Set<string>();
    for (const button of this.transcript.querySelectorAll<HTMLButtonElement>('[data-chat-image]')) {
      const full = button.dataset.link!;
      for (const href of [full, button.dataset.chatImage || full]) {
        if (this.sources.has(href) && this.sources.get(href) !== '') continue;
        if (isImageDataUrl(href)) this.sources.set(href, href);
        else { this.sources.set(href, undefined); links.add(href); }
      }
    }
    this.showSources();
    if (links.size) this.post('resolveChatImages', { cwd, links: [...links] });
  }

  receive(message: JsonObject): void {
    if (message.cwd !== this.cwd) return;
    for (const value of array(message.sources)) {
      const { href, uri } = object(value);
      if (typeof href === 'string' && this.sources.has(href)) this.sources.set(href, string(uri));
    }
    this.showSources();
  }

  private showSources(): void {
    for (const button of this.transcript.querySelectorAll<HTMLButtonElement>('[data-chat-image]')) {
      const uri = this.sources.get(button.dataset.chatImage || button.dataset.link!) || this.sources.get(button.dataset.link!);
      const image = button.querySelector('img')!;
      if (uri && image.getAttribute('src') !== uri) {
        image.src = uri;
        image.hidden = false;
        button.title = '画像を拡大';
      }
    }
  }
}
