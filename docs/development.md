# 開発ガイド

[READMEに戻る](../README.md)

## 開発版を起動する

[必要な環境](../README.md#はじめる)を用意し、リポジトリのルートで`npm ci`を実行します。

VS Codeでリポジトリを開き、F5でExtension Development Hostを起動します。起動前に自動でビルドされます。起動したウィンドウで作業フォルダーを開くと、Codex Deckを使用できます。

## 検証する

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

### LinuxでのExtension Host・履歴テスト

```sh
xvfb-run -a npm run test:extension
xvfb-run -a npm run test:history
```

これらのテストは隔離した設定と模擬App Serverを使用します。

## リリースする

次のどちらかでバージョンを更新し、変更をコミットしてpushします。

```sh
npm version minor --no-git-tag-version
npm version major --no-git-tag-version
```

パッケージを作成してGitHub Releasesに公開します。

```sh
npm run package
release_version=$(node -p "require('./package.json').version")
git tag "v${release_version}"
git push origin "v${release_version}"
gh release create "v${release_version}" "./codex-deck-${release_version}.vsix" \
  --title "v${release_version}" \
  --generate-notes \
  --verify-tag
```
