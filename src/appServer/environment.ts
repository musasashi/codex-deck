import { release } from 'node:os';

export function requireWslHost(remoteName: string | undefined, platform = process.platform, kernelRelease = release()): void {
  // Local Extension Hosts used for development also run directly inside WSL.
  const wsl = platform === 'linux' && (remoteName === 'wsl' || (remoteName === undefined && /microsoft/i.test(kernelRelease)));
  if (!wsl) throw new Error('Codex DeckはWSL内のCodex専用です。VS Codeで作業フォルダーをWSL接続で開き、Codex Deckと公式Codex CLIをWSL側にインストールしてください。');
}

export function appServerEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'HF_TOKEN', 'OPENAI_BASE_URL', 'CHATGPT_BASE_URL']) delete env[key];
  return env;
}
