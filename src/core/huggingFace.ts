import type { Model, Task } from './types';

export const HF_PROVIDER = 'codex_deck_huggingface';
export const HF_MODEL_PREFIX = 'hf:';
export const HF_MODEL_CONFIG = { model_supports_reasoning_summaries: false, model_reasoning_summary: 'none', web_search: 'disabled' } as const;

export function isHuggingFaceProvider(provider?: string): boolean {
  return provider === HF_PROVIDER || provider === 'huggingface';
}

export function isHuggingFaceModel(id?: string): boolean { return id?.startsWith(HF_MODEL_PREFIX) === true; }

export function huggingFaceModel(id: string): Model | undefined {
  if (!isHuggingFaceModel(id)) return undefined;
  const model = id.slice(HF_MODEL_PREFIX.length);
  if (!/^[\w.-]+\/[\w.-]+(?::[\w-]+)?$/.test(model)) return undefined;
  return { id, label: `HF · ${model}`, description: 'Hugging Face Inference Providers経由で呼び出します。',
    efforts: [], defaultEffort: '', isDefault: false, inputModalities: ['text'] };
}

export function modelRequest(id?: string): { model?: string; modelProvider?: string } {
  if (!id) return {};
  if (!isHuggingFaceModel(id)) return { model: id };
  if (!huggingFaceModel(id)) throw new Error('HFのモデルIDを「組織/モデル」または「組織/モデル:プロバイダー」の形式で入力してください。');
  return { model: id.slice(HF_MODEL_PREFIX.length), modelProvider: HF_PROVIDER };
}

export function displayModel(id: string | undefined, provider?: string): string | undefined {
  return id && isHuggingFaceProvider(provider) && !isHuggingFaceModel(id) ? `${HF_MODEL_PREFIX}${id}` : id;
}

export function withHuggingFaceModels(models: Model[], ids: (string | undefined)[]): Model[] {
  const result = [...models];
  for (const id of ids) {
    const model = id && huggingFaceModel(id);
    if (model && !result.some(value => value.id === model.id)) result.push(model);
  }
  return result;
}

export function isHuggingFaceTask(task: Pick<Task, 'settings' | 'effectiveModel' | 'modelProvider'>): boolean {
  return isHuggingFaceProvider(task.modelProvider) || isHuggingFaceModel(task.settings.model ?? task.effectiveModel);
}

// Register a separate provider without changing the user's Codex configuration.
export const HF_CONFIG_ARGS = [
  '-c', `model_providers.${HF_PROVIDER}.name="Hugging Face"`,
  '-c', `model_providers.${HF_PROVIDER}.base_url="https://router.huggingface.co/v1"`,
  '-c', `model_providers.${HF_PROVIDER}.env_key="HF_TOKEN"`,
  '-c', `model_providers.${HF_PROVIDER}.wire_api="responses"`,
];
