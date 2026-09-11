import { resolveRunSettings, resolveTitleEffort, selectedModel } from '../core/settings';
import { parseTitle, TITLE_INSTRUCTIONS, TITLE_SCHEMA } from '../core/taskTitle';
import { array, object, string, type JsonObject, type Model, type TitleRequest } from '../core/types';
import type { JsonRpcPeer } from './rpc';
import { HF_MODEL_CONFIG, isHuggingFaceModel, modelRequest } from '../core/huggingFace';

/** Short, isolated inference jobs. Their events never enter the task UI. */
export class TitleGenerator {
  readonly threadIds = new Set<string>();
  onTokenUsage?: (request: TitleRequest, sourceId: string, usage: unknown, turnId: string) => void;
  private controllers = new Set<AbortController>();

  constructor(private readonly peer: JsonRpcPeer, private readonly models: () => Promise<Model[]>, private readonly timeoutMs = 30_000) {}

  async generate(request: TitleRequest, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const controller = new AbortController();
    this.controllers.add(controller);
    const cancel = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('タスク名の要約がタイムアウトしました。')), this.timeoutMs);
    let abort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([this.run(request, controller.signal), aborted]); }
    finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      controller.signal.removeEventListener('abort', abort);
      this.controllers.delete(controller);
    }
  }

  private async run(request: TitleRequest, signal: AbortSignal): Promise<string> {
    let threadId: string | undefined;
    let turnId: string | undefined;
    let finished = false;
    const messages = new Map<string, JsonObject>();
    let resolve!: (title: string) => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<string>((a, b) => { resolve = a; reject = b; });
    // Completion or cancellation may arrive before the turn/start response.
    void completion.catch(() => undefined);
    const acceptTurn = (turn: JsonObject): void => {
      turnId = string(turn.id) || turnId;
      if (turn.status === 'inProgress') return;
      finished = true;
      if (turn.status !== 'completed') { reject(new Error('タスク名の要約を完了できませんでした。')); return; }
      for (const item of array(turn.items).map(object)) if (item.type === 'agentMessage') messages.set(string(item.id), item);
      const responses = [...messages.values()].filter(item => item.phase !== 'commentary');
      try { resolve(parseTitle(string(responses.at(-1)?.text))); }
      catch (error) { reject(error); }
    };
    const unsubscribe = this.peer.notifications.subscribe(event => {
      const data = object(event.params);
      if (!threadId || data.threadId !== threadId) return;
      if (event.method === 'thread/tokenUsage/updated') this.onTokenUsage?.(request, threadId, data.tokenUsage, string(data.turnId));
      else if (event.method === 'turn/started' || event.method === 'turn/completed') acceptTurn(object(data.turn));
      else if (event.method === 'item/completed') {
        const item = object(data.item);
        if (item.type === 'agentMessage') messages.set(string(item.id), item);
      } else if (event.method === 'item/agentMessage/delta') {
        const id = string(data.itemId);
        messages.set(id, { ...messages.get(id), text: string(messages.get(id)?.text) + string(data.delta) });
      } else if (event.method === 'error' && data.willRetry !== true) reject(new Error('タスク名の要約に失敗しました。'));
    });
    const closed = this.peer.closed.subscribe(reject);
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    try {
      const [models, rawConfig] = await Promise.all([isHuggingFaceModel(request.model) ? [] : this.models(), this.peer.request('config/read', { cwd: request.cwd, includeLayers: false })]);
      signal.throwIfAborted();
      const effort = resolveTitleEffort(request.effort, selectedModel(models, request.model));
      const settings = resolveRunSettings({ model: request.model, effort, mode: 'read-only' }, models);
      const servers = object(object(rawConfig).config).mcp_servers;
      const result = object(await this.peer.request('thread/start', {
        cwd: request.cwd, ...modelRequest(settings.model), ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
        ...(isHuggingFaceModel(settings.model) ? { serviceTier: null } : {}),
        baseInstructions: TITLE_INSTRUCTIONS + (isHuggingFaceModel(settings.model) ? '\nReturn only a JSON object in the form {"title":"..."}.' : ''), developerInstructions: '',
        config: {
          model_reasoning_effort: settings.effort, project_doc_max_bytes: 0, web_search: 'disabled',
          ...(isHuggingFaceModel(settings.model) ? HF_MODEL_CONFIG : {}),
          'features.apps': false, 'features.plugins': false, 'features.hooks': false, 'features.memories': false,
          'features.multi_agent': false, 'features.multi_agent_v2': false, 'features.shell_tool': false, 'features.shell_snapshot': false,
          'tools.view_image': false,
          mcp_servers: Object.fromEntries(Object.keys(object(servers)).map(id => [id, { enabled: false, required: false }])),
        },
      }));
      threadId = string(object(result.thread).id);
      if (!threadId) throw new Error('要約用の会話を作成できませんでした。');
      this.threadIds.add(threadId);
      signal.throwIfAborted();
      const started = object(await this.peer.request('turn/start', {
        threadId, input: [{ type: 'text', text: request.input, text_elements: [] }],
        ...(isHuggingFaceModel(settings.model) ? {} : { outputSchema: TITLE_SCHEMA }),
      }));
      acceptTurn(object(started.turn));
      signal.throwIfAborted();
      return await completion;
    } finally {
      unsubscribe(); closed(); signal.removeEventListener('abort', abort);
      // Late start responses still reach here, so timed-out jobs are also released.
      if (threadId) {
        const id = threadId;
        void (async () => {
          if (turnId && !finished) await this.peer.request('turn/interrupt', { threadId: id, turnId }).catch(() => undefined);
          await this.peer.request('thread/unsubscribe', { threadId: id }).catch(() => undefined);
          this.threadIds.delete(id);
        })();
      }
    }
  }

  dispose(): void { for (const controller of this.controllers) controller.abort(new Error('App Serverとの接続が終了しました。')); }
}
