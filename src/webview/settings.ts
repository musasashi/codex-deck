import { DEFAULT_PRESET, DEFAULT_TITLE_EFFORT, presetEffortOptions, presetPermissionOptions, latestModel, readPresets, readTitleEffort, readTitleModel, selectedModel, titleEffortOptions } from '../core/settings';
import { array, object, string, type ExecutionMode, type Model, type SettingsPreset } from '../core/types';
import { HF_MODEL_PREFIX, isHuggingFaceModel } from '../core/huggingFace';
import { readTokenPrice } from '../core/cost';
import { providerCheckKey, type ProviderCheck, type ProviderCheckPurpose } from '../core/providerCheck';
import { isExternalModel, parseResponsesModel, providerModels, readProviders, validateProviders } from '../core/providers';
import { ProviderEditor } from './providers';
import { readQuestionPresets, validateQuestionPresets, type QuestionPreset } from '../core/questionPresets';

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
let questionPresets: QuestionPreset[] = [];
let requestId = 0;
let ready = false;
let busy = false;
let dirty = false;
const checks = new Map<string, ProviderCheck>();
let nativeModels: Model[] = [];
const providerEditor = new ProviderEditor($('provider-list'), () => {
  models = [...nativeModels, ...providerModels(readProviders(providerEditor.value))];
  checks.clear();
  renderPresets();
  options(titleModel, modelOptions(), isHuggingFaceModel(titleModelId) ? 'huggingface' : titleModelId);
  options(titleEffort, titleEffortOptions(selectedModel(models, titleModelId)), titleEffort.value);
  changed();
});
function price(input: HTMLInputElement, output: HTMLInputElement): { input: number; output: number } | undefined {
  return input.value === '' && output.value === '' ? undefined : { input: input.valueAsNumber, output: output.valueAsNumber };
}

