import { randomUUID } from 'node:crypto';
import { evaluateUsage } from './usage';
import { readTitleEffort, resolveRunSettings } from './settings';
import { isHuggingFaceModel, isHuggingFaceTask } from './huggingFace';
import { isExternalModel, isExternalTask, sameTaskProvider } from './providers';
import { addTaskCost, emptyTaskCost, type TokenPrice } from './cost';
import { messageQuestions, questionAnswerText } from './questions';
import { referencedTaskInput } from './taskReferences';
import { FORK_TITLE, provisionalTitle, titleInput } from './taskTitle';
import { array, object, string, messageOf, isTaskRunning, Signal, type Attachment, type CollaborationMode, type Gateway, type Input, type PendingRequest, type RequestAnswer, type RunSettings, type ServerEvent, type Task, type TaskRecord, type Thread, type TitleSource, type Turn, type Usage } from './types';

export const CONTINUE_MESSAGE = '使用量上限で中断した作業を直前の状態から続行してください。';
const POLL_MS = 10 * 60 * 1000;
export interface TaskStore { save(records: TaskRecord[]): Promise<void> }
export interface ManagerOptions { now?: () => number; schedule?: boolean; titleModel?: (cwd: string) => string; titleEffort?: (cwd: string) => string; titlePricing?: (cwd: string) => TokenPrice | undefined; referenceTempRoot?: string }

export class TaskManager {
  readonly changed = new Signal<Task | undefined>();
  readonly attention = new Signal<Task>();
  readonly errors = new Signal<string>();
  readonly tasks = new Map<string, Task>();
  usage?: Usage;
  private byThread = new Map<string, Task>();
  private operations = new Map<string, Promise<unknown>>();
  private hydrations = new Map<string, ServerEvent[]>();
  private loading = new Map<string, Promise<void>>();
  private threadStarts = new Map<string, Promise<string>>();
  private titleJobs = new Map<string, AbortController>();
  private titleWrites = new Map<string, Promise<void>>();
  private pendingTitles = new Map<string, { name: string; source: TitleSource }>();
  private epochs = new Map<string, number>();
  private saveTail: Promise<void> = Promise.resolve();
  private usageFlight?: Promise<void>;
  private usageAgain = false;
  private usageEpoch = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private unsubscribe: () => void;
  private now: () => number;

