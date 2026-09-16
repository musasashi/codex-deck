# 開発ガイド

[READMEに戻る](../README.md)

## 開発版を起動する

[必要な環境](../README.md#はじめる)を用意し、WSL内のターミナルでリポジトリのルートから`npm ci`を実行します。

VS CodeからWSLに接続してリポジトリを開き、F5でExtension Development Hostを起動します。起動前に自動でビルドされます。起動したウィンドウでWSL内の作業フォルダーを開くと、Codex Deckを使用できます。

## 検証する

コマンドはWSL内で実行します。

| コマンド | 対象 |
| --- | --- |
| `npm run check` | TypeScriptの型チェック |
| `npm test` | 単体テスト |
| `npx playwright test` | チャット・設定画面 |
| `npm run test:extension` | Extension Hostでの拡張機能 |
| `npm run test:history` | 履歴の操作 |
| `npm run test:smoke` | インストール済みCLIとの接続とデータ取得。推論は実行しない |
| `npm run test:hf` | インストール済みCLIとローカルの模擬HFサーバーで、ツール往復・推論履歴・要約を検証。HFへの外部リクエストは送信しない |
| `npm run test:responses` | インストール済みCLIとローカルの模擬APIで、接続先登録・認証分離・ストリーミング・ツール往復・要約を検証。外部APIへのリクエストは送信しない |

API残高がなくても実装と模擬APIによるテストを進められます。本番APIとの互換性は、設定画面の「利用可否を確認」で別途確認します。この操作は提供元の料金の対象になります。

### 画面テスト

初回にブラウザーを取得し、UIテストの前にビルドします。

```sh
npx playwright install chromium
npm run build
```

既存のブラウザーを使う場合は`CODEX_DECK_CHROMIUM`に実行ファイルを指定します。UIテストの実行規則は[AGENTS.md](../AGENTS.md#uiテスト)を参照してください。

### WSL内でのExtension Host・履歴テスト

```sh
xvfb-run -a npm run test:extension
xvfb-run -a npm run test:history
```

これらのテストはWSL内でLinux版VS Codeを直接起動し、隔離した設定と模擬App Serverを使用します。WSL接続のない開発用Extension Hostは、LinuxカーネルのWSL識別情報で判定します。

## リリースする

リリースは`master`で直接行います。リリース用のブランチやPRは作成しません。

`master`を最新にし、次のどちらかでバージョンを更新します。

```sh
git switch master
git pull --ff-only
npm version minor --no-git-tag-version
npm version major --no-git-tag-version
```

どちらか一方だけを実行します。パッケージ作成時に型チェックとビルドも実行されます。

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
