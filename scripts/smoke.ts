import { AppServerClient } from '../src/appServer/client';
import { StdioConnection } from '../src/appServer/rpc';
import { object } from '../src/core/types';

async function main(): Promise<void> {
  const client = new AppServerClient();
  const connection = new StdioConnection(() => undefined);
  try {
    const started = performance.now();
    await client.connect(connection.start(process.env.CODEX_DECK_CLI ?? 'codex', process.cwd()));
    const historyStarted = performance.now();
    const history = await client.listThreads();
    const historyFinished = performance.now();
    console.log(`履歴${history.threads.length}件の取得: ${Math.round(historyFinished - historyStarted)}ms、接続開始から: ${Math.round(historyFinished - started)}ms。`);
    const config = object((await client.readConfig(process.cwd())).config);
    if (config.model_provider !== 'openai' || config.forced_login_method !== 'chatgpt') throw new Error('ChatGPT接続設定を確認できませんでした。');
    const account = await client.account();
    if (object(account.account).type === 'chatgpt') {
      const [models, usage] = await Promise.all([client.listModels(), client.readUsage()]);
      console.log(`ChatGPT接続成功: モデル ${models.length} 件、使用量 ${usage.buckets.length} 件。`);
    } else console.log('ChatGPTでサインインするとモデル一覧と利用枠を確認できます。');
    const [skills, files] = await Promise.all([client.listSkills(process.cwd()), client.searchFiles(process.cwd(), 'README')]);
    console.log(`登録スキル ${skills.length} 件、READMEのファイル候補 ${files.length} 件を取得成功。`);
    console.log('推論の実行、サインインの変更、会話の作成は行っていません。');
  } finally { connection.dispose(); client.detach(); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
