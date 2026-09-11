import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { messageOf, object, type JsonObject } from '../core/types';
import { responsesRequest } from './responsesWire';

/** A loopback-only adapter for Codex's Responses extensions. The upstream is fixed. */
export class ResponsesProxy {
  private server?: Server;
  private requests = new Set<AbortController>();
  request?: (body: JsonObject, signal: AbortSignal) => Promise<Response>;
  constructor(private readonly upstream: string, private readonly transform: (body: JsonObject) => ReturnType<typeof responsesRequest> = responsesRequest,
    private readonly label = 'Responses API') {}

  async start(token: string, upstreamToken: string | null = token): Promise<string> {
    this.dispose();
    const authorization = Buffer.from(`Bearer ${token}`);
    const server = createServer((request, response) => {
      void this.handle(request, response, authorization, upstreamToken).catch(() => {
        if (!response.headersSent) {
          response.writeHead(502, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: `${this.label}への接続に失敗しました。` } }));
        } else response.destroy();
      });
    });
    this.server = server;
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error(`${this.label}の接続を開始できませんでした。`);
    const url = `http://127.0.0.1:${address.port}/v1`;
    this.request = (body, signal) => fetch(`${url}/responses`, { method: 'POST', signal, redirect: 'error',
      headers: { authorization: authorization.toString(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return url;
  }

  private async handle(request: IncomingMessage, response: ServerResponse, authorization: Buffer, upstreamToken: string | null): Promise<void> {
    const provided = Buffer.from(request.headers.authorization ?? '');
    if (provided.length !== authorization.length || !timingSafeEqual(provided, authorization)) { response.writeHead(401); response.end(); return; }
    if (request.method !== 'POST' || request.url !== '/v1/responses') { response.writeHead(404); response.end(); return; }
    if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') { response.writeHead(415); response.end(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) { response.writeHead(413); response.end(); return; }
      chunks.push(chunk);
    }
    let converted: ReturnType<typeof responsesRequest>;
    try { converted = this.transform(object(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
    catch (error) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: `${this.label}に送信するリクエストを変換できませんでした。${error instanceof SyntaxError ? '' : messageOf(error)}` } })); return; }
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.requests.add(controller);
    response.once('close', abort);
    try {
      const headers: Record<string, string> = { ...(upstreamToken ? { authorization: `Bearer ${upstreamToken}` } : {}), 'content-type': 'application/json', accept: 'text/event-stream, application/json' };
      if (this.label === 'HF' && typeof request.headers['x-hf-bill-to'] === 'string') headers['x-hf-bill-to'] = request.headers['x-hf-bill-to'];
      const upstream = await fetch(`${this.upstream}/responses`, { method: 'POST', headers,
        body: JSON.stringify(converted.body), signal: controller.signal, redirect: 'error' });
      const type = upstream.headers.get('content-type') ?? 'application/json';
      response.writeHead(upstream.status, { 'content-type': type, 'cache-control': 'no-store',
        ...(upstream.headers.has('retry-after') ? { 'retry-after': upstream.headers.get('retry-after')! } : {}) });
      if (!upstream.ok || !type.includes('text/event-stream')) {
        const text = await upstream.text();
        if (upstream.ok) {
          response.end(JSON.stringify(converted.restore(JSON.parse(text)))); return;
        }
        response.end(upstreamToken ? text.replaceAll(upstreamToken, '[REDACTED]') : text); return;
      }
      const decoder = new TextDecoder();
      response.flushHeaders();
      let buffer = '';
      let finished = false;
      const write = async (value: string) => { if (!response.write(value)) await once(response, 'drain', { signal: controller.signal }); };
      const frame = async (value: string) => {
        const data = value.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) { if (value.startsWith(':')) await write(value + '\n\n'); return; }
        if (data === '[DONE]') return;
        const event = object(JSON.parse(data));
        if (['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(String(event.type))) finished = true;
        const dataText = JSON.stringify(converted.restore(event));
        const safeText = upstreamToken && (event.type === 'response.failed' || event.type === 'error') ? dataText.replaceAll(upstreamToken, '[REDACTED]') : dataText;
        await write(`event: ${event.type}\ndata: ${safeText}\n\n`);
      };
      const frames = async () => {
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          await frame(buffer.slice(0, boundary.index));
          buffer = buffer.slice(boundary.index + boundary[0].length);
        }
      };
      const reader = upstream.body?.getReader();
      if (reader) try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }); await frames();
          if (buffer.length > 32 * 1024 * 1024) throw new Error('ストリームメッセージが大きすぎます。');
        }
      } finally { reader.releaseLock(); }
      buffer += decoder.decode(); await frames();
      if (buffer.trim()) await frame(buffer);
      if (!finished) throw new Error('応答が完了する前に接続が終了しました。');
      response.end();
    } finally { response.off('close', abort); this.requests.delete(controller); }
  }

  dispose(): void {
    this.request = undefined;
    for (const request of this.requests) request.abort();
    this.requests.clear();
    this.server?.closeAllConnections(); this.server?.close(); this.server = undefined;
  }
}
