import { AppServerClient } from '../src/appServer/client';
import { StdioConnection } from '../src/appServer/rpc';
import { appServerEnvironment } from '../src/appServer/environment';
import { HuggingFaceProxy } from '../src/appServer/huggingFaceProxy';
import { object } from '../src/core/types';
import { HF_API_URL, HF_PROVIDER } from '../src/core/huggingFace';

async function main(): Promise<void> {
  const client = new AppServerClient();
  const connection = new StdioConnection(() => undefined);
  const proxy = new HuggingFaceProxy();
  try {
    const started = performance.now();
    const env = await appServerEnvironment();
    const hfUrl = env.HF_TOKEN ? await proxy.start(env.HF_TOKEN) : undefined;
    await client.connect(connection.start(process.env.CODEX_DECK_CLI ?? 'codex', process.cwd(), env, hfUrl));
    const historyStarted = performance.now();
    const history = await client.listThreads();
    const historyFinished = performance.now();
    console.log(`履歴${history.threads.length}件の取得: ${Math.round(historyFinished - historyStarted)}ms、接続開始から: ${Math.round(historyFinished - started)}ms。`);
    const models = await client.listModels();
    const config = await client.readConfig(process.cwd());
    const hf = object(object(object(config.config).model_providers)[HF_PROVIDER]);
    if (hf.base_url !== (hfUrl ?? HF_API_URL) || hf.env_key !== 'HF_TOKEN' || hf.wire_api !== 'responses') throw new Error('HFプロバイダー設定を確認できませんでした。');
    console.log('HFの互換接続設定を確認しました。');
    const account = await client.account();
    console.log(`App Server接続成功: モデル ${models.length} 件、履歴 ${history.threads.length} 件。設定・アカウント取得成功。`);
    const [skills, files] = await Promise.all([client.listSkills(process.cwd()), client.searchFiles(process.cwd(), 'README')]);
    console.log(`登録スキル ${skills.length} 件、READMEのファイル候補 ${files.length} 件を取得成功。`);
    if (object(account.account).type === 'chatgpt') console.log(`使用量取得成功: ${(await client.readUsage()).buckets.length} 件。`);
    console.log('推論の実行、サインインの変更、会話の作成は行っていません。');
  } finally { connection.dispose(); proxy.dispose(); client.detach(); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
