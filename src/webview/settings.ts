import { DEFAULT_PRESET, DEFAULT_TITLE_EFFORT, presetEffortOptions, presetPermissionOptions, latestModel, readPresets, readTitleEffort, readTitleModel, selectedModel, titleEffortOptions } from '../core/settings';
import { array, object, string, type ExecutionMode, type Model, type SettingsPreset } from '../core/types';
import { HF_MODEL_PREFIX, isHuggingFaceModel } from '../core/huggingFace';
import { readTokenPrice } from '../core/cost';
import { huggingFaceCheckKey, type HuggingFaceCheck, type HuggingFaceCheckPurpose } from '../core/huggingFaceCheck';

declare function acquireVsCodeApi(): { postMessage(value: unknown): void; setState(value: unknown): void; getState(): unknown };
const vscode = acquireVsCodeApi();
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const scope = $<HTMLSelectElement>('scope');
const titleModel = $<HTMLSelectElement>('title-model');
const titleEffort = $<HTMLSelectElement>('title-effort');
const titleHfModel = $<HTMLInputElement>('title-hf-model');
const titleInputPrice = $<HTMLInputElement>('title-input-price');
const titleOutputPrice = $<HTMLInputElement>('title-output-price');
let titleModelId = 'latest';
let models: Model[] = [];
let presets: SettingsPreset[] = [];
let requestId = 0;
let ready = false;
let busy = false;
let dirty = false;
const checks = new Map<string, HuggingFaceCheck>();

