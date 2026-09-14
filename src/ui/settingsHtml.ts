export function settingsHtml(options: { cspSource: string; script: string; css: string; nonce: string }): string {
  return `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${options.cspSource}; script-src 'nonce-${options.nonce}';"><link href="${options.css}" rel="stylesheet"><title>Codex Deck 設定</title></head><body>
    <main><header><h1>Codex Deck 設定</h1><p>タスクのプリセットと、タスク名の要約に使うモデル・推論強度を設定します。先頭のプリセットが新規タスクの初期設定になります。</p></header>
    <form id="settings-form"><label for="scope">保存先</label><select id="scope" disabled></select>
      <fieldset id="providers" disabled><legend>Responses API接続先</legend>
        <p class="hint">接続先はユーザー設定に保存します。Base URLには「/responses」の前までを入力してください。HTTPS必須で、HTTPはループバック接続（localhost・127.0.0.0/8・[::1]）のみ使用できます。登録したモデルはプリセットとタスク名の候補に追加されます。対応機能はモデルの仕様に合わせて選択してください。</p>
        <div id="provider-list"></div><button id="add-provider" type="button" class="secondary">接続先を追加</button>
      </fieldset>
      <fieldset id="presets" disabled><legend>プリセット</legend>
        <p class="hint">タスクの切り替えボタンで、上から順に循環します。プリセットは1件以上必要です。</p>
        <div id="preset-list"></div>
        <button id="add-preset" type="button" class="accent">プリセットを追加</button>
      </fieldset>
      <fieldset id="task-titles" disabled><legend>タスク名</legend>
        <label for="title-model">要約に使うモデル</label><select id="title-model" aria-describedby="title-model-description"></select>
        <div id="title-hf-field" hidden><div id="title-hf-id"><label for="title-hf-model">HFの要約モデルID</label><input id="title-hf-model" type="text" placeholder="組織/モデル:プロバイダー" autocomplete="off" spellcheck="false"></div>
          <div class="preset-fields"><div><label for="title-input-price">要約の入力単価（USD／100万トークン）</label><input id="title-input-price" type="number" min="0" step="any"></div><div><label for="title-output-price">要約の出力単価（USD／100万トークン）</label><input id="title-output-price" type="number" min="0" step="any"></div></div>
          <div class="hf-check"><button id="title-hf-check" type="button" class="secondary">利用可否を確認</button><p id="title-hf-check-result" class="hint" aria-live="polite"></p></div>
        </div>
        <p id="title-model-description" class="hint">最初の依頼を送信した時点で要約します。分岐先では引き継いだ会話も参考にします。「最新モデル」を選んだ外部APIタスクでは、そのタスクのモデルを使用します。単価は任意です。</p>
        <label for="title-effort">要約の推論強度</label><select id="title-effort" aria-describedby="title-effort-description"></select>
        <p id="title-effort-description" class="hint">既定は「最低」です。選択したモデルで利用できる最も低い強度を使います。</p>
      </fieldset>
      <div class="actions"><button id="save" type="submit" disabled>保存</button><button id="reload" type="button" class="secondary">候補を再読み込み</button><button id="cancel-check" type="button" class="secondary" hidden>確認を中止</button></div>
      <p id="status" role="status" aria-live="polite">候補を読み込み中…</p>
      <p class="hint">HFを使うには、WSL内にInference Providers権限を持つトークンを環境変数HF_TOKENとして設定してください。</p>
      <p class="hint">APIキーはWSL内の環境変数に設定してください。「利用可否を確認」は短いテストを最大3回送信し、提供元の利用料金の対象になります。応答・ツール往復・利用トークン数を確認します。要約専用モデルではツール往復を省きます。設定の保存では推論APIを呼び出しません。単価は任意で、キャッシュ割引・無料枠は概算費用に反映しません。</p>
    </form>
    <footer><button id="codex-config" type="button" class="link">Codexの設定</button><button id="other-settings" type="button" class="link">その他の拡張機能設定</button></footer></main>
    <script nonce="${options.nonce}" src="${options.script}"></script></body></html>`;
}
