import { array, object, string, messageOf, type ExecutionMode, type Model, type SettingsPreset } from './types';
import { validatePreset } from './settings';
import { selectionReference } from './selectionReference';

export interface QuestionPreset { id: string; name: string; prompt: string; settings: SettingsPreset }
export type QuestionPresetMenuItem = Pick<QuestionPreset, 'id' | 'name'>;

export function readQuestionPresets(value: unknown): QuestionPreset[] {
  return array(value).map(value => {
    const row = object(value), settings = object(row.settings);
    return { id: string(row.id), name: string(row.name), prompt: string(row.prompt), settings: {
      model: string(settings.model), effort: string(settings.effort), mode: string(settings.mode) as ExecutionMode,
      ...(settings.pricing !== undefined ? { pricing: settings.pricing as SettingsPreset['pricing'] } : {}),
    } };
  });
}

export function validateQuestionPreset(preset: QuestionPreset, models: Model[]): QuestionPreset {
  const id = preset.id.trim(), name = preset.name.trim(), prompt = preset.prompt.trim();
  if (!id) throw new Error('質問プリセットのIDが必要です。');
  if (!name) throw new Error('質問プリセットの表示名を入力してください。');
  if (!prompt) throw new Error('質問文を入力してください。');
  return { id, name, prompt, settings: validatePreset(preset.settings, models) };
}

export function validateQuestionPresets(value: unknown, models: Model[]): QuestionPreset[] {
  if (!Array.isArray(value)) throw new Error('質問プリセットを配列で指定してください。');
  const ids = new Set<string>();
  return readQuestionPresets(value).map((preset, index) => {
    try {
      const result = validateQuestionPreset(preset, models);
      if (ids.has(result.id)) throw new Error('質問プリセットのIDが重複しています。');
      ids.add(result.id);
      return result;
    } catch (error) { throw new Error(`質問プリセット${index + 1}: ${messageOf(error)}`); }
  });
}

export function questionPresetMessage(preset: QuestionPreset, text: string, source: { title: string; link: string }): string {
  if (!text.trim()) throw new Error('質問する文章を範囲選択してください。');
  // The prefix also keeps a question beginning with / from executing a command.
  const message = `質問: ${preset.prompt}\n\n${selectionReference(text, `会話「${source.title}」`)}元の会話: ${source.link}`;
  if (message.length > 2 * 1024 * 1024) throw new Error('メッセージが大きすぎます。');
  return message;
}
