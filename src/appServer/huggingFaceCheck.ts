import type { HuggingFaceCheck, HuggingFaceCheckPurpose } from '../core/huggingFaceCheck';
import { checkResponsesModel } from './responsesCheck';

export function checkHuggingFaceModel(model: string, purpose: HuggingFaceCheckPurpose,
  request: (body: Record<string, unknown>, signal: AbortSignal) => Promise<Response>, signal: AbortSignal,
  progress: (check: HuggingFaceCheck) => void = () => {}): Promise<HuggingFaceCheck> {
  return checkResponsesModel(model, purpose, request, signal, progress, { label: 'HF', confirmation: 'HF tool OK', requireUsage: true });
}
