import type { Mermaid, MermaidConfig } from 'mermaid';

interface DiagramResult { svg?: string; failed?: boolean; pending?: Promise<void> }

export class Diagrams {
  private library?: Promise<Mermaid>;
  private readonly cache = new Map<string, DiagramResult>();
  private readonly applied = new WeakMap<HTMLElement, DiagramResult>();
  private queue = Promise.resolve();
  private sequence = 0;

  constructor(private readonly transcript: HTMLElement, private readonly conversation: HTMLElement,
    private readonly script: HTMLScriptElement, private readonly canUpdate: () => boolean) {
    const observer = new MutationObserver(() => this.render());
    for (const element of [document.documentElement, document.body]) {
      observer.observe(element, { attributes: true, attributeFilter: ['class', 'style'] });
    }
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.render());
  }

  render(followScroll = this.conversation.scrollHeight - this.conversation.scrollTop - this.conversation.clientHeight < 80): void {
    const styles = getComputedStyle(document.body);
    const rgb = styles.backgroundColor.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    const dark = document.body.classList.contains('vscode-light') ? false
      : document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast')
        || (rgb?.length === 3 ? rgb.reduce((sum, channel) => sum + channel, 0) < 384 : matchMedia('(prefers-color-scheme: dark)').matches);
    const theme = { theme: dark ? 'dark' : 'default', fontFamily: styles.fontFamily } satisfies MermaidConfig;
    const keys = new Set<string>();
    for (const block of this.transcript.querySelectorAll<HTMLElement>('.diagram-block')) {
      const source = block.querySelector('.diagram-source code')?.textContent ?? '';
      const message = block.closest<HTMLElement>('.message');
      const index = [...(message?.querySelectorAll('.diagram-block') ?? [])].indexOf(block);
      const key = JSON.stringify([block.closest<HTMLElement>('.turn')?.dataset.turn, message?.dataset.messageId, index, source, theme]);
      keys.add(key);
      let result = this.cache.get(key);
      if (!result) {
        result = {};
        this.cache.set(key, result);
        const entry = result;
        entry.pending = this.queue = this.queue.then(async () => {
          if (this.cache.get(key) !== entry) return;
          const container = document.createElement('div');
          container.className = 'diagram-render-target';
          container.setAttribute('aria-hidden', 'true');
          try {
            if (!source.trim() || source.length > 50_000) throw new Error('Invalid diagram size');
            const mermaid = await this.load();
            if (this.cache.get(key) !== entry) return;
            await document.fonts.ready;
            // Diagram directives cannot enable HTML labels, callbacks or change these settings.
            mermaid.initialize({
              ...theme, startOnLoad: false, securityLevel: 'strict', htmlLabels: false,
              suppressErrorRendering: true, maxTextSize: 50_000, maxEdges: 500,
              secure: ['secure', 'securityLevel', 'startOnLoad', 'htmlLabels', 'suppressErrorRendering',
                'maxTextSize', 'maxEdges', 'theme', 'themeCSS', 'themeVariables', 'fontFamily', 'dompurifyConfig'],
            });
            document.body.append(container);
            const { svg } = await mermaid.render(`codex-diagram-${++this.sequence}`, source, container);
            const template = document.createElement('template');
            template.innerHTML = svg;
            const diagram = template.content.querySelector('svg');
            if (!diagram) throw new Error('Missing diagram');
            // Some diagram types expose links even in strict mode. Keep their labels without navigation.
            for (const link of diagram.querySelectorAll('a')) link.replaceWith(...link.childNodes);
            const width = diagram.viewBox.baseVal.width;
            if (width > 0) diagram.style.width = `${width}px`;
            entry.svg = diagram.outerHTML;
          } catch {
            entry.failed = true;
          } finally {
            container.remove();
          }
        });
      }
      this.apply(block, key, result);
      const entry = result;
      void entry.pending?.then(() => this.apply(block, key, entry, followScroll));
    }
    // Keep completed diagrams across transcript updates, and discard superseded streaming content.
    for (const key of this.cache.keys()) if (!keys.has(key)) this.cache.delete(key);
  }

  private load(): Promise<Mermaid> {
    return this.library ??= new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('./mermaid.js', this.script.src).href;
      script.nonce = this.script.nonce;
      script.onload = () => {
        const mermaid = (window as unknown as { mermaid?: Mermaid }).mermaid;
        if (mermaid) { mermaid.startOnLoad = false; resolve(mermaid); }
        else reject(new Error('Mermaid is unavailable'));
      };
      script.onerror = () => reject(new Error('Could not load Mermaid'));
      document.head.append(script);
    });
  }

  private apply(block: HTMLElement, key: string, result: DiagramResult, followScroll = false): void {
    if (!block.isConnected || this.cache.get(key) !== result || this.applied.get(block) === result
      || !this.canUpdate() || !result.svg && !result.failed) return;
    const follow = followScroll && this.conversation.scrollHeight - this.conversation.scrollTop - this.conversation.clientHeight < 80;
    const diagram = block.querySelector<HTMLElement>('.diagram')!;
    const source = block.querySelector<HTMLDetailsElement>('.diagram-source')!;
    if (result.svg) {
      diagram.innerHTML = result.svg;
      diagram.hidden = false;
      block.querySelector<HTMLElement>('.diagram-error')!.hidden = true;
      if (!source.dataset.diagramRendered) source.open = false;
      source.dataset.diagramRendered = 'true';
    } else {
      diagram.hidden = true;
      block.querySelector<HTMLElement>('.diagram-error')!.hidden = false;
      source.open = true;
    }
    this.applied.set(block, result);
    if (follow) this.conversation.scrollTop = this.conversation.scrollHeight;
  }
}
