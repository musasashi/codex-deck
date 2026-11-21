import { isAbsolute } from 'node:path';
import { displayName, version } from '../../package.json';
import { array, object, string, Signal, OPENAI_PROVIDER, type FileReference, type Gateway, type Input, type Item, type JsonObject, type Model, type PendingRequest, type RequestAnswer, type RunSettings, type ServerEvent, type ServiceTier, type Skill, type Thread, type ThreadReference, type Turn, type TurnError, type Usage } from '../core/types';
import { threadDeletionOrder } from '../core/threadDeletion';
import { readRolloutReferences } from './rolloutMetadata';
import { hasSkillMention, permissionMode } from '../core/composer';
import { questionAnswers } from '../core/questions';
import { JsonRpcPeer, requestKey, RpcError, type ServerRequest } from './rpc';
import { TitleGenerator } from './titleGenerator';
import type { TitleRequest } from '../core/types';
import { isExternalModelId } from '../core/settings';
import { assertOpenAIThread, chatGPTRequest, requireChatGPT } from './chatgpt';
import type { ResetCredits, ResetCreditOutcome } from '../core/types';

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`App Server応答に${field}がありません。`);
  return value;
}
function serviceTierOverride(tier?: ServiceTier): JsonObject {
  return tier === 'default' ? { serviceTier: null } : tier === 'fast' ? { serviceTier: 'fast' } : {};
}
function runModel(id?: string): string | undefined {
  if (isExternalModelId(id)) throw new Error('ChatGPTで利用できるモデルを選択してください。');
  return id === 'latest' ? undefined : id;
}
function threadSettings(model?: string, effort?: string, serviceTier?: ServiceTier): JsonObject {
  return { modelProvider: OPENAI_PROVIDER, model: runModel(model), ...serviceTierOverride(serviceTier),
    ...(effort && effort !== 'default' ? { config: { model_reasoning_effort: effort } } : {}) };
}
export function decodeItem(raw: unknown): Item {
  const data = object(raw);
  return { id: requiredString(data.id, 'item.id'), kind: string(data.type, 'unknown'), data };
}
function decodeTurnError(raw: unknown): TurnError {
  const error = object(raw);
  return {
    message: [string(error.message, '実行に失敗しました。'), string(error.additionalDetails)].filter(Boolean).join('\n'),
    kind: typeof error.codexErrorInfo === 'string' ? error.codexErrorInfo : Object.keys(object(error.codexErrorInfo))[0],
  };
}
export function decodeTurn(raw: unknown): Turn {
  const data = object(raw);
  const timing: Pick<Turn, 'startedAt' | 'completedAt' | 'durationMs'> = {};
  for (const field of ['startedAt', 'completedAt', 'durationMs'] as const) {
    const value = data[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) timing[field] = field === 'durationMs' ? value : value * 1000;
  }
  return {
    id: requiredString(data.id, 'turn.id'), status: string(data.status, 'unknown'),
    items: array(data.items).filter(item => typeof object(item).id === 'string').map(decodeItem),
    ...timing,
    ...(data.error ? { error: decodeTurnError(data.error) } : {}),
  };
}
export function decodeThread(raw: unknown): Thread {
  const data = object(raw);
  const status = object(data.status);
  return {
    id: requiredString(data.id, 'thread.id'), title: string(data.name) || string(data.preview).slice(0, 80) || '新規タスク', name: string(data.name) || undefined,
    forkedFromId: string(data.forkedFromId) || undefined, parentThreadId: string(data.parentThreadId) || undefined,
    cwd: string(data.cwd), status: string(status.type, 'unknown'), activeFlags: array(status.activeFlags).filter((v): v is string => typeof v === 'string'),
    turns: array(data.turns).map(decodeTurn), updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : undefined,
    model: string(data.model) || undefined,
    modelProvider: string(data.modelProvider) || undefined, effort: typeof data.reasoningEffort === 'string' ? data.reasoningEffort : undefined,
  };
}
export function decodeUsage(raw: unknown): Usage {
  const data = object(raw);
  const buckets = object(data.rateLimitsByLimitId);
  const rows = Object.keys(buckets).length ? Object.entries(buckets) : [['default', data.rateLimits]] as [string, unknown][];
  const resetSummary = object(data.rateLimitResetCredits);
  let resetCredits: ResetCredits | undefined;
  if (typeof resetSummary.availableCount === 'number' && Number.isSafeInteger(resetSummary.availableCount) && resetSummary.availableCount >= 0) {
    const ids = new Set<string>();
    resetCredits = { availableCount: resetSummary.availableCount,
      credits: Array.isArray(resetSummary.credits) ? resetSummary.credits.flatMap(raw => {
        const credit = object(raw);
        const id = string(credit.id);
        const expiresAt = credit.expiresAt === null ? null : typeof credit.expiresAt === 'number' ? credit.expiresAt * 1000 : NaN;
        if (!id || ids.has(id) || credit.status !== 'available' || credit.resetType !== 'codexRateLimits'
          || (expiresAt !== null && (!Number.isFinite(expiresAt) || !Number.isFinite(new Date(expiresAt).getTime())))) return [];
        ids.add(id);
        return [{ id, title: string(credit.title) || undefined, expiresAt }];
      }) : undefined };
  }
  return { ...(resetCredits ? { resetCredits } : {}), ...(typeof data.accountId === 'string' ? { accountId: data.accountId } : {}), buckets: rows.map(([id, value]) => {
    const bucket = object(value);
    const windows: Usage['buckets'][number]['windows'] = ['primary', 'secondary'].flatMap(key => {
      const window = object(bucket[key]);
      if (typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return [];
      return [{ key, usedPercent: window.usedPercent,
        windowDurationMins: typeof window.windowDurationMins === 'number' && Number.isFinite(window.windowDurationMins) && window.windowDurationMins > 0 ? window.windowDurationMins : undefined,
        resetsAt: typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt) ? window.resetsAt * 1000 : undefined }];
    });
    const individual = object(bucket.individualLimit);
    if (typeof individual.remainingPercent === 'number') windows.push({ key: 'individual', usedPercent: 100 - individual.remainingPercent, resetsAt: typeof individual.resetsAt === 'number' ? individual.resetsAt * 1000 : undefined });
    const credits = object(bucket.credits);
    return {
      id: string(bucket.limitId, id), label: string(bucket.limitName) || string(bucket.limitId, id), windows,
      reached: typeof bucket.rateLimitReachedType === 'string' ? bucket.rateLimitReachedType : undefined,
      reachedKnown: bucket.rateLimitReachedType === null || typeof bucket.rateLimitReachedType === 'string',
      spendControlReached: typeof bucket.spendControlReached === 'boolean' ? bucket.spendControlReached : undefined,
      credits: typeof credits.hasCredits === 'boolean' ? { hasCredits: credits.hasCredits, unlimited: credits.unlimited === true } : undefined,
      complete: windows.length > 0 && ['primary', 'secondary'].every(key => bucket[key] == null || typeof object(bucket[key]).usedPercent === 'number'),
    };
  }) };
}

