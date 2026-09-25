import type { CostSample, TaskCost, TokenPrice } from './cost';

export type JsonObject = Record<string, unknown>;
export const object = (value: unknown): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const string = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
export const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

export class Signal<T> {
  private listeners = new Set<(value: T) => void>();
  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(value: T): void { for (const listener of this.listeners) listener(value); }
}

export interface Input {
  type: 'text' | 'localImage' | 'image' | 'skill';
  text?: string;
  path?: string;
  url?: string;
  name?: string;
}
export interface Attachment { id: string; label: string; input: Input }
export interface Skill { name: string; description: string; path: string; scope: string }
export interface FileReference { path: string; kind: 'file' | 'directory' }
export interface ComposerCatalog { skills: Skill[]; permissionMode?: ExecutionMode }
export interface Model {
  id: string;
  label: string;
  description: string;
  efforts: { id: string; description: string }[];
  defaultEffort: string;
  isDefault: boolean;
  upgrade?: string;
  inputModalities: string[];
  structuredOutput?: boolean;
}
export type ExecutionMode = 'default' | 'read-only' | 'workspace-write' | 'auto-review' | 'danger-full-access';
export type CollaborationMode = 'default' | 'plan';
export interface RunSettings { model?: string; effort?: string; mode: ExecutionMode; collaborationMode?: CollaborationMode; pricing?: TokenPrice }
export interface SettingsPreset extends RunSettings { model: string; effort: string }
export interface TurnError { message: string; kind?: string }
export interface Item { id: string; kind: string; data: JsonObject }
export interface Turn {
  id: string;
  status: string;
  items: Item[];
  error?: TurnError;
  /** Timestamps and durations are in milliseconds. */
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
}
export interface ThreadReference {
  id: string;
  forkedFromId?: string;
  parentThreadId?: string;
  historyBaseThreadId?: string;
}
export interface Thread extends ThreadReference {
  title: string;
  name?: string;
  cwd: string;
  status: string;
  activeFlags: string[];
  turns: Turn[];
  updatedAt?: number;
  model?: string;
  modelProvider?: string;
  effort?: string;
  instructionSources?: string[];
  permissionMode?: ExecutionMode;
}
export interface LimitWindow { key: string; usedPercent: number; windowDurationMins?: number; resetsAt?: number }
export interface LimitBucket {
  id: string;
  label: string;
  windows: LimitWindow[];
  reached?: string;
  reachedKnown?: boolean;
  spendControlReached?: boolean;
  credits?: { hasCredits: boolean; unlimited: boolean };
  complete: boolean;
}
export interface ResetCredit { id: string; title?: string; expiresAt: number | null }
export interface ResetCredits { availableCount: number; credits?: ResetCredit[] }
export type ResetCreditOutcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed';
export interface Usage { buckets: LimitBucket[]; resetCredits?: ResetCredits; accountId?: string }
export interface PendingRequest {
  id: string;
  threadId: string;
  turnId?: string;
  kind: 'approval' | 'questions' | 'permissions' | 'elicitation';
  title: string;
  detail: string;
  choices: string[];
  questions?: { id: string; header: string; question: string; secret: boolean; options: { label: string; description: string }[] }[];
  url?: string;
  schema?: JsonObject;
  blocking: boolean;
  /** Questions delivered as agent messages are answered with ordinary user input. */
  source?: 'agentMessage';
}
export interface RequestAnswer { choice?: number; answers?: Record<string, string[]>; content?: unknown; skip?: boolean }
export type ServerEvent =
  | { type: 'connection'; connected: boolean; message?: string }
  | { type: 'turn'; threadId: string; turn: Turn; completed: boolean }
  | { type: 'error'; threadId: string; turnId: string; error: TurnError; willRetry: boolean }
  | { type: 'item'; threadId: string; turnId: string; item: Item; completed: boolean }
  | { type: 'delta'; threadId: string; turnId: string; itemId: string; kind: string; field: string; text: string; index?: number }
  | { type: 'status'; threadId: string; status: string; flags: string[] }
  | { type: 'name'; threadId: string; title: string }
  | { type: 'diff'; threadId: string; turnId: string; diff: string }
  | { type: 'plan'; threadId: string; turnId: string; explanation: string; steps: { step: string; status: string }[] }
  | { type: 'request'; request: PendingRequest }
  | { type: 'resolved'; threadId: string; requestId: string }
  | { type: 'usage' }
  | { type: 'account'; success?: boolean; error?: string }
  | { type: 'skills' }
  | { type: 'warning'; threadId?: string; message: string }
  | { type: 'tokens'; threadId: string; value: unknown }
  | { type: 'cost'; threadId: string; sample: CostSample }
  | { type: 'archived' | 'deleted'; threadId: string };

