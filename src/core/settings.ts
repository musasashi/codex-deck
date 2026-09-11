import { array, messageOf, object, string, type ExecutionMode, type Model, type RunSettings, type SettingsPreset } from './types';
import { permissionPresets } from './composer';
import { huggingFaceModel, isHuggingFaceModel, isHuggingFaceTask } from './huggingFace';
import type { Task } from './types';
import { readTokenPrice, validateTokenPrice } from './cost';

export const DEFAULT_PRESET = { model: 'latest', effort: 'high', mode: 'auto-review' } as const satisfies SettingsPreset;
export const DEFAULT_TITLE_MODEL = 'latest';
export const DEFAULT_TITLE_EFFORT = 'lowest';

export function readTitleModel(value: unknown): string { return string(value).trim() || DEFAULT_TITLE_MODEL; }
export function readTitleEffort(value: unknown): string { return string(value).trim() || DEFAULT_TITLE_EFFORT; }

export function validateTitleModel(value: unknown, models: Model[]): string {
  const model = string(value).trim();
  if (!model || model !== 'latest' && !selectedModel(models, model)) throw new Error('タスク名の要約に使うモデルを選択してください。');
  return model;
}

export function resolveTitleEffort(effort: string, model?: Model): string | undefined {
  if (effort === 'default') return model?.defaultEffort || undefined;
  if (model?.efforts.some(option => option.id === effort)) return effort;
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].find(id => model?.efforts.some(option => option.id === id))
    ?? model?.efforts[0]?.id ?? (model?.defaultEffort || undefined);
}

export function titleEffortOptions(model?: Model): { id: string; label: string }[] {
  const lowest = resolveTitleEffort(DEFAULT_TITLE_EFFORT, model);
  return [{ id: DEFAULT_TITLE_EFFORT, label: lowest ? `最低 (${lowest})` : '最低' }, ...presetEffortOptions(model)];
}

export function validateTitleEffort(value: unknown, model?: Model): string {
  const effort = string(value).trim();
  if (!titleEffortOptions(model).some(option => option.id === effort)) throw new Error('要約モデルに対応する推論強度を選択してください。');
  return effort;
}

export const presetPermissionOptions = [...permissionPresets,
  { id: 'read-only', label: 'Read Only', description: '読み取り専用で実行します。' },
  { id: 'default', label: 'Codex設定を引き継ぐ', description: 'Codexの権限設定を引き継ぎます。' },
];

export function selectedModel(models: Model[], id: string): Model | undefined {
  return id === 'latest' ? latestModel(models) : huggingFaceModel(id) ?? models.find(model => model.id === id);
}

export function presetEffortOptions(model?: Model): { id: string; label: string }[] {
  return [{ id: 'default', label: 'モデルの既定値' }, ...(model?.efforts ?? []).map(effort => ({ id: effort.id, label: effort.id }))];
}

export function validatePreset(value: unknown, models: Model[]): SettingsPreset {
  const data = object(value);
  const model = string(data.model);
  const effort = string(data.effort);
  const mode = string(data.mode);
  const selected = selectedModel(models, model);
  if (!selected) throw new Error('利用できるモデルを選択してください。候補の再読み込みもお試しください。');
  if (!presetEffortOptions(selected).some(option => option.id === effort)) throw new Error('選択したモデルに対応する推論強度を選択してください。');
  if (!presetPermissionOptions.some(option => option.id === mode)) throw new Error('一覧から権限を選択してください。');
  return { model, effort, mode: mode as ExecutionMode, ...(isHuggingFaceModel(model) ? { pricing: validateTokenPrice(data.pricing) } : {}) };
}

export function readPresets(value: unknown): SettingsPreset[] {
  const presets = array(value).flatMap(value => {
    const data = object(value);
    const model = string(data.model), effort = string(data.effort), mode = string(data.mode);
    return model && effort && presetPermissionOptions.some(option => option.id === mode)
      ? [{ model, effort: isHuggingFaceModel(model) ? 'default' : effort, mode: mode as ExecutionMode, ...(isHuggingFaceModel(model) && readTokenPrice(data.pricing) ? { pricing: readTokenPrice(data.pricing) } : {}) }] : [];
  });
  return presets.length ? presets : [{ ...DEFAULT_PRESET }];
}

export function validatePresets(value: unknown, models: Model[]): SettingsPreset[] {
  if (!Array.isArray(value) || !value.length) throw new Error('プリセットを1件以上追加してください。');
  return value.map((preset, index) => {
    try { return validatePreset(preset, models); }
    catch (error) { throw new Error(`プリセット${index + 1}: ${messageOf(error)}`); }
  });
}

export function nextPresetIndex(settings: RunSettings, presets: SettingsPreset[], models: Model[], previousIndex = -1): number {
  if (!presets.length) return -1;
  const same = (a: RunSettings, b: RunSettings): boolean => a.model === b.model && a.effort === b.effort && a.mode === b.mode
    && a.pricing?.input === b.pricing?.input && a.pricing?.output === b.pricing?.output;
  const matches = (preset: SettingsPreset): boolean => {
    if (same(preset, settings)) return true;
    try { return same(resolveRunSettings(preset, models), resolveRunSettings(settings, models)); }
    catch { return false; }
  };
  const previous = presets[previousIndex];
  const current = previous && matches(previous) ? previousIndex : presets.findIndex(matches);
  return (current + 1) % presets.length;
}

export function taskPresets(task: Task, presets: SettingsPreset[]): SettingsPreset[] {
  return task.threadId ? presets.filter(preset => isHuggingFaceModel(preset.model) === isHuggingFaceTask(task)) : presets;
}

export function latestModel(models: Model[]): Model | undefined {
  models = models.filter(model => !isHuggingFaceModel(model.id));
  let model = models.find(model => model.isDefault) ?? models[0];
  const seen = new Set<string>();
  while (model) {
    seen.add(model.id);
    const upgradeId = model.upgrade;
    const upgrade = models.find(candidate => candidate.id === upgradeId);
    if (!upgrade || seen.has(upgrade.id)) break;
    model = upgrade;
  }
  return model;
}

export function resolveRunSettings(settings: RunSettings, models: Model[]): RunSettings {
  if (!settings.model) return { ...settings };
  const model = selectedModel(models, settings.model);
  if (!model) throw new Error(settings.model === 'latest' ? '利用できるモデルを取得できませんでした。再接続してください。' : `モデル「${settings.model}」は利用できません。拡張機能の設定またはタスクのモデルを変更してください。`);
  const effort = model.efforts.some(effort => effort.id === settings.effort) ? settings.effort : model.defaultEffort || undefined;
  return { ...settings, model: model.id, effort };
}