  constructor(readonly gateway: Gateway, private readonly store: TaskStore, records: TaskRecord[] = [], private readonly options: ManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    for (const record of records) {
      const task = this.fromRecord(record);
      this.tasks.set(task.id, task);
      if (task.threadId) this.byThread.set(task.threadId, task);
    }
    this.unsubscribe = gateway.events.subscribe(event => this.onEvent(event));
  }
  private fromRecord(record: TaskRecord): Task {
    let titleSource = record.titleSource ?? (record.threadId ? 'existing' : 'provisional');
    // Recover forks whose placeholder was saved after an unsuccessful summary.
    if (record.threadId && record.title === FORK_TITLE && (titleSource === 'provisional' || titleSource === 'existing')) titleSource = 'fork';
    return { ...structuredClone(record), titleSource, status: record.threadId ? 'disconnected' : 'idle', turns: [], requests: [], attachments: [], busy: false, hydrated: !record.threadId, instructionSources: [] };
  }
  get openTasks(): Task[] { return [...this.tasks.values()].filter(task => task.open); }
  get(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error('タスクが見つかりません。');
    return task;
  }
  create(cwd: string, settings: RunSettings = { mode: 'default' }): Task {
    const task = this.fromRecord({ id: randomUUID(), title: '新規タスク', cwd, open: true, autoResume: false, claims: [], settings });
    if (isExternalTask(task)) task.cost = emptyTaskCost();
    this.tasks.set(task.id, task);
    this.touch(task, true);
    this.armTimer(true);
    return task;
  }
  openThread(threadId: string, title = 'タスク', cwd = ''): Task {
    let task = this.byThread.get(threadId);
    if (!task) {
      task = this.fromRecord({ id: randomUUID(), threadId, title, cwd, open: true, autoResume: false, claims: [], settings: { mode: 'default' } });
      this.tasks.set(task.id, task);
      this.byThread.set(threadId, task);
    }
    task.open = true;
    this.touch(task, true);
    this.armTimer(true);
    return task;
  }
  adoptThread(thread: Thread): Task {
    const task = this.openThread(thread.id, thread.title, thread.cwd);
    this.applyThread(task, thread);
    this.touch(task, true);
    return task;
  }
  async fork(id: string, lastTurnId?: string): Promise<Task> {
    const source = this.get(id);
    const threadId = await this.ensureThread(source);
    const settings = { ...source.settings, model: source.settings.model ?? source.effectiveModel,
      effort: isExternalTask(source) ? source.settings.effort : source.settings.effort ?? source.effectiveEffort };
    const thread = await this.gateway.forkThread(threadId, { lastTurnId, settings });
    const task = this.adoptThread({ ...thread, name: undefined, title: FORK_TITLE });
    if (isExternalTask(task)) {
      task.settings = { ...settings };
      task.effectiveEffort = settings.effort === 'default' ? undefined : settings.effort;
      task.cost = emptyTaskCost(false, thread.turns.map(turn => turn.id));
    }
    if (source.settings.collaborationMode) task.settings.collaborationMode = source.settings.collaborationMode;
    task.titleSource = 'fork';
    // Persist the fallback so history and reloads also stop using the inherited name.
    try { await this.writeTitle(task, task.title, 'fork'); }
    catch (error) { this.errors.emit(`分岐先のタスク名を保存できません: ${messageOf(error)}`); }
    this.touch(task, true);
    return task;
  }
  open(id: string): void { const task = this.get(id); task.open = true; this.touch(task, true); this.armTimer(true); }
  markRead(id: string, turnId: string): void {
    const task = this.get(id);
    if (task.unreadTurnId !== turnId) return;
    task.unreadTurnId = undefined;
    this.touch(task, true);
  }
  close(id: string): void {
    const task = this.get(id);
    this.cancel(task);
    task.autoResume = false;
    task.open = false;
    if (task.lastTurn) task.suppressedTurnId = task.lastTurn.id;
    this.touch(task, true);
    this.armTimer();
    // Keep the subscription and running turn alive after the tab closes.
  }
  async restore(id: string): Promise<void> {
    const existing = this.loading.get(id);
    if (existing) return existing;
    const task = this.get(id);
    if (!task.threadId || task.hydrated) return;
    const threadId = task.threadId;
    const run = (async () => {
      this.hydrations.set(threadId, []);
      try {
        const thread = await this.gateway.resumeThread(threadId, task.settings);
        this.applyThread(task, thread);
        const queued = this.hydrations.get(threadId) ?? [];
        this.hydrations.delete(threadId);
        for (const event of queued) this.onEvent(event);
        this.touch(task, true);
        this.armTimer(true);
      } catch (error) {
        const queued = this.hydrations.get(threadId) ?? [];
        this.hydrations.delete(threadId);
        for (const event of queued) this.onEvent(event);
        task.status = 'error'; task.error = messageOf(error); task.hydrated = false;
        this.touch(task);
        throw error;
      }
    })();
    this.loading.set(id, run);
    try { await run; } finally { this.loading.delete(id); }
  }
  private applyThread(task: Task, thread: Thread): void {
    task.threadId = thread.id;
    this.byThread.set(thread.id, task);
    if (thread.name) {
      if ((task.title !== thread.name || task.titleSource === 'provisional') && this.pendingTitles.get(task.id)?.name !== thread.name) {
        this.cancelTitle(task.id); task.titleSource = 'existing';
      }
      task.title = thread.name;
    } else if (task.titleSource === 'existing' || (task.titleSource === 'provisional' && !task.titleGenerationAttempted)) task.title = thread.title;
    task.cwd = thread.cwd || task.cwd;
    task.turns = thread.turns;
    task.instructionSources = thread.instructionSources ?? task.instructionSources;
    task.effectiveModel = thread.model;
    task.modelProvider = thread.modelProvider ?? task.modelProvider;
    if (!task.settings.model && isExternalModel(thread.model)) task.settings.model = thread.model;
    if (isExternalTask(task)) { task.autoResume = false; this.cancel(task); task.cost ??= emptyTaskCost(thread.turns.length > 0, thread.turns.map(turn => turn.id)); }
    if (isHuggingFaceTask(task)) task.settings.effort = 'default';
    task.effectiveEffort = isExternalTask(task) ? (task.settings.effort === 'default' ? undefined : task.settings.effort) : thread.effort;
    task.effectivePermissionMode = thread.permissionMode ?? task.effectivePermissionMode;
    task.hydrated = true;
    task.error = undefined;
    task.turnError = undefined;
    const last = task.turns.at(-1);
    // Loading history for the first time does not announce old answers as new.
    this.updateLastTurn(task, last, !!task.lastTurn);
    task.activeTurnId = thread.turns.findLast(turn => turn.status === 'inProgress')?.id;
    if (thread.status === 'active') {
      this.cancel(task);
      task.status = thread.activeFlags.includes('waitingOnApproval') ? 'approval' : thread.activeFlags.includes('waitingOnUserInput') ? 'input' : 'running';
    } else if (last?.status === 'inProgress') {
      // A stopped stdio process cannot continue its old in-flight turn after a restart.
      task.activeTurnId = undefined;
      this.cancel(task);
      task.status = 'idle';
    } else if (last) {
      if (task.waiting?.turnId !== last.id) this.cancel(task);
      this.setFinishedState(task, last);
    } else {
      this.cancel(task);
      task.status = 'idle';
    }
    this.syncMessageQuestions(task);
  }
  private cancel(task: Task): void {
    task.waiting = undefined;
    task.recoveryAt = undefined;
    this.epochs.set(task.id, (this.epochs.get(task.id) ?? 0) + 1);
    if (task.status === 'waiting') task.status = 'limited';
    this.armTimer();
  }
  setAutoResume(id: string, enabled: boolean): void {
    const task = this.get(id);
    task.autoResume = enabled && task.open && !isExternalTask(task);
    if (!task.autoResume) this.cancel(task);
    else if (task.lastTurn?.error?.kind === 'usageLimitExceeded' && task.lastTurn.status === 'failed' && !task.activeTurnId && !task.busy && task.hydrated) {
      // Explicitly opting in after a stop is a new user decision.
      task.suppressedTurnId = undefined;
      this.setFinishedState(task, { ...task.lastTurn, items: [] });
    }
    this.touch(task, true);
    this.armTimer(true);
  }
  updateSettings(id: string, settings: RunSettings): void {
    const task = this.get(id);
    if (task.threadId && settings.model && !sameTaskProvider(task, settings.model)) {
      throw new Error('会話の接続先は変更できません。別の接続先を使う場合は新規タスクでプリセットを選択してください。');
    }
    const collaborationMode = settings.collaborationMode ?? task.settings.collaborationMode;
    task.settings = { ...settings, ...(collaborationMode ? { collaborationMode } : {}) };
    if (isExternalTask(task)) { task.autoResume = false; this.cancel(task); task.cost ??= emptyTaskCost(!!task.threadId); }
    this.touch(task, true);
  }
  setCollaborationMode(id: string, mode: CollaborationMode): void {
    const task = this.get(id);
    if (isTaskRunning(task) || task.busy) throw new Error('実行が完了してからプランモードを切り替えてください。');
    this.updateSettings(id, { ...task.settings, collaborationMode: mode });
  }
  async rename(id: string, name: string): Promise<void> {
    const task = this.get(id);
    name = name.trim();
    if (!name) throw new Error('名前を入力してください。');
    this.cancelTitle(id);
    task.titleSource = 'manual';
    this.touch(task, true);
    await this.ensureThread(task);
    await this.writeTitle(task, name, 'manual');
  }
  private cancelTitle(id: string): void {
    this.titleJobs.get(id)?.abort();
    this.titleJobs.delete(id);
  }
  private async writeTitle(task: Task, name: string, source: TitleSource, signal?: AbortSignal): Promise<void> {
    const previous = this.titleWrites.get(task.id);
    const valid = (): boolean => !this.disposed && !signal?.aborted && (source === 'manual' || task.titleSource === 'provisional' || task.titleSource === 'fork');
    const work = (async () => {
      if (previous) await previous.catch(() => undefined);
      if (!valid()) return;
      this.pendingTitles.set(task.id, { name, source });
      try {
        await this.gateway.renameThread(task.threadId!, name);
        if (valid()) { task.title = name; task.titleSource = source; this.touch(task, true); }
      } finally { this.pendingTitles.delete(task.id); }
    })();
    this.titleWrites.set(task.id, work);
    try { await work; }
    finally { if (this.titleWrites.get(task.id) === work) this.titleWrites.delete(task.id); }
  }
  private generateTitle(task: Task, input: string): void {
    if (!this.options.titleModel || this.titleJobs.has(task.id)
      || (task.titleSource !== 'fork' && (task.titleSource !== 'provisional' || task.titleGenerationAttempted))) return;
    task.titleGenerationAttempted = true;
    const controller = new AbortController();
    this.titleJobs.set(task.id, controller);
    void (async () => {
      try {
        await this.checkpoint();
        if (controller.signal.aborted || this.disposed) return;
        const configured = this.options.titleModel!(task.cwd);
        const model = configured === 'latest' && isExternalTask(task) ? task.settings.model ?? task.effectiveModel ?? configured : configured;
        const name = await this.gateway.generateTitle({ cwd: task.cwd, model,
          ...(isExternalModel(model) ? { ownerThreadId: task.threadId, pricing: configured === 'latest' ? task.settings.pricing : this.options.titlePricing?.(task.cwd) } : {}),
          effort: readTitleEffort(this.options.titleEffort?.(task.cwd)), input }, controller.signal);
        await this.writeTitle(task, name, 'generated', controller.signal);
      } catch (error) {
        if (!controller.signal.aborted && !this.disposed) this.errors.emit(`タスク名の要約: ${messageOf(error)}`);
      } finally { if (this.titleJobs.get(task.id) === controller) this.titleJobs.delete(task.id); }
    })();
  }
  attach(id: string, attachment: Attachment): void { const task = this.get(id); task.attachments.push(attachment); this.touch(task); }
  removeAttachment(id: string, attachmentId: string): void { const task = this.get(id); task.attachments = task.attachments.filter(a => a.id !== attachmentId); this.touch(task); }
  private async withOperation<T>(task: Task, action: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(task.id);
    const work = (async () => {
      if (previous) await previous.catch(() => undefined);
      task.busy = true; this.touch(task);
      try { return await action(); }
      finally { task.busy = false; this.touch(task, true); if (task.waiting) this.armTimer(true); }
    })();
    this.operations.set(task.id, work);
    try { return await work; }
    finally { if (this.operations.get(task.id) === work) this.operations.delete(task.id); }
  }
  async ensureThread(task: Task): Promise<string> {
    const existing = this.threadStarts.get(task.id);
    if (existing) return existing;
    const run = (async () => {
      if (!task.threadId) {
        if (task.settings.model) {
          const models = isHuggingFaceModel(task.settings.model) ? [] : await this.gateway.listModels();
          task.settings = resolveRunSettings(task.settings, models);
          this.touch(task, true);
        }
        const thread = await this.gateway.startThread(task.cwd, task.settings);
        this.applyThread(task, thread);
        await this.checkpoint();
      } else if (!task.hydrated) await this.restore(task.id);
      return task.threadId!;
    })();
    this.threadStarts.set(task.id, run);
    try { return await run; } finally { this.threadStarts.delete(task.id); }
  }
  prepareInput(id: string): void {
    const task = this.get(id);
    this.cancel(task);
    if (task.lastTurn) task.suppressedTurnId = task.lastTurn.id;
    this.touch(task, true);
  }
  async send(id: string, text: string, extraInput: Input[] = [], options: { clientId?: string; attachmentIds?: string[] } = {}): Promise<void> {
    const task = this.get(id);
    const attachments = options.attachmentIds ? task.attachments.filter(attachment => options.attachmentIds!.includes(attachment.id)) : [...task.attachments];
    if (options.attachmentIds?.some(id => !attachments.some(attachment => attachment.id === id))) throw new Error('添付ファイルが見つかりません。追加し直してください。');
    if (!text.trim() && !attachments.length) return;
    this.prepareInput(id);
    const questions = task.requests.filter(request => request.source === 'agentMessage').map(request => request.id);
    const input: Input[] = [...(text.trim() ? [{ type: 'text' as const, text }] : []), ...attachments.map(a => a.input), ...extraInput];
    this.touch(task, true);
    await this.withOperation(task, async () => {
      try {
        input.push(...await referencedTaskInput(text, id => this.gateway.readThread(id), this.options.referenceTempRoot));
        const threadId = await this.ensureThread(task);
        const firstTurn = !task.turns.length && !task.activeTurnId;
        // Capture inherited context before the send adds the new request or a response.
        const nameInput = task.titleSource === 'fork' ? titleInput(text, attachments, task.turns) : firstTurn ? titleInput(text, attachments) : undefined;
        if (firstTurn && task.titleSource === 'provisional') { task.title = provisionalTitle(text, attachments); this.touch(task, true); }
        task.error = undefined;
        if (task.activeTurnId) await this.gateway.steerTurn(threadId, task.activeTurnId, input);
        else {
          const turn = await this.gateway.startTurn(threadId, input, task.settings, options.clientId || randomUUID());
          this.acceptTurn(task, turn, false);
        }
        if (nameInput) this.generateTitle(task, nameInput);
        task.attachments = task.attachments.filter(a => !attachments.some(sent => sent.id === a.id));
        this.resolveMessageQuestions(task, questions);
      } catch (error) {
        task.error = messageOf(error);
        if (!task.activeTurnId && !task.waiting) { task.status = 'error'; task.hydrated = false; }
        throw error;
      }
    });
  }
  async stop(id: string): Promise<void> {
    const task = this.get(id);
    this.cancel(task);
    task.autoResume = false;
    if (task.lastTurn) task.suppressedTurnId = task.lastTurn.id;
    this.touch(task, true);
    await this.withOperation(task, async () => {
      if (!task.threadId) return;
      if (!task.hydrated) await this.restore(id);
      if (task.activeTurnId) {
        task.suppressedTurnId = task.activeTurnId;
        await this.gateway.interruptTurn(task.threadId, task.activeTurnId);
      }
    });
  }
  async runReview(id: string, action: (threadId: string) => Promise<Turn>): Promise<void> {
    const task = this.get(id);
    this.cancel(task);
    if (task.lastTurn) task.suppressedTurnId = task.lastTurn.id;
    await this.withOperation(task, async () => {
      const threadId = await this.ensureThread(task);
      if (task.activeTurnId) throw new Error('実行が完了してからレビューを開始してください。');
      this.acceptTurn(task, await action(threadId), false);
    });
  }
  answer(id: string, requestId: string, answer: RequestAnswer): void | Promise<void> {
    const task = this.get(id);
    const request = task.requests.find(r => r.id === requestId);
    if (!task.threadId || !request) throw new Error('リクエストが見つかりません。');
    if (request.source === 'agentMessage') return this.answerMessageQuestions(task, request, answer);
    this.gateway.answerRequest(requestId, task.threadId, answer);
  }
  private async answerMessageQuestions(task: Task, request: PendingRequest, answer: RequestAnswer): Promise<void> {
    const text = answer.skip === true ? undefined : questionAnswerText(request, answer);
    await this.withOperation(task, async () => {
      if (!task.requests.some(r => r.id === request.id)) throw new Error('この質問はすでに解決済みです。');
      if (text !== undefined) {
        this.prepareInput(task.id);
        const threadId = await this.ensureThread(task);
        const input: Input[] = [{ type: 'text', text }];
        if (task.activeTurnId) await this.gateway.steerTurn(threadId, task.activeTurnId, input);
        else this.acceptTurn(task, await this.gateway.startTurn(threadId, input, task.settings, randomUUID()), false);
      }
      task.error = undefined;
      this.resolveMessageQuestions(task, [request.id]);
    });
  }
  private resolveMessageQuestions(task: Task, ids: string[]): void {
    if (!ids.length) return;
    task.resolvedQuestionIds = [...new Set([...(task.resolvedQuestionIds ?? []), ...ids])];
    this.syncMessageQuestions(task);
  }
  private syncMessageQuestions(task: Task, notify = false): void {
    const requests = messageQuestions(task);
    const added = requests.some(request => !task.requests.some(existing => existing.id === request.id));
    task.requests = [...task.requests.filter(request => request.source !== 'agentMessage'), ...requests];
    if (!task.activeTurnId) {
      if (task.status === 'idle' && requests.length) task.status = 'input';
      else if (task.status === 'input' && !task.requests.length) task.status = 'idle';
    }
    if (notify && added) this.attention.emit(task);
  }
  private setFinishedState(task: Task, turn: Turn): void {
    task.activeTurnId = undefined;
    task.error = turn.error?.message;
    task.turnError = undefined;
    if (turn.status === 'failed' && turn.error?.kind === 'usageLimitExceeded') {
      task.status = 'limited';
      if (!isExternalTask(task) && task.open && task.autoResume && task.suppressedTurnId !== turn.id && !task.claims.some(claim => claim.stoppedTurnId === turn.id)) {
        task.waiting ??= { turnId: turn.id, token: randomUUID() };
        task.status = 'waiting';
        this.armTimer(true);
      } else this.cancel(task);
    } else {
      this.cancel(task);
      task.status = turn.status === 'failed' ? 'error' : 'idle';
    }
  }
  private updateLastTurn(task: Task, turn: Turn | undefined, notify = true): void {
    if (turn?.status !== 'completed') task.unreadTurnId = undefined;
    else if (notify && (task.lastTurn?.id !== turn.id || task.lastTurn.status !== 'completed')) task.unreadTurnId = turn.id;
    task.lastTurn = turn ? { id: turn.id, status: turn.status, error: turn.error } : undefined;
  }
  private acceptTurn(task: Task, incoming: Turn, completed: boolean): void {
    const existing = task.turns.find(turn => turn.id === incoming.id);
    // An acknowledgement/duplicate start can arrive after the completion notification.
    if (existing && existing.status !== 'inProgress' && incoming.status === 'inProgress') return;
    const items = existing?.items ?? [];
    for (const item of incoming.items) {
      const at = items.findIndex(value => value.id === item.id);
      if (at < 0) items.push(item); else items[at] = item;
    }
    const turn: Turn = {
      ...incoming, items,
      startedAt: incoming.startedAt ?? existing?.startedAt,
      completedAt: incoming.completedAt ?? existing?.completedAt,
      durationMs: incoming.durationMs ?? existing?.durationMs,
    };
    if (existing) task.turns[task.turns.indexOf(existing)] = turn; else task.turns.push(turn);
    if (task.turns.at(-1)?.id !== turn.id) return;
    this.updateLastTurn(task, turn);
    if (turn.status === 'inProgress') {
      // A late turn/start acknowledgement must not erase an intervening retry notification.
      if (task.turnError?.turnId !== turn.id) task.turnError = undefined;
      task.effectiveModel = task.settings.model ?? task.effectiveModel;
      task.effectiveEffort = isExternalTask(task) ? (task.settings.effort === 'default' ? undefined : task.settings.effort) : task.settings.effort ?? task.effectiveEffort;
      if (task.settings.mode !== 'default') task.effectivePermissionMode = task.settings.mode;
      this.cancel(task);
      task.activeTurnId = turn.id;
      task.status = this.requestStatus(task);
      task.error = undefined;
    } else {
      task.requests = task.requests.filter(r => r.source === 'agentMessage' || r.turnId !== turn.id);
      this.setFinishedState(task, turn);
    }
    this.syncMessageQuestions(task, true);
    if (completed) this.touch(task, true);
  }
  private requestStatus(task: Task): Task['status'] {
    const blocking = task.requests.filter(r => r.blocking);
    return blocking.some(r => r.kind === 'approval' || r.kind === 'permissions') ? 'approval' : blocking.length ? 'input' : 'running';
  }
  private onEvent(event: ServerEvent): void {
    if (this.disposed) return;
    if (event.type === 'connection') {
      this.usageEpoch++;
      this.usage = undefined;
      if (!event.connected) {
        for (const id of this.titleJobs.keys()) this.cancelTitle(id);
        for (const task of this.tasks.values()) {
          if (!task.threadId) continue;
          task.hydrated = false; task.status = 'disconnected'; task.activeTurnId = undefined; task.requests = []; task.error = event.message; task.turnError = undefined;
          this.touch(task);
        }
      }
      this.armTimer(true); this.changed.emit(undefined); return;
    }
    if (event.type === 'usage') { this.armTimer(true); return; }
    if (event.type === 'account') {
      this.usageEpoch++;
      this.usage = undefined;
      this.armTimer(true); this.changed.emit(undefined); return;
    }
    if (event.type === 'skills') return;
    const threadId = event.type === 'request' ? event.request.threadId : event.threadId;
    if (!threadId) { if (event.type === 'warning') this.errors.emit(event.message); return; }
    const queue = this.hydrations.get(threadId);
    if (queue) { queue.push(event); return; }
    const task = this.byThread.get(threadId);
    if (!task) { if (event.type === 'request') this.gateway.rejectRequest(event.request.id, 'No task is associated with this thread'); return; }
    switch (event.type) {
      case 'turn': this.acceptTurn(task, event.turn, event.completed); break;
      case 'error':
        this.errors.emit(`Codex ${event.willRetry ? '再試行中' : 'エラー'} (${threadId}/${event.turnId}): ${event.error.message}`);
        if (task.activeTurnId !== event.turnId) break;
        task.turnError = { turnId: event.turnId, error: event.error, willRetry: event.willRetry };
        // Retry notifications are progress updates, not completed turns or new submissions.
        break;
      case 'item': case 'delta': {
        if (task.turnError?.willRetry && task.turnError.turnId === event.turnId
          && ['agentMessage', 'reasoning', 'plan'].includes(event.type === 'item' ? event.item.kind : event.kind)
          && (event.type === 'item' || event.text)) task.turnError = undefined;
        let turn = task.turns.find(value => value.id === event.turnId);
        if (!turn) { turn = { id: event.turnId, status: 'inProgress', items: [] }; task.turns.push(turn); }
        const itemId = event.type === 'item' ? event.item.id : event.itemId;
        const at = turn.items.findIndex(item => item.id === itemId);
        if (event.type === 'item') {
          if (at < 0) turn.items.push(event.item); else turn.items[at] = event.item;
          this.syncMessageQuestions(task, true);
        } else {
          let item = turn.items[at];
          if (!item) { item = { id: itemId, kind: event.kind, data: { id: itemId, type: event.kind } }; turn.items.push(item); }
          if (event.field === 'summary' || event.field === 'content') {
            const parts = array(item.data[event.field]).map(v => string(v));
            const index = event.index ?? 0;
            parts[index] = (parts[index] ?? '') + event.text;
            item.data[event.field] = parts;
          } else item.data[event.field] = string(item.data[event.field]) + event.text;
        }
        break;
      }
      case 'status':
        if (event.status === 'active') {
          this.cancel(task);
          task.status = event.flags.includes('waitingOnApproval') ? 'approval' : event.flags.includes('waitingOnUserInput') ? 'input' : 'running';
        } else if (event.status === 'systemError') { this.cancel(task); task.status = 'error'; }
        break;
      case 'request':
        if (!task.requests.some(r => r.id === event.request.id)) task.requests.push(event.request);
        this.cancel(task);
        if (event.request.blocking) task.status = this.requestStatus(task);
        this.attention.emit(task);
        break;
      case 'resolved': task.requests = task.requests.filter(r => r.id !== event.requestId); if (task.activeTurnId) task.status = this.requestStatus(task); break;
      case 'diff': task.diff = event.diff; break;
      case 'plan': task.plan = { explanation: event.explanation, steps: event.steps }; break;
      case 'name': {
        if (!event.title) break;
        const pending = this.pendingTitles.get(task.id);
        if (pending?.name === event.title) {
          if (pending.source !== 'manual' && task.titleSource !== 'provisional' && task.titleSource !== 'fork') break;
          task.title = event.title;
          // Provenance changes when the matching name/set request succeeds.
        } else if (event.title !== task.title || task.titleSource === 'provisional') {
          this.cancelTitle(task.id);
          task.title = event.title; task.titleSource = 'existing';
        }
        this.touch(task, true); break;
      }
      case 'tokens': task.tokenUsage = event.value; break;
      case 'cost':
        if (isExternalTask(task)) { task.cost = addTaskCost(task.cost ?? emptyTaskCost(true), event.sample); this.touch(task, true); }
        break;
      case 'warning': task.error = event.message; break;
      case 'archived': this.cancelTitle(task.id); this.close(task.id); break;
    }
    this.touch(task);
  }
  async checkUsage(): Promise<void> {
    if (this.usageFlight) { this.usageAgain = true; return this.usageFlight; }
    if (!this.gateway.connected || this.disposed) return;
    const run = (async () => {
      do {
        this.usageAgain = false;
        const epoch = this.usageEpoch;
        const reservations = this.openTasks.filter(task => task.waiting && task.hydrated).map(task => ({ task, token: task.waiting!.token }));
        try {
          const usage = await this.gateway.readUsage();
          if (epoch !== this.usageEpoch || !this.gateway.connected || this.disposed) continue;
          this.usage = usage;
          for (const { task, token } of reservations) {
            if (!this.eligible(task, token)) continue;
            const evaluation = evaluateUsage(usage, task.waiting?.blockers, this.now());
            task.waiting!.blockers = evaluation.blockers;
            task.recoveryAt = evaluation.recoveryAt;
            if (evaluation.recovered) await this.continueTask(task, token);
            this.touch(task, true);
          }
        } catch (error) {
          if (epoch !== this.usageEpoch || !this.gateway.connected || this.disposed) continue;
          this.usage = undefined;
          for (const { task, token } of reservations) if (this.eligible(task, token)) { task.error = `使用量の確認に失敗しました: ${messageOf(error)}`; this.touch(task); }
        }
      } while (this.usageAgain && this.gateway.connected && this.openTasks.length && !this.disposed);
      this.changed.emit(undefined);
    })();
    this.usageFlight = run;
    try { await run; }
    finally { this.usageFlight = undefined; this.armTimer(); }
  }
  private eligible(task: Task, token: string): boolean {
    return !this.disposed && this.gateway.connected && task.hydrated && task.open && task.autoResume && task.waiting?.token === token && task.status === 'waiting'
      && !task.activeTurnId && !task.busy && task.requests.length === 0 && task.lastTurn?.id === task.waiting.turnId && task.lastTurn?.error?.kind === 'usageLimitExceeded'
      && !task.claims.some(claim => claim.stoppedTurnId === task.waiting?.turnId);
  }
  private async continueTask(task: Task, token: string): Promise<void> {
    if (!task.threadId || !this.eligible(task, token)) return;
    const current = await this.gateway.readThread(task.threadId);
    if (!this.eligible(task, token)) return;
    const latest = current.turns.at(-1);
    if (current.status === 'active' || current.status === 'systemError' || !latest || latest.id !== task.waiting!.turnId || latest.status !== 'failed' || latest.error?.kind !== 'usageLimitExceeded') {
      this.cancel(task);
      this.applyThread(task, current);
      return;
    }
    const epoch = this.epochs.get(task.id) ?? 0;
    const stoppedTurnId = task.waiting!.turnId;
    const claim = { stoppedTurnId, clientId: randomUUID(), turnId: undefined as string | undefined };
    task.claims.push(claim);
    task.waiting = undefined;
    task.status = 'limited';
    task.recoveryAt = undefined;
    // Commit the send intent before the RPC. After a crash, an uncertain send is never replayed.
    try { await this.checkpoint(); }
    catch (error) { task.status = 'error'; task.error = `自動継続の状態を保存できませんでした: ${messageOf(error)}`; this.touch(task); return; }
    if (this.disposed || !this.gateway.connected || !task.open || !task.autoResume || task.activeTurnId || task.busy || task.requests.length || (this.epochs.get(task.id) ?? 0) !== epoch) return;
    await this.withOperation(task, async () => {
      if (this.disposed || !this.gateway.connected || !task.open || !task.autoResume || task.activeTurnId || task.requests.length || (this.epochs.get(task.id) ?? 0) !== epoch) return;
      try {
        const turn = await this.gateway.startTurn(task.threadId!, [{ type: 'text', text: CONTINUE_MESSAGE }], task.settings, claim.clientId);
        claim.turnId = turn.id;
        this.acceptTurn(task, turn, false);
      } catch (error) {
        task.error = `自動継続の送信結果を確認できませんでした: ${messageOf(error)}`;
        if (!task.activeTurnId && !task.waiting) { task.status = 'error'; task.hydrated = false; }
      }
    });
  }
  private armTimer(immediate = false): void {
    if (this.options.schedule === false || this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.gateway.connected || !this.openTasks.length) return;
    let delay = immediate ? 0 : POLL_MS;
    if (!immediate && this.usage) {
      for (const bucket of this.usage.buckets) {
        for (const window of bucket.windows) {
          if (window.resetsAt && window.resetsAt > this.now()) delay = Math.min(delay, Math.max(1000, window.resetsAt - this.now() + 1000));
        }
      }
    }
    this.timer = setTimeout(() => { this.timer = undefined; void this.checkUsage(); }, delay);
    this.timer.unref?.();
  }
  records(): TaskRecord[] {
    return [...this.tasks.values()].map(task => structuredClone({ id: task.id, threadId: task.threadId, modelProvider: task.modelProvider, title: task.title, cwd: task.cwd, open: task.open, autoResume: task.autoResume,
      titleSource: task.titleSource, titleGenerationAttempted: task.titleGenerationAttempted, cost: task.cost,
      waiting: task.waiting, lastTurn: task.lastTurn, unreadTurnId: task.unreadTurnId, resolvedQuestionIds: task.resolvedQuestionIds, claims: task.claims, suppressedTurnId: task.suppressedTurnId, settings: task.settings }));
  }
  checkpoint(): Promise<void> {
    const records = this.records();
    const save = this.saveTail.catch(() => undefined).then(() => this.store.save(records));
    this.saveTail = save;
    return save;
  }
  flush(): Promise<void> { return this.saveTail; }
  private touch(task: Task, persist = false): void {
    this.changed.emit(task);
    if (persist && !this.disposed) void this.checkpoint().catch(error => this.errors.emit(`タスクの状態を保存できません: ${messageOf(error)}`));
  }
  dispose(): void {
    this.disposed = true;
    for (const id of this.titleJobs.keys()) this.cancelTitle(id);
    this.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
  }
}

export function readTaskRecords(value: unknown): TaskRecord[] {
  const state = object(value);
  if (state.version !== 1) return [];
  return array(state.tasks).filter((value): value is TaskRecord => {
    const row = object(value);
    return typeof row.id === 'string' && typeof row.title === 'string' && typeof row.cwd === 'string' && typeof row.open === 'boolean'
      && typeof row.autoResume === 'boolean' && Array.isArray(row.claims) && typeof object(row.settings).mode === 'string';
  });
}
