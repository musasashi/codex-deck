import { array, object, string, type JsonObject } from '../core/types';
import { huggingFaceModel, modelRequest } from '../core/huggingFace';
import type { HuggingFaceCheck, HuggingFaceCheckPurpose } from '../core/huggingFaceCheck';
import { parseTitle } from '../core/taskTitle';

type Request = (body: JsonObject, signal: AbortSignal) => Promise<Response>;
const LIMIT = 4 * 1024 * 1024;

/** Only synthetic text and a simulated connectivity tool are sent; no local tools are run. */
export async function checkHuggingFaceModel(model: string, purpose: HuggingFaceCheckPurpose, request: Request,
  signal: AbortSignal, progress: (check: HuggingFaceCheck) => void = () => {}): Promise<HuggingFaceCheck> {
  let stage = '応答・タスク名の要約';
  const update = () => progress({ model, purpose, status: 'checking', message: `${stage}を確認中…` });
  try {
    if (!huggingFaceModel(model)) throw new Error('HFのモデルIDを確認してください。');
    const samples: JsonObject[] = [];
    const call = async (body: JsonObject): Promise<JsonObject> => {
      const timeout = AbortSignal.timeout(45_000);
      const response = await request({ model: modelRequest(model).model, stream: true, max_output_tokens: 1024, ...body }, AbortSignal.any([signal, timeout]));
      if (response.ok && !response.headers.get('content-type')?.includes('text/event-stream')) { await response.body?.cancel(); throw new Error('ストリーミング応答を取得できませんでした。'); }
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let raw = '', size = 0;
      if (reader) try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > LIMIT) { await reader.cancel(); throw new Error('検証応答が大きすぎます。'); }
          raw += decoder.decode(value, { stream: true });
        }
      } finally { reader.releaseLock(); }
      raw += decoder.decode();
      if (!response.ok) {
        let detail = '';
        try { const error = object(JSON.parse(raw)); detail = apiError(error.error) || apiError(error); } catch { /* HTTP status also identifies non-JSON gateway errors. */ }
        throw new Error(`HFがリクエストを拒否しました（HTTP ${response.status}）。${detail}`);
      }
      const events = response.headers.get('content-type')?.includes('text/event-stream')
        ? raw.split(/\r?\n\r?\n/).flatMap(frame => {
          const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          return data && data !== '[DONE]' ? [object(JSON.parse(data))] : [];
        }) : [];
      const result = events.length ? object(events.findLast(event => event.response)?.response) : object(JSON.parse(raw || '{}'));
      const detail = apiError(result.error) || apiError(events.findLast(event => event.type === 'error'));
      if (result.status !== 'completed') throw new Error(detail || (object(result.incomplete_details).reason === 'max_output_tokens'
        ? '検証の出力上限に達しました。短い応答を確認できませんでした。' : '応答が正常に完了しませんでした。'));
      samples.push(object(result.usage));
      return result;
    };
    update();
    const title = await call({ instructions: 'Return only a JSON object with one string field named title. Do not use Markdown.', input: 'Return a short title for an echo connectivity test.' });
    try { parseTitle(textOutput(title)); }
    catch { throw new Error('タスク名の要約に必要なJSON応答を取得できませんでした。'); }
    if (purpose === 'task') {
      stage = 'ツール呼び出し'; update();
      const tools = [{ type: 'namespace', name: 'deck_check', description: 'Connectivity check.', tools: [{ type: 'function', name: 'check_connection',
        description: 'Check the given test text and return a confirmation message.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] }];
      const input = [{ role: 'user', content: 'Call check_connection once with text test. After the tool returns, repeat its confirmation message without calling the tool again.' }];
      const first = await call({ input, tools, tool_choice: 'auto' });
      const calls = array(first.output).map(object).filter(item => item.type === 'function_call');
      if (calls.length !== 1 || calls[0]!.namespace !== 'deck_check' || calls[0]!.name !== 'check_connection' || !string(calls[0]!.call_id)
        || string(object(JSON.parse(string(calls[0]!.arguments, '{}'))).text) !== 'test') throw new Error('指定したツールを正しく呼び出せませんでした。');
      stage = 'ツール結果からの会話継続'; update();
      const second = await call({ tools, tool_choice: 'auto', input: [...input, ...array(first.output),
        { type: 'function_call_output', call_id: calls[0]!.call_id, output: 'HF tool OK' }] });
      if (array(second.output).some(item => object(item).type === 'function_call')) throw new Error('ツールが再度呼び出され、最終回答を確認できませんでした。');
      if (!textOutput(second).includes('HF tool OK')) throw new Error('返却したツール結果を含む回答を確認できませんでした。');
    }
    stage = '利用トークン数'; update();
    if (samples.some(usage => !Number.isSafeInteger(usage.input_tokens) || Number(usage.input_tokens) <= 0
      || !Number.isSafeInteger(usage.output_tokens) || Number(usage.output_tokens) <= 0)) throw new Error('利用トークン数が未取得または0のため、タスクの利用額を計算できません。');
    return { model, purpose, status: 'passed', message: purpose === 'task' ? '利用可：応答・ツール往復・利用トークン数を確認しました。' : '利用可：要約・利用トークン数を確認しました。' };
  } catch (error) {
    const message = signal.aborted ? '確認を中止しました。' : error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      ? '確認がタイムアウトしました。再度お試しください。' : error instanceof Error ? error.message : 'HFへの接続に失敗しました。';
    return { model, purpose, status: 'failed', message: `${stage}：${message.replace(/hf_[A-Za-z0-9_]{8,}/g, '[REDACTED]').slice(0, 800)}` };
  }
}

function textOutput(response: JsonObject): string {
  return array(response.output).map(object).filter(item => item.type === 'message').flatMap(item => array(item.content)).map(part => string(object(part).text)).join('');
}
function apiError(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => apiError(item)).filter(Boolean).join(' / ');
  const error = object(value);
  const path = array(error.path).join('.');
  return `${path ? path + ': ' : ''}${string(error.message)}`;
}
