import { HF_API_URL } from '../core/huggingFace';
import type { HuggingFaceCheck, HuggingFaceCheckPurpose } from '../core/huggingFaceCheck';
import { ResponsesProxy } from './responsesProxy';
import { huggingFaceRequest } from './huggingFaceWire';
import { checkHuggingFaceModel } from './huggingFaceCheck';

export class HuggingFaceProxy extends ResponsesProxy {
  constructor(upstream = HF_API_URL) { super(upstream, huggingFaceRequest, 'HF'); }
  async check(model: string, purpose: HuggingFaceCheckPurpose, signal: AbortSignal, progress: (check: HuggingFaceCheck) => void): Promise<HuggingFaceCheck> {
    if (!this.request) return { model, purpose, status: 'failed', message: 'HF_TOKENを設定してウィンドウを再読み込みしてください。' };
    return checkHuggingFaceModel(model, purpose, this.request, signal, progress);
  }
}
