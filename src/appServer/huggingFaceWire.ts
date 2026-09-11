import type { JsonObject } from '../core/types';
import { responsesRequest } from './responsesWire';

/** HF does not accept returned reasoning items as input or Codex's effort settings. */
export function huggingFaceRequest(raw: JsonObject): ReturnType<typeof responsesRequest> {
  return responsesRequest(raw, { discardReasoning: true, discardReasoningInput: true });
}