function status(message: string, error = false): void {
  $('status').textContent = message;
  $('status').className = error ? 'error' : '';
}
function setBusy(value: boolean): void {
  busy = value;
  scope.disabled = busy || !scope.options.length;
  $<HTMLFieldSetElement>('presets').disabled = busy || !ready;
  $<HTMLFieldSetElement>('question-presets').disabled = busy || !ready;
  $<HTMLFieldSetElement>('task-titles').disabled = busy || !ready;
  $<HTMLFieldSetElement>('providers').disabled = busy || !ready;
  let validProviders = true;
  try { validateProviders(providerEditor.value); } catch { validProviders = false; }
  let validQuestions = true;
  try { validateQuestionPresets(questionPresets, models); } catch { validQuestions = false; }
  const valid = validQuestions && presets.length && presets.every(preset => selectedModel(models, preset.model)
    && presetEffortOptions(selectedModel(models, preset.model)).some(option => option.id === preset.effort)
    && (!isExternalModel(preset.model) || preset.pricing === undefined || readTokenPrice(preset.pricing))) && (titleModelId === 'latest' || selectedModel(models, titleModelId))
    && (!isExternalModel(titleModelId) || !price(titleInputPrice, titleOutputPrice) || readTokenPrice(price(titleInputPrice, titleOutputPrice)))
    && validProviders
    && titleEffortOptions(selectedModel(models, titleModelId)).some(option => option.id === titleEffort.value);
  $<HTMLButtonElement>('save').disabled = busy || !ready || !dirty || !valid;
  $<HTMLButtonElement>('reload').disabled = busy;
  renderChecks();
}
function renderCheck(button: HTMLButtonElement, message: HTMLElement, model: string, purpose: ProviderCheckPurpose): void {
  const result = checks.get(providerCheckKey(model, purpose)) ?? (purpose === 'title' ? checks.get(providerCheckKey(model, 'task')) : undefined);
  button.disabled = busy || !ready || !selectedModel(models, model);
  button.textContent = result ? '再確認' : '利用可否を確認';
  button.classList.toggle('accent', !result);
  message.textContent = result?.message ?? '未確認：確認は任意です。設定の保存では推論APIを呼び出しません。';
  message.className = result?.status === 'failed' ? 'hint error' : 'hint';
}
function renderChecks(): void {
  for (const [index, preset] of presets.entries()) {
    const card = $('preset-list').children[index];
    if (card) renderCheck(card.querySelector<HTMLButtonElement>('[data-action=check]')!, card.querySelector<HTMLElement>('[data-field=hf-check]')!, preset.model, 'task');
  }
  for (const [index, preset] of questionPresets.entries()) {
    const card = $('question-preset-list').children[index];
    if (card) renderCheck(card.querySelector<HTMLButtonElement>('[data-action=check]')!, card.querySelector<HTMLElement>('[data-field=hf-check]')!, preset.settings.model, 'task');
  }
  renderCheck($<HTMLButtonElement>('title-hf-check'), $('title-hf-check-result'), titleModelId, 'title');
}
function checkModel(model: string, purpose: ProviderCheckPurpose): void {
  try { validateProviders(providerEditor.value); } catch (error) { status(error instanceof Error ? error.message : String(error), true); return; }
  setBusy(true); status('APIモデルの利用可否を確認中…');
  $('cancel-check').hidden = false;
  $<HTMLButtonElement>('cancel-check').disabled = false;
  vscode.postMessage({ type: 'checkProviderModel', scope: scope.value, model, purpose, providers: providerEditor.value, requestId: ++requestId });
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
function renderPresets(): void { renderPresetList(false); renderPresetList(true); }
function renderPresetList(questions: boolean): void {
  const prefix = questions ? 'question-preset' : 'preset', label = questions ? '質問プリセット' : 'プリセット';
  const rows = questions ? questionPresets : presets;
  const settings = questions ? questionPresets.map(preset => preset.settings) : presets;
  $(`${prefix}-list`).replaceChildren(...settings.map((preset, index) => {
    const card = document.createElement('section');
    card.className = 'preset-card';
    card.setAttribute('role', 'group');
    card.setAttribute('aria-labelledby', `${prefix}-title-${index}`);
    card.innerHTML = `<div class="preset-header"><div><h2 id="${prefix}-title-${index}">${label}${index + 1}</h2>${!questions && index === 0 ? '<span class="preset-default">新規タスクの初期設定</span>' : ''}</div><div class="preset-actions"><button type="button" class="secondary" data-action="up" aria-label="${label}${index + 1}を上へ" title="上へ">↑</button><button type="button" class="secondary" data-action="down" aria-label="${label}${index + 1}を下へ" title="下へ">↓</button><button type="button" class="secondary" data-action="remove" aria-label="${label}${index + 1}を削除">削除</button></div></div>
      ${questions ? `<label for="question-name-${index}">表示名</label><input id="question-name-${index}" type="text" placeholder="例: かみ砕いて説明" required>
      <label for="question-prompt-${index}">質問文</label><textarea id="question-prompt-${index}" rows="3" placeholder="例: 選択した文章を、専門用語を補足しながら具体例付きで説明してください。" required></textarea>` : ''}
      <label for="${prefix}-model-${index}">モデル</label><select id="${prefix}-model-${index}" data-field="model" aria-describedby="${prefix}-model-description-${index}"></select><p id="${prefix}-model-description-${index}" class="hint"></p>
      <div data-field="hf-field" hidden><div data-field="hf-id"><label for="${prefix}-hf-model-${index}">HFのモデルID</label><input id="${prefix}-hf-model-${index}" data-field="hf-model" type="text" placeholder="組織/モデル:プロバイダー" autocomplete="off" spellcheck="false"></div>
        <div class="preset-fields"><div><label for="${prefix}-input-price-${index}">入力単価（USD／100万トークン）</label><input id="${prefix}-input-price-${index}" data-field="input-price" type="number" min="0" step="any"></div><div><label for="${prefix}-output-price-${index}">出力単価（USD／100万トークン）</label><input id="${prefix}-output-price-${index}" data-field="output-price" type="number" min="0" step="any"></div></div>
        <div class="hf-check"><button type="button" class="secondary" data-action="check">利用可否を確認</button><p data-field="hf-check" class="hint" aria-live="polite"></p></div>
      </div>
      <div class="preset-fields"><div><label for="${prefix}-effort-${index}">推論強度</label><select id="${prefix}-effort-${index}" data-field="effort"></select></div><div><label for="${prefix}-mode-${index}">権限</label><select id="${prefix}-mode-${index}" data-field="mode" aria-describedby="${prefix}-permission-description-${index}"></select></div></div><p id="${prefix}-permission-description-${index}" class="hint"></p>`;
    if (questions) {
      const question = questionPresets[index]!;
      const name = card.querySelector<HTMLInputElement>(`#question-name-${index}`)!;
      const prompt = card.querySelector<HTMLTextAreaElement>(`#question-prompt-${index}`)!;
      name.value = question.name; prompt.value = question.prompt;
      name.addEventListener('input', () => { question.name = name.value; changed(); });
      prompt.addEventListener('input', () => { question.prompt = prompt.value; changed(); });
    }
    const model = card.querySelector<HTMLSelectElement>('[data-field=model]')!;
    const hfModel = card.querySelector<HTMLInputElement>('[data-field=hf-model]')!;
    const hfField = card.querySelector<HTMLElement>('[data-field=hf-field]')!;
    const inputPrice = card.querySelector<HTMLInputElement>('[data-field=input-price]')!;
    const outputPrice = card.querySelector<HTMLInputElement>('[data-field=output-price]')!;
    inputPrice.value = preset.pricing?.input === undefined ? '' : String(preset.pricing.input);
    outputPrice.value = preset.pricing?.output === undefined ? '' : String(preset.pricing.output);
    const updatePrice = (): void => { preset.pricing = isExternalModel(preset.model) ? price(inputPrice, outputPrice) : undefined; };
    for (const price of [inputPrice, outputPrice]) price.addEventListener('input', () => { updatePrice(); changed(); });
    const effort = card.querySelector<HTMLSelectElement>('[data-field=effort]')!;
    card.querySelector<HTMLButtonElement>('[data-action=check]')!.addEventListener('click', () => checkModel(preset.model, 'task'));
    const permissions = card.querySelector<HTMLSelectElement>('[data-field=mode]')!;
    const describeModel = (): void => {
      card.querySelector(`#${prefix}-model-description-${index}`)!.textContent = preset.model === 'latest'
        ? '利用可能な最新の推奨モデルを自動選択します。'
        : selectedModel(models, preset.model)?.description ?? 'このモデルは現在の候補にありません。別のモデルを選択してください。';
    };
    const describePermissions = (): void => {
      card.querySelector(`#${prefix}-permission-description-${index}`)!.textContent = presetPermissionOptions.find(option => option.id === preset.mode)?.description ?? '';
    };
    options(model, modelOptions(), isHuggingFaceModel(preset.model) ? 'huggingface' : preset.model);
    hfModel.value = isHuggingFaceModel(preset.model) ? preset.model.slice(HF_MODEL_PREFIX.length) : '';
    const showExternal = (): void => {
      hfField.hidden = !isExternalModel(preset.model);
      card.querySelector<HTMLElement>('[data-field=hf-id]')!.hidden = model.value !== 'huggingface';
      hfModel.disabled = model.value !== 'huggingface';
      for (const field of [inputPrice, outputPrice]) field.disabled = hfField.hidden;
    };
    showExternal();
    options(effort, presetEffortOptions(selectedModel(models, preset.model)), preset.effort);
    options(permissions, presetPermissionOptions, preset.mode);
    describeModel(); describePermissions();
    model.addEventListener('change', () => {
      preset.model = model.value === 'huggingface' ? `${HF_MODEL_PREFIX}${hfModel.value.trim()}` : model.value;
      showExternal();
      inputPrice.value = ''; outputPrice.value = '';
      updatePrice();
      preset.effort = compatibleEffort(preset.effort, selectedModel(models, preset.model));
      options(effort, presetEffortOptions(selectedModel(models, preset.model)), preset.effort);
      describeModel(); changed();
      if (model.value === 'huggingface') hfModel.focus();
    });
    hfModel.addEventListener('input', () => {
      preset.model = `${HF_MODEL_PREFIX}${hfModel.value.trim()}`;
      describeModel(); changed();
    });
    effort.addEventListener('change', () => { preset.effort = effort.value; changed(); });
    permissions.addEventListener('change', () => { preset.mode = permissions.value as ExecutionMode; describePermissions(); changed(); });
    for (const action of ['up', 'down', 'remove'] as const) {
      const button = card.querySelector<HTMLButtonElement>(`[data-action=${action}]`)!;
      button.disabled = action === 'up' ? index === 0 : action === 'down' ? index === rows.length - 1 : !questions && rows.length === 1;
      button.addEventListener('click', () => {
        let target = index;
        if (action === 'remove') {
          if (!questions && rows.length === 1) return;
          rows.splice(index, 1); target = Math.min(index, rows.length - 1);
        } else {
          target = index + (action === 'up' ? -1 : 1);
          if (!rows[target]) return;
          if (questions) [questionPresets[index], questionPresets[target]] = [questionPresets[target]!, questionPresets[index]!];
          else [presets[index], presets[target]] = [presets[target]!, preset];
        }
        renderPresets(); changed();
        (document.getElementById(`${prefix}-model-${target}`) ?? $(`add-${prefix}`)).focus();
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
  if (message.type === 'providerCheckState' || message.type === 'providerCheckDone') {
    const result = message.result as ProviderCheck;
    checks.set(providerCheckKey(result.model, result.purpose), result);
    renderChecks();
    status(`${selectedModel(models, result.model)?.label ?? result.model}：${result.message}`, result.status === 'failed');
    if (message.type === 'providerCheckDone') { $('cancel-check').hidden = true; setBusy(false); }
    return;
  }
  if (message.type === 'settingsSaving') { $('cancel-check').hidden = true; status('保存中…'); return; }
  if (message.type === 'settingsError') { $('cancel-check').hidden = true; setBusy(false); status(string(message.message), true); return; }
  if (message.type !== 'settingsState') return;
  nativeModels = (array(message.models) as Model[]).filter(model => !parseResponsesModel(model.id));
  providerEditor.load(readProviders(message.providers));
  models = [...nativeModels, ...providerModels(providerEditor.value)];
  presets = readPresets(message.presets);
  questionPresets = readQuestionPresets(message.questionPresets);
  titleModelId = readTitleModel(message.titleModel);
  options(titleModel, modelOptions(), isHuggingFaceModel(titleModelId) ? 'huggingface' : titleModelId);
  titleHfModel.value = isHuggingFaceModel(titleModelId) ? titleModelId.slice(HF_MODEL_PREFIX.length) : '';
  const titlePrice = readTokenPrice(message.titlePricing);
  titleInputPrice.value = titlePrice ? String(titlePrice.input) : '';
  titleOutputPrice.value = titlePrice ? String(titlePrice.output) : '';
  showTitleFields();
  options(titleEffort, titleEffortOptions(selectedModel(models, titleModelId)), readTitleEffort(message.titleEffort));
  options(scope, array(message.scopes).map(value => ({ id: string(object(value).id), label: string(object(value).label) })), string(message.scope, 'user'));
  renderPresets();
  ready = true; dirty = false; setBusy(false);
  $('cancel-check').hidden = true;
  vscode.setState({ scope: scope.value });
  status(message.saved ? '設定を保存しました。' : string(message.modelError) || (!models.length ? 'モデル一覧を取得できません。HFやResponses APIのモデルは登録できます。' : ''), !message.saved && !!message.modelError);
});
function showTitleFields(): void {
  $('title-hf-field').hidden = !isExternalModel(titleModelId);
  $('title-hf-id').hidden = titleModel.value !== 'huggingface';
  titleHfModel.disabled = titleModel.value !== 'huggingface';
  for (const field of [titleInputPrice, titleOutputPrice]) field.disabled = !isExternalModel(titleModelId);
}
scope.addEventListener('change', () => load());
titleModel.addEventListener('change', () => {
  titleModelId = titleModel.value === 'huggingface' ? `${HF_MODEL_PREFIX}${titleHfModel.value.trim()}` : titleModel.value;
  showTitleFields();
  titleInputPrice.value = ''; titleOutputPrice.value = '';
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
$('add-question-preset').addEventListener('click', () => {
  questionPresets.push({ id: crypto.randomUUID(), name: '', prompt: '', settings: { ...DEFAULT_PRESET, effort: compatibleEffort(DEFAULT_PRESET.effort, latestModel(models)) } });
  renderPresets(); changed(); $(`question-name-${questionPresets.length - 1}`).focus();
});
$('settings-form').addEventListener('submit', event => {
  event.preventDefault();
  if ($<HTMLButtonElement>('save').disabled) return;
  setBusy(true); status('保存中…');
  $('cancel-check').hidden = true;
  vscode.postMessage({ type: 'saveSettings', scope: scope.value, presets, questionPresets, titleModel: titleModelId, titleEffort: titleEffort.value,
    titlePricing: isExternalModel(titleModelId) ? price(titleInputPrice, titleOutputPrice) : undefined, providers: providerEditor.value, requestId: ++requestId });
});
$('add-provider').addEventListener('click', () => providerEditor.add());
$('title-hf-check').addEventListener('click', () => checkModel(titleModelId, 'title'));
$('cancel-check').addEventListener('click', () => {
  $<HTMLButtonElement>('cancel-check').disabled = true;
  status('確認を中止しています…');
  vscode.postMessage({ type: 'cancelProviderCheck', requestId });
});
$('reload').addEventListener('click', () => load());
$('codex-config').addEventListener('click', () => vscode.postMessage({ type: 'openCodexSettings' }));
$('other-settings').addEventListener('click', () => vscode.postMessage({ type: 'openOtherSettings' }));
load(string(object(vscode.getState()).scope, 'user'));
