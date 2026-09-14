import { array, object, string, type JsonObject, type Model, type Task } from './types';
import { displayModel as hfDisplayModel, HF_MODEL_CONFIG, HF_PROVIDER, isHuggingFaceModel, isHuggingFaceProvider, modelRequest as hfModelRequest } from './huggingFace';

export interface ResponsesModel {
  id: string;
  images: boolean;
  reasoningEfforts: string[];
  structuredOutput: boolean;
}
export interface ResponsesProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEnv: string;
  models: ResponsesModel[];
}
const PREFIX = 'responses:';
const PROVIDER_PREFIX = 'codex_deck_responses_';
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** This is also used by the editor so drafts can be displayed before validation. */
export function readProviders(value: unknown): ResponsesProvider[] {
  return array(value).map(value => {
    const p = object(value);
    return { id: string(p.id).trim(), name: string(p.name).trim(), baseUrl: string(p.baseUrl).trim(), apiKeyEnv: string(p.apiKeyEnv).trim(),
      models: array(p.models).map(value => {
        const m = object(value);
        return { id: string(m.id).trim(), images: m.images === true, reasoningEfforts: array(m.reasoningEfforts).map(value => string(value).trim()).filter(Boolean), structuredOutput: m.structuredOutput === true };
      }) };
  });
}

export function validateProviders(value: unknown): ResponsesProvider[] {
  if (!Array.isArray(value)) throw new Error('Responses APIの接続先を配列で指定してください。');
  const providers = readProviders(value), ids = new Set<string>();
  for (const p of providers) {
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(p.id) || ids.has(p.id)) throw new Error('接続先IDは重複しない半角英小文字・数字・ハイフン・アンダースコアで指定し、英字で始めてください（48文字以内）。');
    ids.add(p.id);
    if (!p.name || p.name.length > 100) throw new Error(`${p.id}: 表示名を100文字以内で入力してください。`);
    let url: URL;
    try { url = new URL(p.baseUrl); } catch { throw new Error(`${p.name}: Base URLを入力してください。`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error(`${p.name}: Base URLは認証情報・クエリー・フラグメントを含まないHTTP(S) URLにしてください。`);
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    if (url.protocol === 'http:' && !loopback)
      throw new Error(`${p.name}: 外部APIのBase URLはHTTPSにしてください。HTTPはループバック接続（localhost・127.0.0.0/8・[::1]）のみ使用できます。`);
    p.baseUrl = url.toString().replace(/\/+$/, '');
    if (p.apiKeyEnv && !ENV_NAME.test(p.apiKeyEnv)) throw new Error(`${p.name}: APIキーの環境変数名を確認してください。`);
    if (!p.models.length) throw new Error(`${p.name}: モデルを1件以上登録してください。`);
    const models = new Set<string>();
    for (const m of p.models) {
      if (!m.id || /[\s\x00-\x1f\x7f]/.test(m.id) || m.id.length > 256 || models.has(m.id)) throw new Error(`${p.name}: モデルIDは空白を含まない256文字以内の値を重複なく指定してください。`);
      models.add(m.id);
      if (m.reasoningEfforts.some(effort => !/^[a-z][a-z0-9_-]*$/.test(effort)) || new Set(m.reasoningEfforts).size !== m.reasoningEfforts.length)
        throw new Error(`${p.name} / ${m.id}: 推論強度を重複なく指定してください。`);
    }
  }
  return providers;
}

export function responsesModelId(provider: string, model: string): string { return `${PREFIX}${provider}:${model}`; }
export function parseResponsesModel(id?: string): { provider: string; model: string } | undefined {
  const match = /^responses:([a-z][a-z0-9_-]{0,47}):([^\s\x00-\x1f\x7f]+)$/.exec(id ?? '');
  return match ? { provider: match[1]!, model: match[2]! } : undefined;
}
export function providerId(id: string): string { return `${PROVIDER_PREFIX}${id}`; }
export function isExternalModel(id?: string): boolean { return isHuggingFaceModel(id) || id?.startsWith(PREFIX) === true; }
export function isExternalProvider(id?: string): boolean { return isHuggingFaceProvider(id) || id?.startsWith(PROVIDER_PREFIX) === true; }
export function canonicalProvider(id?: string): string { return isHuggingFaceProvider(id) ? HF_PROVIDER : id?.startsWith(PROVIDER_PREFIX) ? id : 'openai'; }
export function modelProvider(id?: string): string {
  if (isHuggingFaceModel(id)) return HF_PROVIDER;
  const model = parseResponsesModel(id);
  return model ? providerId(model.provider) : 'openai';
}
export function isExternalTask(task: Pick<Task, 'settings' | 'effectiveModel' | 'modelProvider'>): boolean {
  return isExternalProvider(task.modelProvider) || isExternalModel(task.settings.model ?? task.effectiveModel);
}
export function sameTaskProvider(task: Pick<Task, 'settings' | 'effectiveModel' | 'modelProvider'>, model: string): boolean {
  const stored = canonicalProvider(task.modelProvider ?? modelProvider(task.settings.model ?? task.effectiveModel));
  return stored === canonicalProvider(modelProvider(model));
}
export function modelRequest(id?: string): { model?: string; modelProvider?: string } {
  if (!id?.startsWith(PREFIX)) return hfModelRequest(id);
  const parsed = parseResponsesModel(id);
  if (!parsed) throw new Error('Responses APIのモデルIDを確認してください。');
  return { model: parsed.model, modelProvider: providerId(parsed.provider) };
}
export function displayModel(id: string | undefined, provider?: string): string | undefined {
  if (id && provider?.startsWith(PROVIDER_PREFIX) && !id.startsWith(PREFIX)) return responsesModelId(provider.slice(PROVIDER_PREFIX.length), id);
  return hfDisplayModel(id, provider);
}
export function providerModels(providers: ResponsesProvider[]): Model[] {
  return providers.flatMap(p => p.models.map(m => ({ id: responsesModelId(p.id, m.id), label: `${p.name} · ${m.id}`,
    description: `${p.name}のResponses APIで呼び出します。`, efforts: m.reasoningEfforts.map(id => ({ id, description: id })),
    defaultEffort: '', isDefault: false, inputModalities: m.images ? ['text', 'image'] : ['text'], structuredOutput: m.structuredOutput })));
}
export function configuredModel(id: string, providers: ResponsesProvider[]): { provider: ResponsesProvider; model: ResponsesModel } {
  const parsed = parseResponsesModel(id);
  const provider = providers.find(p => p.id === parsed?.provider);
  const model = provider?.models.find(m => m.id === parsed?.model);
  if (!provider || !model) throw new Error(`モデル「${id}」のResponses API接続先を設定してください。`);
  return { provider, model };
}
export function externalModelConfig(id: string, providers: ResponsesProvider[], effort?: string): JsonObject {
  if (isHuggingFaceModel(id)) return { ...HF_MODEL_CONFIG };
  const { model } = configuredModel(id, providers);
  return { web_search: 'disabled', model_supports_reasoning_summaries: false, model_reasoning_summary: 'none',
    ...(effort && model.reasoningEfforts.includes(effort) ? { model_reasoning_effort: effort } : {}),
    'tools.view_image': model.images };
}
