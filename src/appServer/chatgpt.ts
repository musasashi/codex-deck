import { object, OPENAI_PROVIDER, UnsupportedThreadError, type JsonObject } from '../core/types';
import type { JsonRpcPeer } from './rpc';

export async function requireChatGPT(peer: JsonRpcPeer): Promise<void> {
  const result = object(await peer.request('account/read', { refreshToken: false }));
  if (object(result.account).type !== 'chatgpt') throw new Error('タスクの「アカウント」からChatGPTでサインインしてください。');
}

export async function chatGPTRequest(peer: JsonRpcPeer, method: string, params: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
  await requireChatGPT(peer);
  signal?.throwIfAborted();
  return object(await peer.request(method, params));
}

export function assertOpenAIThread(result: JsonObject): void {
  if (object(result.thread).modelProvider !== OPENAI_PROVIDER ||
      (result.modelProvider != null && result.modelProvider !== OPENAI_PROVIDER)) throw new UnsupportedThreadError();
}
