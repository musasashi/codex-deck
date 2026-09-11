import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { object, string } from '../core/types';
import { HF_API_URL } from '../core/huggingFace';
import { huggingFaceRequest } from './huggingFaceWire';
import { huggingFaceChatRequest, HuggingFaceChatResponse } from './huggingFaceChat';

/** A loopback-only adapter for Codex's Responses extensions. The upstream is fixed. */
export class HuggingFaceProxy {
  private server?: Server;
  private requests = new Set<AbortController>();
  constructor(private readonly upstream = HF_API_URL) {}

  async start(token: string): Promise<string> {
    this.dispose();
    const authorization = Buffer.from(`Bearer ${token}`);
    const server = createServer((request, response) => {
      void this.handle(request, response, authorization).catch(() => {
        if (!response.headersSent) {
          response.writeHead(502, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'HFへの接続に失敗しました。' } }));
        } else response.destroy();
      });
    });
    this.server = server;
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HFの接続を開始できませんでした。');
    return `http://127.0.0.1:${address.port}/v1`;
  }

  private async handle(request: IncomingMessage, response: ServerResponse, authorization: Buffer): Promise<void> {
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
    let converted: ReturnType<typeof huggingFaceRequest>;
    let body: ReturnType<typeof huggingFaceChatRequest>;
    try { converted = huggingFaceRequest(object(JSON.parse(Buffer.concat(chunks).toString('utf8')))); body = huggingFaceChatRequest(converted.body); }
    catch { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'HFに送信するリクエストを変換できませんでした。' } })); return; }
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.requests.add(controller);
    response.once('close', abort);
    try {
      const headers: Record<string, string> = { authorization: authorization.toString(), 'content-type': 'application/json', accept: 'text/event-stream, application/json' };
      if (typeof request.headers['x-hf-bill-to'] === 'string') headers['x-hf-bill-to'] = request.headers['x-hf-bill-to'];
      const upstream = await fetch(`${this.upstream}/chat/completions`, { method: 'POST', headers,
        body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
      const type = upstream.headers.get('content-type') ?? 'application/json';
      response.writeHead(upstream.status, { 'content-type': type, 'cache-control': 'no-store',
        ...(upstream.headers.has('retry-after') ? { 'retry-after': upstream.headers.get('retry-after')! } : {}) });
      if (!upstream.ok || !type.includes('text/event-stream')) {
        const text = await upstream.text();
        if (upstream.ok) {
          response.end(JSON.stringify(converted.restore(HuggingFaceChatResponse.fromJson(JSON.parse(text), string(body.model))))); return;
        }
        response.end(text); return;
      }
      const decoder = new TextDecoder();
      response.flushHeaders();
      const stream = new HuggingFaceChatResponse(string(body.model));
      let buffer = '';
      let finished = false;
      const write = async (value: string) => { if (!response.write(value)) await once(response, 'drain', { signal: controller.signal }); };
      const emit = async (events: ReturnType<HuggingFaceChatResponse['push']>) => {
        for (const event of events) await write(`event: ${event.type}\ndata: ${JSON.stringify(converted.restore(event))}\n\n`);
      };
      const frame = async (value: string) => {
        const data = value.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) { if (value.startsWith(':')) await write(value + '\n\n'); return; }
        if (data === '[DONE]') { if (!finished) await emit(stream.finish()); finished = true; }
        else await emit(stream.push(JSON.parse(data)));
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
          if (buffer.length > 32 * 1024 * 1024) throw new Error('HFのストリームメッセージが大きすぎます。');
        }
      } finally { reader.releaseLock(); }
      buffer += decoder.decode(); await frames();
      if (buffer.trim()) await frame(buffer);
      if (!finished) await emit(stream.finish());
      response.end('data: [DONE]\n\n');
    } finally { response.off('close', abort); this.requests.delete(controller); }
  }

  dispose(): void {
    for (const request of this.requests) request.abort();
    this.requests.clear();
    this.server?.closeAllConnections(); this.server?.close(); this.server = undefined;
  }
}