function status(message: string, error = false): void {
  $('status').textContent = message;
  $('status').className = error ? 'error' : '';
}
function setBusy(value: boolean): void {
  busy = value;
  scope.disabled = busy || !scope.options.length;
  $<HTMLFieldSetElement>('presets').disabled = busy || !ready;
  $<HTMLFieldSetElement>('task-titles').disabled = busy || !ready;
  const valid = presets.length && presets.every(preset => selectedModel(models, preset.model)
    && presetEffortOptions(selectedModel(models, preset.model)).some(option => option.id === preset.effort)
    && (!isHuggingFaceModel(preset.model) || readTokenPrice(preset.pricing))) && (titleModelId === 'latest' || selectedModel(models, titleModelId))
    && (!isHuggingFaceModel(titleModelId) || readTokenPrice({ input: titleInputPrice.valueAsNumber, output: titleOutputPrice.valueAsNumber }))
    && titleEffortOptions(selectedModel(models, titleModelId)).some(option => option.id === titleEffort.value);
  $<HTMLButtonElement>('save').disabled = busy || !ready || !dirty || !valid;
  $<HTMLButtonElement>('reload').disabled = busy;
  renderChecks();
}
function renderCheck(button: HTMLButtonElement, message: HTMLElement, model: string, purpose: HuggingFaceCheckPurpose): void {
  const result = checks.get(huggingFaceCheckKey(model, purpose)) ?? (purpose === 'title' ? checks.get(huggingFaceCheckKey(model, 'task')) : undefined);
  button.disabled = busy || !ready || !selectedModel(models, model);
  button.textContent = result ? '再確認' : '利用可否を確認';
  message.textContent = result?.message ?? '未確認：保存前にResponses APIでの動作を確認します。';
  message.className = result?.status === 'failed' ? 'hint error' : 'hint';
}
function renderChecks(): void {
  for (const [index, preset] of presets.entries()) {
    const card = $('preset-list').children[index];
    if (card) renderCheck(card.querySelector<HTMLButtonElement>('[data-action=check]')!, card.querySelector<HTMLElement>('[data-field=hf-check]')!, preset.model, 'task');
  }
  renderCheck($<HTMLButtonElement>('title-hf-check'), $('title-hf-check-result'), titleModelId, 'title');
}
function checkModel(model: string, purpose: HuggingFaceCheckPurpose): void {
  setBusy(true); status('HFモデルの利用可否を確認中…');
  $('cancel-check').hidden = false;
  $<HTMLButtonElement>('cancel-check').disabled = false;
  vscode.postMessage({ type: 'checkHfModel', scope: scope.value, model, purpose, requestId: ++requestId });
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
  return [{ id: 'latest', label: latest ? `最新モデル (${latest.label})` : '最新モデル' }, { id: 'huggingface', label: 'Hugging Face（モデルIDを指定）' }, ...models.map(model => ({ id: model.id, label: model.label }))];
}
function renderPresets(): void {
  $('preset-list').replaceChildren(...presets.map((preset, index) => {
    const card = document.createElement('section');
    card.className = 'preset-card';
    card.setAttribute('role', 'group');
    card.setAttribute('aria-labelledby', `preset-title-${index}`);
    card.innerHTML = `<div class="preset-header"><div><h2 id="preset-title-${index}">プリセット${index + 1}</h2>${index === 0 ? '<span class="preset-default">新規タスクの初期設定</span>' : ''}</div><div class="preset-actions"><button type="button" class="secondary" data-action="up" aria-label="プリセット${index + 1}を上へ" title="上へ">↑</button><button type="button" class="secondary" data-action="down" aria-label="プリセット${index + 1}を下へ" title="下へ">↓</button><button type="button" class="secondary" data-action="remove" aria-label="プリセット${index + 1}を削除">削除</button></div></div>
      <label for="preset-model-${index}">モデル</label><select id="preset-model-${index}" data-field="model" aria-describedby="preset-model-description-${index}"></select><p id="preset-model-description-${index}" class="hint"></p>
      <div data-field="hf-field" hidden><label for="preset-hf-model-${index}">HFのモデルID</label><input id="preset-hf-model-${index}" data-field="hf-model" type="text" placeholder="組織/モデル:プロバイダー" autocomplete="off" spellcheck="false">
        <div class="preset-fields"><div><label for="preset-input-price-${index}">入力単価（USD／100万トークン）</label><input id="preset-input-price-${index}" data-field="input-price" type="number" min="0" step="any"></div><div><label for="preset-output-price-${index}">出力単価（USD／100万トークン）</label><input id="preset-output-price-${index}" data-field="output-price" type="number" min="0" step="any"></div></div>
        <div class="hf-check"><button type="button" class="secondary" data-action="check">利用可否を確認</button><p data-field="hf-check" class="hint" aria-live="polite"></p></div>
      </div>
      <div class="preset-fields"><div><label for="preset-effort-${index}">推論強度</label><select id="preset-effort-${index}" data-field="effort"></select></div><div><label for="preset-mode-${index}">権限</label><select id="preset-mode-${index}" data-field="mode" aria-describedby="preset-permission-description-${index}"></select></div></div><p id="preset-permission-description-${index}" class="hint"></p>`;
    const model = card.querySelector<HTMLSelectElement>('[data-field=model]')!;
    const hfModel = card.querySelector<HTMLInputElement>('[data-field=hf-model]')!;
    const hfField = card.querySelector<HTMLElement>('[data-field=hf-field]')!;
    const inputPrice = card.querySelector<HTMLInputElement>('[data-field=input-price]')!;
    const outputPrice = card.querySelector<HTMLInputElement>('[data-field=output-price]')!;
    inputPrice.value = preset.pricing?.input === undefined ? '' : String(preset.pricing.input);
    outputPrice.value = preset.pricing?.output === undefined ? '' : String(preset.pricing.output);
    const updatePrice = (): void => { preset.pricing = isHuggingFaceModel(preset.model) ? readTokenPrice({ input: inputPrice.valueAsNumber, output: outputPrice.valueAsNumber }) : undefined; };
    for (const price of [inputPrice, outputPrice]) price.addEventListener('input', () => { updatePrice(); changed(); });
    const effort = card.querySelector<HTMLSelectElement>('[data-field=effort]')!;
    card.querySelector<HTMLButtonElement>('[data-action=check]')!.addEventListener('click', () => checkModel(preset.model, 'task'));
    const permissions = card.querySelector<HTMLSelectElement>('[data-field=mode]')!;
    const describeModel = (): void => {
      card.querySelector(`#preset-model-description-${index}`)!.textContent = preset.model === 'latest'
        ? '利用可能な最新の推奨モデルを自動選択します。'
        : selectedModel(models, preset.model)?.description ?? 'このモデルは現在の候補にありません。別のモデルを選択してください。';
    };
    const describePermissions = (): void => {
      card.querySelector(`#preset-permission-description-${index}`)!.textContent = presetPermissionOptions.find(option => option.id === preset.mode)?.description ?? '';
    };
    options(model, modelOptions(), isHuggingFaceModel(preset.model) ? 'huggingface' : preset.model);
    hfModel.value = isHuggingFaceModel(preset.model) ? preset.model.slice(HF_MODEL_PREFIX.length) : '';
    hfField.hidden = model.value !== 'huggingface';
    for (const field of [hfModel, inputPrice, outputPrice]) field.disabled = hfField.hidden;
    options(effort, presetEffortOptions(selectedModel(models, preset.model)), preset.effort);
    options(permissions, presetPermissionOptions, preset.mode);
    describeModel(); describePermissions();
    model.addEventListener('change', () => {
      hfField.hidden = model.value !== 'huggingface';
      for (const field of [hfModel, inputPrice, outputPrice]) field.disabled = hfField.hidden;
      preset.model = model.value === 'huggingface' ? `${HF_MODEL_PREFIX}${hfModel.value.trim()}` : model.value;
      updatePrice();
      preset.effort = compatibleEffort(preset.effort, selectedModel(models, preset.model));
      options(effort, presetEffortOptions(selectedModel(models, preset.model)), preset.effort);
      describeModel(); changed();
      if (!hfField.hidden) hfModel.focus();
    });
    hfModel.addEventListener('input', () => {
      preset.model = `${HF_MODEL_PREFIX}${hfModel.value.trim()}`;
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
  checks.clear();
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
  if (message.type === 'hfCheckState' || message.type === 'hfCheckDone') {
    const result = message.result as HuggingFaceCheck;
    checks.set(huggingFaceCheckKey(result.model, result.purpose), result);
    renderChecks();
    status(`${result.model.slice(HF_MODEL_PREFIX.length)}：${result.message}`, result.status === 'failed');
    if (message.type === 'hfCheckDone') { $('cancel-check').hidden = true; setBusy(false); }
    return;
  }
  if (message.type === 'settingsSaving') { $('cancel-check').hidden = true; status('保存中…'); return; }
  if (message.type === 'settingsError') { $('cancel-check').hidden = true; setBusy(false); status(string(message.message), true); return; }
  if (message.type !== 'settingsState') return;
  models = array(message.models) as Model[];
  presets = readPresets(message.presets);
  titleModelId = readTitleModel(message.titleModel);
  options(titleModel, modelOptions(), isHuggingFaceModel(titleModelId) ? 'huggingface' : titleModelId);
  titleHfModel.value = isHuggingFaceModel(titleModelId) ? titleModelId.slice(HF_MODEL_PREFIX.length) : '';
  const titlePrice = readTokenPrice(message.titlePricing);
  titleInputPrice.value = titlePrice ? String(titlePrice.input) : '';
  titleOutputPrice.value = titlePrice ? String(titlePrice.output) : '';
  $('title-hf-field').hidden = titleModel.value !== 'huggingface';
  for (const field of [titleHfModel, titleInputPrice, titleOutputPrice]) field.disabled = titleModel.value !== 'huggingface';
  options(titleEffort, titleEffortOptions(selectedModel(models, titleModelId)), readTitleEffort(message.titleEffort));
  options(scope, array(message.scopes).map(value => ({ id: string(object(value).id), label: string(object(value).label) })), string(message.scope, 'user'));
  renderPresets();
  ready = true; dirty = false; setBusy(false);
  $('cancel-check').hidden = true;
  vscode.setState({ scope: scope.value });
  status(message.saved ? '設定を保存しました。' : string(message.modelError) || (!models.length ? 'モデル一覧を取得できません。HFのモデルIDは直接指定できます。' : ''), !message.saved && !!message.modelError);
});
scope.addEventListener('change', () => load());
titleModel.addEventListener('change', () => {
  titleModelId = titleModel.value === 'huggingface' ? `${HF_MODEL_PREFIX}${titleHfModel.value.trim()}` : titleModel.value;
  $('title-hf-field').hidden = titleModel.value !== 'huggingface';
  for (const field of [titleHfModel, titleInputPrice, titleOutputPrice]) field.disabled = titleModel.value !== 'huggingface';
  const values = titleEffortOptions(selectedModel(models, titleModelId));
  options(titleEffort, values, values.some(option => option.id === titleEffort.value) ? titleEffort.value : DEFAULT_TITLE_EFFORT);
  changed();
  if (titleModel.value === 'huggingface') titleHfModel.focus();
});
titleHfModel.addEventListener('input', () => { titleModelId = `${HF_MODEL_PREFIX}${titleHfModel.value.trim()}`; changed(); });
for (const price of [titleInputPrice, titleOutputPrice]) price.addEventListener('input', () => changed());
titleEffort.addEventListener('change', () => changed());
$('add-preset').addEventListener('click', () => {
  presets.push({ ...DEFAULT_PRESET, effort: compatibleEffort(DEFAULT_PRESET.effort, latestModel(models)) });
  renderPresets(); changed(); $(`preset-model-${presets.length - 1}`).focus();
});
$('settings-form').addEventListener('submit', event => {
  event.preventDefault();
  if ($<HTMLButtonElement>('save').disabled) return;
  const hasHf = presets.some(preset => isHuggingFaceModel(preset.model)) || isHuggingFaceModel(titleModelId);
  setBusy(true); status(hasHf ? 'HFモデルを確認して保存します…' : '保存中…');
  $('cancel-check').hidden = !hasHf;
  $<HTMLButtonElement>('cancel-check').disabled = false;
  vscode.postMessage({ type: 'saveSettings', scope: scope.value, presets, titleModel: titleModelId, titleEffort: titleEffort.value,
    titlePricing: isHuggingFaceModel(titleModelId) ? readTokenPrice({ input: titleInputPrice.valueAsNumber, output: titleOutputPrice.valueAsNumber }) : undefined, requestId: ++requestId });
});
$('title-hf-check').addEventListener('click', () => checkModel(titleModelId, 'title'));
$('cancel-check').addEventListener('click', () => {
  $<HTMLButtonElement>('cancel-check').disabled = true;
  status('確認を中止しています…');
  vscode.postMessage({ type: 'cancelHfCheck', requestId });
});
$('reload').addEventListener('click', () => load());
$('codex-config').addEventListener('click', () => vscode.postMessage({ type: 'openCodexSettings' }));
$('other-settings').addEventListener('click', () => vscode.postMessage({ type: 'openOtherSettings' }));
load(string(object(vscode.getState()).scope, 'user'));
