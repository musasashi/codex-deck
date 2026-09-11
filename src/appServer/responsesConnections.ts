import { randomBytes } from 'node:crypto';
import { configuredModel, providerId, validateProviders, type ResponsesProvider } from '../core/providers';
import { object, type JsonObject } from '../core/types';
import type { ProviderCheck, ProviderCheckPurpose } from '../core/providerCheck';
import { appServerEnvironment } from './environment';
import { ResponsesProxy } from './responsesProxy';
import { responsesRequest } from './responsesWire';
import { checkResponsesModel } from './responsesCheck';

interface Connection { proxy: ResponsesProxy; config: JsonObject }

/** Existing turns keep their connection while new settings get a separate adapter. */
export class ResponsesConnections {
  private connections = new Map<string, Promise<Connection>>();
  private generation = 0;
  constructor(private readonly environment: (keys: string[]) => Promise<NodeJS.ProcessEnv> = keys => appServerEnvironment(process.env, keys)) {}

  private async connection(provider: ResponsesProvider, effort?: string): Promise<Connection> {
    const generation = this.generation;
    const env = await this.environment(provider.apiKeyEnv ? [provider.apiKeyEnv] : []);
    if (generation !== this.generation) throw new Error('接続は終了しました。');
    const token = provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined;
    if (provider.apiKeyEnv && !token) throw new Error(`${provider.name}: 環境変数${provider.apiKeyEnv}にAPIキーを設定してください。`);
    const signature = JSON.stringify([provider, token, effort]);
    let connection = this.connections.get(signature);
    if (!connection) {
      const proxy = new ResponsesProxy(provider.baseUrl, raw => {
        const model = provider.models.find(m => m.id === raw.model);
        if (!model) throw new Error('接続先に登録されていないモデルです。');
        const body = { ...raw };
        if (effort && !model.reasoningEfforts.includes(effort)) throw new Error(`このモデルでは推論強度「${effort}」を使用できません。`);
        if (effort) body.reasoning = { ...object(body.reasoning), effort };
        // Codex may inherit an effort even when its override is omitted; only send the user's explicit selection.
        return responsesRequest(body, { stateless: true, discardReasoning: !effort,
          images: model.images, structuredOutput: model.structuredOutput });
      }, provider.name);
      const localToken = randomBytes(32).toString('hex');
      connection = proxy.start(localToken, token ?? null).then(baseUrl => {
        if (generation !== this.generation) { proxy.dispose(); throw new Error('接続は終了しました。'); }
        return { proxy, config: { model_providers: { [providerId(provider.id)]: {
          name: provider.name, base_url: baseUrl, wire_api: 'responses', experimental_bearer_token: localToken, requires_openai_auth: false,
        } } } };
      }).catch(error => { proxy.dispose(); this.connections.delete(signature); throw error; });
      this.connections.set(signature, connection);
    }
    return connection;
  }

  async config(id: string, providers: ResponsesProvider[], effort?: string): Promise<JsonObject> {
    const { provider, model } = configuredModel(id, validateProviders(providers));
    if (effort && !model.reasoningEfforts.includes(effort)) throw new Error(`このモデルでは推論強度「${effort}」を使用できません。`);
    return (await this.connection(provider, effort)).config;
  }
  async check(model: string, providers: ResponsesProvider[], purpose: ProviderCheckPurpose, signal: AbortSignal,
    progress: (check: ProviderCheck) => void): Promise<ProviderCheck> {
    signal.throwIfAborted();
    const { provider } = configuredModel(model, validateProviders(providers));
    const { proxy } = await this.connection(provider);
    signal.throwIfAborted();
    return checkResponsesModel(model, purpose, proxy.request!, signal, progress, { label: provider.name });
  }
  dispose(): void {
    this.generation++;
    for (const pending of this.connections.values()) void pending.then(connection => connection.proxy.dispose(), () => {});
    this.connections.clear();
  }
}
