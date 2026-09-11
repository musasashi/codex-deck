import type { ResponsesModel, ResponsesProvider } from '../core/providers';

const newModel = (): ResponsesModel => ({ id: '', images: false, reasoningEfforts: [], structuredOutput: false });

export class ProviderEditor {
  value: ResponsesProvider[] = [];
  constructor(private readonly root: HTMLElement, private readonly changed: () => void) {}
  load(providers: ResponsesProvider[]): void { this.value = providers; this.render(); }
  add(): void {
    let n = 1; while (this.value.some(p => p.id === `provider${n}`)) n++;
    this.value.push({ id: `provider${n}`, name: '', baseUrl: '', apiKeyEnv: '', models: [newModel()] });
    this.render(); this.changed();
    this.root.lastElementChild?.querySelector<HTMLInputElement>('input')?.focus();
  }
  private text(parent: HTMLElement, id: string, label: string, value: string, update: (value: string) => void, placeholder = ''): void {
    const caption = document.createElement('label'); caption.htmlFor = id; caption.textContent = label;
    const input = document.createElement('input'); input.id = id; input.value = value; input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false; input.placeholder = placeholder;
    input.addEventListener('input', () => { update(input.value); this.changed(); });
    parent.append(caption, input);
  }
  private button(parent: HTMLElement, label: string, action: () => void): void {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = label;
    button.addEventListener('click', () => { action(); this.render(); this.changed(); }); parent.append(button);
  }
  private toggle(parent: HTMLElement, label: string, value: boolean, update: (value: boolean) => void): void {
    const caption = document.createElement('label'); caption.className = 'capability';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = value;
    input.addEventListener('change', () => { update(input.checked); this.changed(); });
    caption.append(input, document.createTextNode(label)); parent.append(caption);
  }
  private render(): void {
    this.root.replaceChildren(...this.value.map((p, index) => {
      const card = document.createElement('section'); card.className = 'provider-card'; card.setAttribute('aria-label', `接続先${index + 1}`);
      const header = document.createElement('div'); header.className = 'preset-header';
      const title = document.createElement('h2'); title.textContent = `接続先${index + 1}`; header.append(title);
      this.button(header, `接続先${index + 1}を削除`, () => this.value.splice(index, 1)); card.append(header);
      this.text(card, `provider-name-${index}`, '接続先の表示名', p.name, value => { p.name = value; }, 'DeepSeek / OpenRouter / Ollama');
      this.text(card, `provider-id-${index}`, '接続先ID', p.id, value => { p.id = value; }, 'deepseek');
      this.text(card, `provider-url-${index}`, 'Base URL', p.baseUrl, value => { p.baseUrl = value; }, 'https://api.example.com/v1');
      this.text(card, `provider-key-${index}`, 'APIキーの環境変数名（認証不要なら空欄）', p.apiKeyEnv, value => { p.apiKeyEnv = value; }, 'DEEPSEEK_API_KEY');
      const modelList = document.createElement('div');
      p.models.forEach((m, mi) => {
        const row = document.createElement('section'); row.className = 'provider-model'; row.setAttribute('aria-label', `接続先${index + 1}のモデル${mi + 1}`);
        this.text(row, `provider-model-${index}-${mi}`, 'APIのモデルID', m.id, value => { m.id = value; });
        this.text(row, `provider-efforts-${index}-${mi}`, '対応する推論強度（カンマ区切り・任意）', m.reasoningEfforts.join(', '), value => { m.reasoningEfforts = value.split(',').map(s => s.trim()).filter(Boolean); }, 'low, medium, high');
        this.toggle(row, '画像入力', m.images, value => { m.images = value; });
        this.toggle(row, '構造化出力（JSON Schema）', m.structuredOutput, value => { m.structuredOutput = value; });
        this.button(row, `モデル${mi + 1}を削除`, () => p.models.splice(mi, 1)); modelList.append(row);
      });
      card.append(modelList); this.button(card, 'モデルを追加', () => p.models.push(newModel()));
      return card;
    }));
  }
}
