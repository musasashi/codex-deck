import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';
import { object, string, Signal, messageOf } from '../core/types';
import { HF_CONFIG_ARGS } from '../core/huggingFace';

export class RpcError extends Error {
  constructor(public readonly code: number, message: string, public readonly data?: unknown) { super(message); }
}
export type RequestId = number | string;
export const requestKey = (id: RequestId): string => `${typeof id}:${id}`;
export interface ServerRequest { id: RequestId; method: string; params: unknown }

/** Wire framing and request correlation only. No task or VS Code state lives here. */
export class JsonRpcPeer {
  readonly notifications = new Signal<{ method: string; params: unknown }>();
  readonly closed = new Signal<Error>();
  handleRequest?: (request: ServerRequest) => Promise<unknown>;
  private pending = new Map<RequestId, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private sequence = 0;
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private ended = false;
  constructor(private readonly input: Readable, private readonly output: Writable, private readonly timeoutMs = 60_000) {
    input.on('data', this.onData);
    input.once('end', this.onEnd);
    input.once('error', this.onError);
    output.once('error', this.onError);
  }
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.ended) return Promise.reject(new Error('App Serverに接続していません。'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}がタイムアウトしました。実行結果が不明なため自動で再送しません。`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, ...(params === undefined ? {} : { params }) }); }
      catch (error) { this.finish(id, undefined, error instanceof Error ? error : new Error(String(error))); }
    });
  }
  notify(method: string, params?: unknown): void {
    this.send({ method, ...(params === undefined ? {} : { params }) });
  }
  private send(value: unknown): void {
    if (this.ended) throw new Error('App Serverに接続していません。');
    this.output.write(`${JSON.stringify(value)}\n`, error => { if (error) this.close(error); });
  }
  private onData = (chunk: Buffer | string): void => {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (line.length > 32 * 1024 * 1024) { this.close(new Error('App Serverメッセージが大きすぎます。')); return; }
      let value: unknown;
      try { value = JSON.parse(line); }
      catch { this.close(new Error('App Serverから不正なJSONを受信しました。')); return; }
      this.dispatch(value);
    }
    if (this.buffer.length > 32 * 1024 * 1024) this.close(new Error('App Serverメッセージが大きすぎます。'));
  };
  private dispatch(value: unknown): void {
    const msg = object(value);
    const validId = typeof msg.id === 'number' || typeof msg.id === 'string';
    if (typeof msg.method === 'string') {
      if (!validId) { this.notifications.emit({ method: msg.method, params: msg.params }); return; }
      const request = { id: msg.id as RequestId, method: msg.method, params: msg.params };
      void Promise.resolve().then(() => {
        if (!this.handleRequest) throw new RpcError(-32601, `Unsupported server request: ${request.method}`);
        return this.handleRequest(request);
      }).then(
        result => { if (!this.ended) this.send({ id: request.id, result }); },
        error => { if (!this.ended) this.send({ id: request.id, error: { code: error instanceof RpcError ? error.code : -32603, message: messageOf(error) } }); },
      ).catch(error => this.close(error instanceof Error ? error : new Error(String(error))));
    } else if (validId) {
      const err = object(msg.error);
      this.finish(msg.id as RequestId, msg.result, msg.error === undefined ? undefined : new RpcError(typeof err.code === 'number' ? err.code : -32603, string(err.message, 'App Server request failed'), err.data));
    }
  }
  private finish(id: RequestId, result: unknown, error?: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (error) pending.reject(error); else pending.resolve(result);
  }
  private onEnd = (): void => this.close(new Error('App Serverとの接続が終了しました。'));
  private onError = (error: Error): void => this.close(error);
  close(error = new Error('App Serverとの接続を終了しました。')): void {
    if (this.ended) return;
    this.ended = true;
    this.input.off('data', this.onData);
    this.input.off('end', this.onEnd);
    for (const id of this.pending.keys()) this.finish(id, undefined, error);
    this.closed.emit(error);
  }
}

export class StdioConnection {
  private child?: ChildProcessWithoutNullStreams;
  private peer?: JsonRpcPeer;
  constructor(private readonly log: (text: string) => void) {}
  start(executable: string, cwd?: string): JsonRpcPeer {
    if (this.child) throw new Error('App Serverはすでに起動しています。');
    // No shell: executable settings and paths are never evaluated as commands.
    const child = spawn(executable, ['app-server', ...HF_CONFIG_ARGS], { cwd, stdio: 'pipe', windowsHide: true });
    this.child = child;
    const peer = new JsonRpcPeer(child.stdout, child.stdin);
    this.peer = peer;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.log(chunk));
    child.once('error', error => peer.close(new Error(`Codex CLIを起動できません: ${error.message}。codexDeck.cliPathを確認してください。`)));
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = undefined;
      peer.close(new Error(`App Serverが終了しました (${code ?? signal})。`));
    });
    return peer;
  }
  dispose(): void {
    const child = this.child;
    this.peer?.close();
    this.peer = undefined;
    this.child = undefined;
    if (!child) return;
    child.stdin.end();
    child.kill();
  }
}