export interface Gateway {
  readonly connected: boolean;
  readonly events: Signal<ServerEvent>;
  startThread(cwd: string, settings?: RunSettings): Promise<Thread>;
  resumeThread(threadId: string, settings?: RunSettings): Promise<Thread>;
  readThread(threadId: string): Promise<Thread>;
  forkThread(threadId: string, options?: { lastTurnId?: string; settings?: RunSettings }): Promise<Thread>;
  listModels(): Promise<Model[]>;
  generateTitle(request: TitleRequest, signal: AbortSignal): Promise<string>;
  renameThread(threadId: string, name: string): Promise<void>;
  startTurn(threadId: string, input: Input[], settings: RunSettings, clientId: string): Promise<Turn>;
  steerTurn(threadId: string, turnId: string, input: Input[]): Promise<void>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  readUsage(): Promise<Usage>;
  answerRequest(requestId: string, threadId: string, answer: RequestAnswer): void;
  rejectRequest(requestId: string, message: string): void;
}

export type TaskStatus = 'idle' | 'running' | 'approval' | 'input' | 'limited' | 'waiting' | 'error' | 'disconnected';
export const statusLabel: Record<TaskStatus, string> = {
  idle: '待機中', running: '実行中', approval: '承認待ち', input: '回答待ち', limited: '使用量上限',
  waiting: '使用量回復待ち', error: 'エラー', disconnected: '未接続',
};
export interface Reservation { turnId: string; token: string; blockers?: string[] }
export interface TitleRequest { cwd: string; model: string; effort: string; input: string; ownerThreadId?: string; pricing?: TokenPrice }
export type TitleSource = 'provisional' | 'fork' | 'generated' | 'manual' | 'existing';
export interface TaskRecord {
  id: string;
  threadId?: string;
  modelProvider?: string;
  cost?: TaskCost;
  title: string;
  titleSource?: TitleSource;
  titleGenerationAttempted?: boolean;
  cwd: string;
  open: boolean;
  autoResume: boolean;
  waiting?: Reservation;
  lastTurn?: { id: string; status: string; error?: TurnError };
  unreadTurnId?: string;
  resolvedQuestionIds?: string[];
  claims: { stoppedTurnId: string; clientId: string; turnId?: string }[];
  suppressedTurnId?: string;
  settings: RunSettings;
}
export interface Task extends TaskRecord {
  status: TaskStatus;
  turns: Turn[];
  requests: PendingRequest[];
  attachments: Attachment[];
  activeTurnId?: string;
  busy: boolean;
  hydrated: boolean;
  error?: string;
  turnError?: { turnId: string; error: TurnError; willRetry: boolean };
  recoveryAt?: number;
  diff?: string;
  plan?: { explanation: string; steps: { step: string; status: string }[] };
  tokenUsage?: unknown;
  instructionSources: string[];
  effectiveModel?: string;
  effectiveEffort?: string;
  effectivePermissionMode?: ExecutionMode;
}

export function isTaskRunning(task: Task): boolean {
  const messageQuestionsOnly = task.requests.some(request => request.source === 'agentMessage') && !task.requests.some(request => request.blocking);
  return !!task.activeTurnId || task.status === 'running' || task.status === 'approval' || task.status === 'input' && !messageQuestionsOnly;
}
