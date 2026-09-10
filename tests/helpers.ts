import { Signal, type Gateway, type Input, type Model, type RequestAnswer, type RunSettings, type ServerEvent, type Thread, type TitleRequest, type Turn, type Usage } from '../src/core/types';

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
export function thread(id = 'thread-1'): Thread { return { id, title: id, cwd: '/project', status: 'idle', activeFlags: [], turns: [] }; }
export function usage(percent: number, resetsAt = 10_000): Usage { return { buckets: [{ id: 'codex', label: 'Codex', windows: [{ key: 'primary', usedPercent: percent, resetsAt }], complete: true, reachedKnown: true }] }; }

export class FakeGateway implements Gateway {
  connected = true;
  events = new Signal<ServerEvent>();
  threads = new Map<string, Thread>();
  sent: { threadId: string; input: Input[]; settings: RunSettings; clientId: string }[] = [];
  steered: { threadId: string; turnId: string; input: Input[] }[] = [];
  interrupted: string[] = [];
  answered: { id: string; threadId: string; answer: RequestAnswer }[] = [];
  limits = usage(20);
  usageReader?: () => Promise<Usage>;
  threadReader?: (threadId: string) => Promise<Thread>;
  turnStarter?: (threadId: string, input: Input[], clientId: string) => Promise<Turn>;
  sequence = 0;
  async startThread(cwd = '/project'): Promise<Thread> { const value = { ...thread(`thread-${++this.sequence}`), cwd }; this.threads.set(value.id, value); return structuredClone(value); }
  async resumeThread(threadId: string): Promise<Thread> { return structuredClone(this.threads.get(threadId)!); }
  async readThread(threadId: string): Promise<Thread> { return this.threadReader ? this.threadReader(threadId) : structuredClone(this.threads.get(threadId)!); }
  async forkThread(threadId: string, options: { lastTurnId?: string } = {}): Promise<Thread> {
    const source = this.threads.get(threadId)!;
    const turns = options.lastTurnId ? source.turns.slice(0, source.turns.findIndex(turn => turn.id === options.lastTurnId) + 1) : source.turns;
    const value = structuredClone({ ...source, id: `fork-${++this.sequence}`, turns });
    this.threads.set(value.id, value);
    return structuredClone(value);
  }
  async listModels(): Promise<Model[]> { return [{ id: 'test-model', label: 'Test model', description: '', efforts: [{ id: 'high', description: '' }], defaultEffort: 'high', isDefault: true, inputModalities: ['text'] }]; }
  async generateTitle(_request: TitleRequest, _signal: AbortSignal): Promise<string> { return 'Generated title'; }
  async renameThread(threadId: string, name: string): Promise<void> {
    const thread = this.threads.get(threadId)!;
    thread.name = name; thread.title = name;
    this.events.emit({ type: 'name', threadId, title: name });
  }
  async startTurn(threadId: string, input: Input[], settings: RunSettings, clientId: string): Promise<Turn> {
    this.sent.push({ threadId, input, settings, clientId });
    if (this.turnStarter) return this.turnStarter(threadId, input, clientId);
    const turn: Turn = { id: `turn-${++this.sequence}`, status: 'inProgress', items: [{ id: `user-${this.sequence}`, kind: 'userMessage', data: { clientId, content: input } }] };
    const value = this.threads.get(threadId)!; value.turns.push(turn); value.status = 'active';
    this.events.emit({ type: 'turn', threadId, turn: structuredClone(turn), completed: false });
    return structuredClone(turn);
  }
  async steerTurn(threadId: string, turnId: string, input: Input[]): Promise<void> { this.steered.push({ threadId, turnId, input }); }
  async interruptTurn(threadId: string, turnId: string): Promise<void> { this.interrupted.push(turnId); this.finish(threadId, turnId, 'interrupted'); }
  async readUsage(): Promise<Usage> { return this.usageReader ? this.usageReader() : structuredClone(this.limits); }
  answerRequest(id: string, threadId: string, answer: RequestAnswer): void { this.answered.push({ id, threadId, answer }); this.events.emit({ type: 'resolved', threadId, requestId: id }); }
  rejectRequest(): void {}
  finish(threadId: string, turnId: string, status = 'failed', kind = 'usageLimitExceeded'): Turn {
    const turn: Turn = { id: turnId, status, items: [], ...(status === 'failed' ? { error: { message: kind, kind } } : {}) };
    const value = this.threads.get(threadId)!;
    const at = value.turns.findIndex(t => t.id === turnId);
    if (at < 0) value.turns.push(turn); else value.turns[at] = turn;
    value.status = 'idle';
    this.events.emit({ type: 'turn', threadId, turn, completed: true });
    return turn;
  }
}