const decisionLabels: Record<string, string> = { accept: '今回許可', acceptForSession: 'セッション中許可', decline: '拒否', cancel: 'キャンセル' };
const supportedRequests = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'item/permissions/requestApproval', 'mcpServer/elicitation/request']);

export class AppServerClient implements Gateway {
  readonly events = new Signal<ServerEvent>();
  connected = false;
  private peer?: JsonRpcPeer;
  private codexHome?: string;
  private pending = new Map<string, { request: PendingRequest; raw: JsonObject; decisions: unknown[]; resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private subscriptions: (() => void)[] = [];
  private parentThreads = new Map<string, string>();
  private threadDefaults = new Map<string, { model?: string; effort?: string }>();
  private modelList?: Promise<Model[]>;
  private titles?: TitleGenerator;

  async connect(peer: JsonRpcPeer): Promise<void> {
    this.detach();
    this.peer = peer;
    this.titles = new TitleGenerator(peer, () => this.listModels());
    peer.handleRequest = request => this.handleRequest(request);
    this.subscriptions.push(peer.notifications.subscribe(event => {
      try { this.handleNotification(event.method, object(event.params)); }
      catch { this.events.emit({ type: 'warning', message: `App Server通知を解釈できませんでした: ${event.method}` }); }
    }));
    this.subscriptions.push(peer.closed.subscribe(error => {
      this.titles?.dispose();
      this.connected = false;
      this.modelList = undefined;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.events.emit({ type: 'connection', connected: false, message: error.message });
    }));
    const initialized = object(await peer.request('initialize', { clientInfo: { name: 'codex_deck', title: displayName, version }, capabilities: { experimentalApi: true } }));
    if (typeof initialized.codexHome === 'string' && isAbsolute(initialized.codexHome)) this.codexHome = initialized.codexHome;
    peer.notify('initialized');
    this.connected = true;
    this.events.emit({ type: 'connection', connected: true });
  }
  detach(): void {
    this.titles?.dispose(); this.titles = undefined;
    for (const dispose of this.subscriptions) dispose();
    this.subscriptions = [];
    for (const pending of this.pending.values()) pending.reject(new Error('App Server接続を切り替えました。'));
    this.pending.clear();
    this.parentThreads.clear();
    this.threadDefaults.clear();
    this.modelList = undefined;
    this.peer = undefined;
    this.codexHome = undefined;
    this.connected = false;
  }
  private get connection(): JsonRpcPeer {
    if (!this.connected || !this.peer) throw new Error('App Serverに接続していません。再接続してください。');
    return this.peer;
  }
  private async call(method: string, params?: unknown): Promise<JsonObject> {
    return object(await this.connection.request(method, params));
  }
  async startThread(cwd: string, settings: RunSettings = { mode: 'default' }): Promise<Thread> {
    // New threads have no stored history until the first user message.
    return this.threadResult(await chatGPTRequest(this.connection, 'thread/start', {
      ...(cwd ? { cwd } : {}), ...threadSettings(settings.model, settings.effort, settings.serviceTier),
      ...(settings.mode !== 'default' ? {
        sandbox: settings.mode === 'auto-review' ? 'workspace-write' : settings.mode,
        approvalPolicy: settings.mode === 'danger-full-access' ? 'never' : 'on-request',
        approvalsReviewer: settings.mode === 'auto-review' ? 'auto_review' : 'user',
      } : {}),
    }), false);
  }
  async checkThread(threadId: string): Promise<void> {
    if (!this.threadDefaults.has(threadId)) await this.readThreadSummary(threadId);
  }
  private async readThreadSummary(threadId: string): Promise<Thread> {
    const result = await this.call('thread/read', { threadId, includeTurns: false });
    assertOpenAIThread(result);
    const thread = decodeThread(result.thread);
    if (thread.id !== threadId) throw new Error('App Server応答のチャットIDが一致しません。');
    this.rememberThread(thread);
    return thread;
  }
  private rememberThread(thread: Thread): void {
    const previous = this.threadDefaults.get(thread.id);
    this.threadDefaults.set(thread.id, { model: thread.model ?? previous?.model, effort: thread.effort ?? previous?.effort });
  }
  private storedThreadSettings(threadId: string, settings?: RunSettings): JsonObject {
    const defaults = this.threadDefaults.get(threadId);
    // A provider override bypasses Codex's stored-model fallback.
    const model = settings?.model ?? defaults?.model;
    const effort = settings?.effort ?? (settings?.model ? undefined : defaults?.effort);
    return threadSettings(model, effort, settings?.serviceTier);
  }
  async resumeThread(threadId: string, settings?: RunSettings): Promise<Thread> {
    await this.checkThread(threadId);
    return this.threadResult(await chatGPTRequest(this.connection, 'thread/resume', {
      threadId, ...this.storedThreadSettings(threadId, settings),
    }));
  }
  async readThread(threadId: string): Promise<Thread> {
    return this.threadResult(await this.threadRequest('thread/read', threadId, { includeTurns: true }));
  }
  private async threadResult(result: JsonObject, loadHistory = true): Promise<Thread> {
    assertOpenAIThread(result);
    const thread = decodeThread(result.thread);
    thread.instructionSources = array(result.instructionSources).filter((v): v is string => typeof v === 'string');
    if (typeof result.model === 'string') thread.model = result.model;
    if (typeof result.reasoningEffort === 'string') thread.effort = result.reasoningEffort;
    if (result.serviceTier === null || typeof result.serviceTier === 'string') thread.serviceTier = result.serviceTier;
    this.rememberThread(thread);
    thread.permissionMode = permissionMode(object(result.sandbox).type, result.approvalsReviewer, result.approvalPolicy);
    if (loadHistory && (object(result.thread).historyMode === 'paginated' || typeof result.turnsBackwardsCursor === 'string')) {
      const turns = await this.pages('thread/turns/list', { threadId: thread.id, sortDirection: 'asc', itemsView: 'full', limit: 100 });
      thread.turns = turns.map(decodeTurn);
    }
    return thread;
  }
  async listThreads(cursor?: string, archived = false): Promise<{ threads: Thread[]; cursor?: string }> {
    // The default scan-and-repair path rereads thread logs on every history page.
    const result = await this.call('thread/list', { limit: 50, archived, modelProviders: [OPENAI_PROVIDER], useStateDbOnly: true, ...(cursor ? { cursor } : {}) });
    return { threads: array(result.data).filter(value => object(value).modelProvider === OPENAI_PROVIDER).map(decodeThread), cursor: typeof result.nextCursor === 'string' ? result.nextCursor : undefined };
  }
  async listThreadsForDeletion(root: Thread): Promise<Thread[]> {
    if (!this.codexHome) throw new Error('チャットの参照関係を確認できません：App Server応答にCodexの保存先がありません。');
    const references = threadDeletionOrder<ThreadReference>(root, await readRolloutReferences(this.codexHome));
    const threads: Thread[] = [];
    // Read current titles and runtime status only for the affected chats, without resuming them.
    for (const reference of references) {
      const thread = await this.readThreadSummary(reference.id);
      threads.push({ ...thread,
        forkedFromId: reference.forkedFromId ?? thread.forkedFromId,
        parentThreadId: reference.parentThreadId ?? thread.parentThreadId,
        historyBaseThreadId: reference.historyBaseThreadId });
    }
    return threads;
  }
  async forkThread(threadId: string, options: { cwd?: string; lastTurnId?: string; settings?: RunSettings } = {}): Promise<Thread> {
    await this.checkThread(threadId);
    return this.threadResult(await chatGPTRequest(this.connection, 'thread/fork', { threadId,
      ...this.storedThreadSettings(threadId, options.settings),
      ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.lastTurnId ? { lastTurnId: options.lastTurnId } : {}) }));
  }
  private async threadRequest(method: string, threadId: string, params: JsonObject = {}): Promise<JsonObject> {
    await this.checkThread(threadId);
    return this.call(method, { threadId, ...params });
  }
  async renameThread(threadId: string, name: string): Promise<void> { await this.threadRequest('thread/name/set', threadId, { name }); }
  async generateTitle(request: TitleRequest, signal: AbortSignal): Promise<string> {
    if (!this.connected || !this.titles) throw new Error('App Serverに接続していません。');
    return this.titles.generate(request, signal);
  }
  async archiveThread(threadId: string): Promise<void> { await this.threadRequest('thread/archive', threadId); }
  async deleteThread(threadId: string): Promise<void> { await this.threadRequest('thread/delete', threadId); }
  async unarchiveThread(threadId: string): Promise<void> { await this.threadRequest('thread/unarchive', threadId); }
  async compactThread(threadId: string): Promise<void> {
    await this.runOnThread('thread/compact/start', threadId);
  }
  private async runOnThread(method: string, threadId: string, params: JsonObject = {}): Promise<JsonObject> {
    await this.checkThread(threadId);
    return chatGPTRequest(this.connection, method, { threadId, ...params });
  }
  private encodeInput(input: Input[]): JsonObject[] {
    const mentions: Input[] = input.filter(item => item.type === 'skill' && item.name && !input.some(text => text.type === 'text' && hasSkillMention(text.text ?? '', item.name!)))
      .map(item => ({ type: 'text', text: `$${item.name}` }));
    return [...input, ...mentions].map(item => ({ ...item, ...(item.type === 'text' ? { text_elements: [] } : {}) }));
  }
  async startTurn(threadId: string, input: Input[], settings: RunSettings, clientId: string): Promise<Turn> {
    await this.checkThread(threadId);
    const model = runModel(settings.model);
    const defaults = this.threadDefaults.get(threadId);
    const effort = settings.effort === 'default' ? undefined : settings.effort ?? defaults?.effort;
    const collaborationMode = settings.collaborationMode ? { mode: settings.collaborationMode, settings: {
      model: requiredString(model ?? defaults?.model, 'プランモードのモデル'),
      reasoning_effort: effort ?? null, developer_instructions: null,
    } } : undefined;
    const sandbox = settings.mode === 'default' ? undefined : settings.mode === 'read-only' ? { type: 'readOnly', networkAccess: false }
      : settings.mode === 'workspace-write' || settings.mode === 'auto-review' ? { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
      : { type: 'dangerFullAccess' };
    const result = await chatGPTRequest(this.connection, 'turn/start', {
      threadId, input: this.encodeInput(input), clientUserMessageId: clientId,
      ...serviceTierOverride(settings.serviceTier), ...(model ? { model } : {}),
      ...(settings.effort && settings.effort !== 'default' ? { effort: settings.effort } : {}),
      ...(sandbox ? { sandboxPolicy: sandbox, approvalPolicy: settings.mode === 'danger-full-access' ? 'never' : 'on-request', approvalsReviewer: settings.mode === 'auto-review' ? 'auto_review' : 'user' } : {}),
      ...(collaborationMode ? { collaborationMode } : {}),
    });
    this.threadDefaults.set(threadId, { model: model ?? defaults?.model, effort });
    return decodeTurn(result.turn);
  }
  async steerTurn(threadId: string, turnId: string, input: Input[]): Promise<void> { await this.runOnThread('turn/steer', threadId, { expectedTurnId: turnId, input: this.encodeInput(input) }); }
  async interruptTurn(threadId: string, turnId: string): Promise<void> { await this.threadRequest('turn/interrupt', threadId, { turnId }); }
  async review(threadId: string, target: JsonObject): Promise<Turn> { return decodeTurn((await this.runOnThread('review/start', threadId, { target, delivery: 'inline' })).turn); }
  async readUsage(): Promise<Usage> { return decodeUsage(await chatGPTRequest(this.connection, 'account/rateLimits/read', {})); }
  async consumeResetCredit(creditId: string, idempotencyKey: string): Promise<ResetCreditOutcome> {
    const { outcome } = await chatGPTRequest(this.connection, 'account/rateLimitResetCredit/consume', { creditId, idempotencyKey });
    if (outcome !== 'reset' && outcome !== 'nothingToReset' && outcome !== 'noCredit' && outcome !== 'alreadyRedeemed')
      throw new Error('チケットの使用結果を確認できませんでした。残数を確認してください。');
    return outcome;
  }
  async listModels(forceReload = false): Promise<Model[]> {
    if (forceReload) this.modelList = undefined;
    const listing = this.modelList ??= this.loadModels();
    try {
      const models = await listing;
      // A refresh or account change may supersede an in-flight catalog read.
      return this.modelList === listing ? models : this.listModels();
    } catch (error) {
      if (this.modelList === listing) this.modelList = undefined;
      throw error;
    }
  }
  private async loadModels(): Promise<Model[]> {
    await requireChatGPT(this.connection);
    return (await this.pages('model/list', { modelProvider: OPENAI_PROVIDER, includeHidden: false, limit: 100 })).map(value => {
      const data = object(value);
      return { id: requiredString(data.model, 'model'), label: string(data.displayName, string(data.model)), description: string(data.description),
        efforts: array(data.supportedReasoningEfforts).map(value => ({ id: string(object(value).reasoningEffort), description: string(object(value).description) })).filter(value => value.id),
        defaultEffort: string(data.defaultReasoningEffort), isDefault: data.isDefault === true, upgrade: string(data.upgrade) || string(object(data.upgradeInfo).model) || undefined,
        inputModalities: array(data.inputModalities).filter((v): v is string => typeof v === 'string') };
    });
  }
  async account(): Promise<JsonObject> { return this.call('account/read', { refreshToken: false }); }
  async login(type: 'chatgpt' | 'chatgptDeviceCode'): Promise<JsonObject> { return this.call('account/login/start', { type }); }
  async cancelLogin(loginId: string): Promise<void> { await this.call('account/login/cancel', { loginId }); }
  async logout(): Promise<void> { await this.call('account/logout'); this.modelList = undefined; }
  async readConfig(cwd?: string): Promise<JsonObject> { return this.call('config/read', { includeLayers: false, ...(cwd ? { cwd } : {}) }); }
  async writeConfig(keyPath: string, value: unknown): Promise<void> { await this.call('config/value/write', { keyPath, value, mergeStrategy: 'replace' }); }
  async listSkills(cwd: string, forceReload = false): Promise<Skill[]> {
    const result = await this.call('skills/list', { cwds: [cwd], forceReload });
    const seen = new Set<string>();
    return array(result.data).flatMap(value => array(object(value).skills)).flatMap(raw => {
      const skill = object(raw);
      const name = string(skill.name), path = string(skill.path);
      if (!name || !path || skill.enabled === false || seen.has(path)) return [];
      seen.add(path);
      return [{ name, path, scope: string(skill.scope), description: string(object(skill.interface).shortDescription) || string(skill.shortDescription) || string(skill.description) }];
    });
  }
  async searchFiles(cwd: string, query: string): Promise<FileReference[]> {
    const result = await this.call('fuzzyFileSearch', { query, roots: [cwd], cancellationToken: null });
    return array(result.files).flatMap(raw => {
      const file = object(raw);
      const path = string(file.path);
      if (!path) return [];
      return [{ path, kind: file.match_type === 'directory' ? 'directory' as const : 'file' as const }];
    }).slice(0, 50);
  }
  async listMcp(): Promise<unknown[]> { return this.pages('mcpServerStatus/list', { limit: 100 }); }
  async loginMcp(name: string): Promise<JsonObject> { return this.call('mcpServer/oauth/login', { name }); }
  async reloadMcp(): Promise<void> { await this.call('config/mcpServer/reload'); }
  private async pages(method: string, params: JsonObject): Promise<unknown[]> {
    const rows: unknown[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.call(method, { ...params, ...(cursor ? { cursor } : {}) });
      rows.push(...array(result.data));
      cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
      if (cursor && seen.has(cursor)) throw new Error(`${method}が同じページを返しました。`);
      if (cursor) seen.add(cursor);
    } while (cursor);
    return rows;
  }
  private handleRequest(incoming: ServerRequest): Promise<unknown> {
    if (!supportedRequests.has(incoming.method)) return Promise.reject(new RpcError(-32601, `Unsupported server request: ${incoming.method}`));
    const raw = object(incoming.params);
    const originalThreadId = string(raw.threadId);
    if (this.titles?.threadIds.has(originalThreadId)) return Promise.reject(new RpcError(-32602, 'Title generation does not accept tool requests'));
    const threadId = this.parentThreads.get(originalThreadId) ?? originalThreadId;
    if (!threadId) return Promise.reject(new RpcError(-32602, 'Server request has no threadId'));
    const id = requestKey(incoming.id);
    const kind: PendingRequest['kind'] = incoming.method.includes('requestUserInput') ? 'questions' : incoming.method.includes('/permissions/') ? 'permissions' : incoming.method.includes('elicitation') ? 'elicitation' : 'approval';
    const decisions = kind === 'approval' ? (Array.isArray(raw.availableDecisions) ? raw.availableDecisions : ['accept', 'acceptForSession', 'decline', 'cancel']) : [];
    const request: PendingRequest = {
      id, threadId, turnId: typeof raw.turnId === 'string' ? raw.turnId : undefined, kind, blocking: raw.isBlocking !== false,
      title: kind === 'questions' ? 'Codexからの質問' : kind === 'permissions' ? '追加権限のリクエスト' : kind === 'elicitation' ? `MCP: ${string(raw.serverName)}` : raw.networkApprovalContext ? 'ネットワーク接続の承認' : incoming.method.includes('fileChange') ? 'ファイル変更の承認' : 'コマンド実行の承認',
      detail: [string(raw.reason), string(raw.message), string(raw.command), string(raw.cwd), raw.networkApprovalContext ? JSON.stringify(raw.networkApprovalContext, null, 2) : '', raw.permissions ? JSON.stringify(raw.permissions, null, 2) : '', string(raw.grantRoot)].filter(Boolean).join('\n'),
      choices: kind === 'permissions' ? ['今回許可', 'セッション中許可', '拒否'] : kind === 'elicitation' ? ['回答を送信', '拒否', 'キャンセル'] : decisions.map(value => typeof value === 'string' ? decisionLabels[value] ?? value : JSON.stringify(value)),
      ...(kind === 'questions' ? { questions: array(raw.questions).map(value => { const q = object(value); return { id: string(q.id), header: string(q.header), question: string(q.question), secret: q.isSecret === true, options: array(q.options).map(v => ({ label: string(object(v).label), description: string(object(v).description) })) }; }) } : {}),
      ...(kind === 'elicitation' ? { schema: object(raw.requestedSchema), url: typeof raw.url === 'string' ? raw.url : undefined } : {}),
    };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { request, raw, decisions, resolve, reject });
      this.events.emit({ type: 'request', request });
    });
  }
  answerRequest(id: string, threadId: string, answer: RequestAnswer): void {
    const pending = this.pending.get(id);
    if (!pending || pending.request.threadId !== threadId) throw new Error('このリクエストはすでに解決済みです。');
    let response: unknown;
    const choice = answer.choice;
    switch (pending.request.kind) {
      case 'approval':
        if (!Number.isInteger(choice) || choice! < 0 || choice! >= pending.decisions.length) throw new Error('承認操作を選択してください。');
        response = { decision: pending.decisions[choice!] };
        break;
      case 'permissions':
        if (choice !== 0 && choice !== 1 && choice !== 2) throw new Error('権限操作を選択してください。');
        response = { permissions: choice === 2 ? {} : Object.fromEntries(Object.entries(object(pending.raw.permissions)).filter(([, value]) => value != null)), scope: choice === 1 ? 'session' : 'turn' };
        break;
      case 'questions': {
        const answers: Record<string, { answers: string[] }> = Object.create(null) as Record<string, { answers: string[] }>;
        for (const [id, values] of Object.entries(questionAnswers(pending.request, answer))) answers[id] = { answers: values };
        response = { answers };
        break;
      }
      case 'elicitation':
        if (choice !== 0 && choice !== 1 && choice !== 2) throw new Error('回答操作を選択してください。');
        response = { action: choice === 0 ? 'accept' : choice === 1 ? 'decline' : 'cancel', content: choice === 0 ? answer.content ?? null : null };
    }
    this.pending.delete(id);
    pending.resolve(response);
    this.events.emit({ type: 'resolved', threadId, requestId: id });
  }
  rejectRequest(id: string, message: string): void {
    this.pending.get(id)?.reject(new RpcError(-32602, message));
    this.pending.delete(id);
  }
  private handleNotification(method: string, data: JsonObject): void {
    const threadId = string(data.threadId);
    if (this.titles?.threadIds.has(threadId)) return;
    const turnId = string(data.turnId);
    switch (method) {
      case 'thread/started': {
        const thread = object(data.thread);
        const parent = string(thread.parentThreadId);
        if (parent && typeof thread.id === 'string') this.parentThreads.set(thread.id, this.parentThreads.get(parent) ?? parent);
        break;
      }
      case 'turn/started': case 'turn/completed': this.events.emit({ type: 'turn', threadId, turn: decodeTurn(data.turn), completed: method === 'turn/completed' }); break;
      case 'error': this.events.emit({ type: 'error', threadId, turnId, error: decodeTurnError(data.error), willRetry: data.willRetry === true }); break;
      case 'item/started': case 'item/completed': this.events.emit({ type: 'item', threadId, turnId, item: decodeItem(data.item), completed: method === 'item/completed' }); break;
      case 'thread/status/changed': this.events.emit({ type: 'status', threadId, status: string(object(data.status).type), flags: array(object(data.status).activeFlags).map(v => string(v)) }); break;
      case 'thread/name/updated': this.events.emit({ type: 'name', threadId, title: string(data.threadName) || string(data.name) }); break;
      case 'turn/diff/updated': this.events.emit({ type: 'diff', threadId, turnId, diff: string(data.diff) }); break;
      case 'turn/plan/updated': this.events.emit({ type: 'plan', threadId, turnId, explanation: string(data.explanation), steps: array(data.plan).map(v => ({ step: string(object(v).step), status: string(object(v).status) })) }); break;
      case 'account/rateLimits/updated': this.events.emit({ type: 'usage' }); break;
      case 'skills/changed': this.events.emit({ type: 'skills' }); break;
      case 'account/updated': this.modelList = undefined; this.events.emit({ type: 'account' }); break;
      case 'account/login/completed': this.modelList = undefined; this.events.emit({ type: 'account', success: data.success === true, error: typeof data.error === 'string' ? data.error : undefined }); break;
      case 'thread/tokenUsage/updated': this.events.emit({ type: 'tokens', threadId, value: data.tokenUsage }); break;
      case 'thread/archived': this.events.emit({ type: 'archived', threadId }); break;
      case 'thread/deleted': this.threadDefaults.delete(threadId); this.events.emit({ type: 'deleted', threadId }); break;
      case 'serverRequest/resolved': {
        if (typeof data.requestId !== 'string' && typeof data.requestId !== 'number') break;
        const id = requestKey(data.requestId);
        this.pending.get(id)?.reject(new RpcError(-32800, 'Request resolved by server'));
        this.pending.delete(id);
        this.events.emit({ type: 'resolved', threadId: this.parentThreads.get(threadId) ?? threadId, requestId: id });
        break;
      }
      case 'warning': case 'configWarning': this.events.emit({ type: 'warning', threadId: threadId || undefined, message: string(data.message) || string(data.summary) }); break;
      default: {
        const deltaTypes: Record<string, [string, string]> = {
          'item/agentMessage/delta': ['agentMessage', 'text'], 'item/plan/delta': ['plan', 'text'],
          'item/reasoning/summaryTextDelta': ['reasoning', 'summary'], 'item/reasoning/textDelta': ['reasoning', 'content'],
          'item/commandExecution/outputDelta': ['commandExecution', 'aggregatedOutput'],
        };
        const fields = deltaTypes[method];
        if (fields) this.events.emit({ type: 'delta', threadId, turnId, itemId: string(data.itemId), kind: fields[0], field: fields[1], text: string(data.delta), index: typeof data.summaryIndex === 'number' ? data.summaryIndex : typeof data.contentIndex === 'number' ? data.contentIndex : undefined });
        // Unknown notifications are deliberately ignored. Only completed turns can schedule continuation.
      }
    }
  }
}
