import { DEFAULT_PRESET, DEFAULT_TITLE_EFFORT, presetEffortOptions, presetPermissionOptions, latestModel, readPresets, readTitleEffort, readTitleModel, selectedModel, titleEffortOptions } from '../core/settings';
import { array, object, string, type ExecutionMode, type Model, type SettingsPreset } from '../core/types';

declare function acquireVsCodeApi(): { postMessage(value: unknown): void; setState(value: unknown): void; getState(): unknown };
const vscode = acquireVsCodeApi();
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const scope = $<HTMLSelectElement>('scope');
const titleModel = $<HTMLSelectElement>('title-model');
const titleEffort = $<HTMLSelectElement>('title-effort');
let models: Model[] = [];
let presets: SettingsPreset[] = [];
let requestId = 0;
let ready = false;
let busy = false;
let dirty = false;

function status(message: string, error = false): void {
  $('status').textContent = message;
  $('status').className = error ? 'error' : '';
}
function setBusy(value: boolean): void {
  busy = value;
  scope.disabled = busy || !scope.options.length;
  $<HTMLFieldSetElement>('presets').disabled = busy || !ready || !models.length;
  $<HTMLFieldSetElement>('task-titles').disabled = busy || !ready || !models.length;
  const valid = presets.length && presets.every(preset => selectedModel(models, preset.model)
    && presetEffortOptions(selectedModel(models, preset.model)).some(option => option.id === preset.effort)) && selectedModel(models, titleModel.value)
    && titleEffortOptions(selectedModel(models, titleModel.value)).some(option => option.id === titleEffort.value);
  $<HTMLButtonElement>('save').disabled = busy || !ready || !dirty || !valid;
  $<HTMLButtonElement>('reload').disabled = busy;
}
function options(select: HTMLSelectElement, values: { id: string; label: string }[], selected: string): void {
  select.replaceChildren(...values.map(value => new Option(value.label, value.id)));
  if (selected && !values.some(value => value.id === selected)) {
    const current = new Option(`${selected} (現在の設定・候補にありません)`, selected);
    current.disabled = true;
    select.add(current);
  }
  select.value = selected;
}
function compatibleEffort(selected: string, model?: Model): string {
  const values = presetEffortOptions(model);
  return [selected, DEFAULT_PRESET.effort, model?.defaultEffort, 'default'].find(id => values.some(option => option.id === id))!;
}
function modelOptions(): { id: string; label: string }[] {
  const latest = latestModel(models);
  return [{ id: 'latest', label: latest ? `最新モデル (${latest.label})` : '最新モデル' }, ...models.map(model => ({ id: model.id, label: model.label }))];
}
function renderPresets(): void {
  $('preset-list').replaceChildren(...presets.map((preset, index) => {
    const card = document.createElement('section');
    card.className = 'preset-card';
    card.setAttribute('role', 'group');
    card.setAttribute('aria-labelledby', `preset-title-${index}`);
    card.innerHTML = `<div class="preset-header"><div><h2 id="preset-title-${index}">プリセット${index + 1}</h2>${index === 0 ? '<span class="preset-default">新規タスクの初期設定</span>' : ''}</div><div class="preset-actions"><button type="button" class="secondary" data-action="up" aria-label="プリセット${index + 1}を上へ" title="上へ">↑</button><button type="button" class="secondary" data-action="down" aria-label="プリセット${index + 1}を下へ" title="下へ">↓</button><button type="button" class="secondary" data-action="remove" aria-label="プリセット${index + 1}を削除">削除</button></div></div>
      <label for="preset-model-${index}">モデル</label><select id="preset-model-${index}" data-field="model" aria-describedby="preset-model-description-${index}"></select><p id="preset-model-description-${index}" class="hint"></p>
      <div class="preset-fields"><div><label for="preset-effort-${index}">推論強度</label><select id="preset-effort-${index}" data-field="effort"></select></div><div><label for="preset-mode-${index}">権限</label><select id="preset-mode-${index}" data-field="mode" aria-describedby="preset-permission-description-${index}"></select></div></div><p id="preset-permission-description-${index}" class="hint"></p>`;
    const model = card.querySelector<HTMLSelectElement>('[data-field=model]')!;
    const effort = card.querySelector<HTMLSelectElement>('[data-field=effort]')!;
    const permissions = card.querySelector<HTMLSelectElement>('[data-field=mode]')!;
    const describeModel = (): void => {
      card.querySelector(`#preset-model-description-${index}`)!.textContent = preset.model === 'latest'
        ? '利用可能な最新の推奨モデルを自動選択します。'
        : selectedModel(models, preset.model)?.description ?? 'このモデルは現在の候補にありません。別のモデルを選択してください。';
    };
    const describePermissions = (): void => {
      card.querySelector(`#preset-permission-description-${index}`)!.textContent = presetPermissionOptions.find(option => option.id === preset.mode)?.description ?? '';
    };
    options(model, modelOptions(), preset.model);
    options(effort, presetEffortOptions(selectedModel(models, preset.model)), preset.effort);
    options(permissions, presetPermissionOptions, preset.mode);
    describeModel(); describePermissions();
    model.addEventListener('change', () => {
      preset.model = model.value;
      preset.effort = compatibleEffort(preset.effort, selectedModel(models, preset.model));
      options(effort, presetEffortOptions(selectedModel(models, preset.model)), preset.effort);
      describeModel(); changed();
    });
    effort.addEventListener('change', () => { preset.effort = effort.value; changed(); });
    permissions.addEventListener('change', () => { preset.mode = permissions.value as ExecutionMode; describePermissions(); changed(); });
    for (const action of ['up', 'down', 'remove'] as const) {
      const button = card.querySelector<HTMLButtonElement>(`[data-action=${action}]`)!;
      button.disabled = action === 'up' ? index === 0 : action === 'down' ? index === presets.length - 1 : presets.length === 1;
      button.addEventListener('click', () => {
        let target = index;
        if (action === 'remove') {
          if (presets.length === 1) return;
          presets.splice(index, 1); target = Math.min(index, presets.length - 1);
        } else {
          target = index + (action === 'up' ? -1 : 1);
          if (!presets[target]) return;
          [presets[index], presets[target]] = [presets[target]!, preset];
        }
        renderPresets(); changed(); $(`preset-model-${target}`).focus();
      });
    }
    return card;
  }));
}
function load(selectedScope = scope.value || 'user'): void {
  ready = false;
  setBusy(true);
  status('候補を読み込み中…');
  vscode.postMessage({ type: 'loadSettings', scope: selectedScope, requestId: ++requestId });
}
function changed(): void {
  dirty = true; setBusy(false); status('未保存の変更があります。');
}

