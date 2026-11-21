# 開発ガイド

[READMEに戻る](../README.md)

## 開発版を起動する

[必要な環境](../README.md#はじめる)を用意し、WSL内のターミナルでリポジトリのルートから`npm ci`を実行します。

VS CodeからWSLに接続してリポジトリを開き、F5でExtension Development Hostを起動します。起動前に自動でビルドされます。起動したウィンドウでWSL内の作業フォルダーを開くと、Codex Deckを使用できます。

## 検証する

コマンドはWSL内で実行します。エージェントによるテストはリポジトリの実行規則に従います。[AGENTS.md](../AGENTS.md)

| コマンド | 対象 |
| --- | --- |
| `npm run check` | TypeScriptの型チェック |
| `npm run build` | 拡張機能とWebviewのビルド |
| `npm test` | `tests/*.test.ts` の単体テスト。App Serverとの通信、履歴ピッカー、タスク管理など |
| `npx playwright test` | `tests/webview/` のチャット画面・設定画面の操作 |
| `npm run test:smoke` | インストール済みの公式CLIとの接続、履歴と設定の取得。ChatGPTでサインイン済みの場合はモデル一覧と利用枠も取得 |

### 画面テスト

初回にブラウザーを取得し、UIテストの前にビルドします。

```sh
npx playwright install chromium
npm run build
```

既存のChromiumを使う場合は `CODEX_DECK_CHROMIUM` に実行ファイルを指定します。

### VS Codeでの統合テスト

手動でVS Codeとの統合を確認する場合は、WSL内でLinux版VS Codeを起動します。`test:extension` はコマンドとタスクタブ、`test:history` は実際の履歴ピッカーでのアーカイブ・復元・削除を検証します。どちらも隔離したワークスペースと模擬App Serverを使います。

```sh
xvfb-run -a npm run test:extension
xvfb-run -a npm run test:history
```

## リリースする

リリースは`master`で直接行います。リリース用のブランチやPRは作成しません。

`master` を最新にします。

```sh
git switch master
git pull --ff-only
```

バージョンは `npm version minor --no-git-tag-version` または `npm version major --no-git-tag-version` で更新します。パッケージ作成時に型チェックとビルドも実行されます。

バージョン更新を直接`master`へコミットし、パッケージをGitHub Releasesに公開します。

```sh
npm run package
release_version=$(node -p "require('./package.json').version")
git add package.json package-lock.json
git commit -m "chore: release v${release_version}"
git push origin master
git tag -a "v${release_version}" -m "${release_version}"
git push origin "v${release_version}"
gh release create "v${release_version}" "./codex-deck-${release_version}.vsix" \
  --title "v${release_version}" \
  --generate-notes \
  --verify-tag
```
