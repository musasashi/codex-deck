export function settingsHtml(options: { cspSource: string; script: string; css: string; nonce: string }): string {
  return `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${options.cspSource}; script-src 'nonce-${options.nonce}';"><link href="${options.css}" rel="stylesheet"><title>Codex Deck 設定</title></head><body>
    <main><header><h1>Codex Deck 設定</h1><p>タスクのプリセットと、タスク名の要約に使うモデル・推論強度を設定します。先頭のプリセットが新規タスクの初期設定になります。</p></header>
    <form id="settings-form"><label for="scope">保存先</label><select id="scope" disabled></select>
      <fieldset id="presets" disabled><legend>プリセット</legend>
        <p class="hint">タスクの切り替えボタンで、上から順に循環します。プリセットは1件以上必要です。</p>
        <div id="preset-list"></div>
        <button id="add-preset" type="button" class="secondary">プリセットを追加</button>
      </fieldset>
      <fieldset id="task-titles" disabled><legend>タスク名</legend>
        <label for="title-model">要約に使うモデル</label><select id="title-model" aria-describedby="title-model-description"></select>
        <p id="title-model-description" class="hint">最初の依頼を送信した時点で要約します。分岐先では引き継いだ会話も参考にします。手動で変更した名前は保持します。</p>
        <label for="title-effort">要約の推論強度</label><select id="title-effort" aria-describedby="title-effort-description"></select>
        <p id="title-effort-description" class="hint">既定は「最低」です。選択したモデルで利用できる最も低い強度を使います。</p>
      </fieldset>
      <div class="actions"><button id="save" type="submit" disabled>保存</button><button id="reload" type="button" class="secondary">候補を再読み込み</button></div>
      <p id="status" role="status" aria-live="polite">候補を読み込み中…</p>
    </form>
    <footer><button id="codex-config" type="button" class="link">Codexの設定</button><button id="other-settings" type="button" class="link">その他の拡張機能設定</button></footer></main>
    <script nonce="${options.nonce}" src="${options.script}"></script></body></html>`;
}