window.addEventListener('message', event => {
  const message = object(event.data);
  if (message.type === 'reload') { if (!dirty && !busy) load(); return; }
  if (message.requestId !== requestId && message.requestId !== undefined) return;
  if (message.type === 'settingsError') { setBusy(false); status(string(message.message), true); return; }
  if (message.type !== 'settingsState') return;
  models = array(message.models) as Model[];
  presets = readPresets(message.presets);
  options(titleModel, modelOptions(), readTitleModel(message.titleModel));
  options(titleEffort, titleEffortOptions(selectedModel(models, titleModel.value)), readTitleEffort(message.titleEffort));
  options(scope, array(message.scopes).map(value => ({ id: string(object(value).id), label: string(object(value).label) })), string(message.scope, 'user'));
  renderPresets();
  ready = true; dirty = false; setBusy(false);
  vscode.setState({ scope: scope.value });
  status(!models.length ? '利用できるモデルがありません。接続を確認して候補を再読み込みしてください。' : message.saved ? '設定を保存しました。' : '', !models.length);
});
scope.addEventListener('change', () => load());
titleModel.addEventListener('change', () => {
  const values = titleEffortOptions(selectedModel(models, titleModel.value));
  options(titleEffort, values, values.some(option => option.id === titleEffort.value) ? titleEffort.value : DEFAULT_TITLE_EFFORT);
  changed();
});
titleEffort.addEventListener('change', () => changed());
$('add-preset').addEventListener('click', () => {
  presets.push({ ...DEFAULT_PRESET, effort: compatibleEffort(DEFAULT_PRESET.effort, latestModel(models)) });
  renderPresets(); changed(); $(`preset-model-${presets.length - 1}`).focus();
});
$('settings-form').addEventListener('submit', event => {
  event.preventDefault();
  if ($<HTMLButtonElement>('save').disabled) return;
  setBusy(true); status('保存中…');
  vscode.postMessage({ type: 'saveSettings', scope: scope.value, presets, titleModel: titleModel.value, titleEffort: titleEffort.value, requestId: ++requestId });
});
$('reload').addEventListener('click', () => load());
$('codex-config').addEventListener('click', () => vscode.postMessage({ type: 'openCodexSettings' }));
$('other-settings').addEventListener('click', () => vscode.postMessage({ type: 'openOtherSettings' }));
load(string(object(vscode.getState()).scope, 'user'));
