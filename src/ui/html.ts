export function chatHtml(options: { cspSource: string; script: string; css: string; nonce: string }): string {
  const { cspSource, script, css, nonce } = options;
  const autoResumeDescription = [
    'ONにした会話が使用量上限で停止すると、すべての上限の回復を確認後に「作業を続けてください。」を自動送信します。',
    'VS Codeの起動とApp Serverへの接続が必要です。VS Codeを閉じている間や未接続の間は自動継続しません。',
    '通常の完了・手動停止・使用量上限以外のエラーでは自動継続しません。承認や質問は回答を待ちます。',
    'チェックをOFFにする、手動で停止する、手動でメッセージを送信する操作で待機予約を解除します。手動停止ではチェックもOFFになります。',
    'タスクのタブを閉じると、待機予約を解除してチェックもOFFになります。タブを開き直してもOFFのままです。',
    'VS Code再起動時にタブが復元された場合は、使用量と実行状態を再確認して再開を判断します。',
  ].join('\n');
    return `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; img-src ${cspSource} data:; script-src 'nonce-${nonce}';"><link href="${css}" rel="stylesheet"><title>Codex Deck</title></head><body>
      <header class="topbar"><div class="connection"><span id="status-dot" class="dot"></span><span id="status">接続中</span></div><label class="auto-resume" title="${autoResumeDescription}"><input id="auto-resume" type="checkbox">使用量回復後に自動継続</label><button id="menu" class="icon-button" aria-label="コマンドメニュー" title="コマンドメニュー">•••</button></header>
      <div id="notice" role="status" hidden></div>
      <main id="conversation" tabindex="0" aria-label="会話"><section id="skills" aria-label="登録されたスキル" hidden></section><div id="transcript" role="log" aria-label="チャット履歴"></div><div id="plan"></div></main>
      <section id="requests" aria-label="承認と質問" hidden></section>
      <footer class="composer-area"><form id="composer">
        <div id="completions" hidden></div><div id="attachments" class="attachments" role="list" aria-label="添付ファイル" hidden></div>
        <label class="sr-only" for="prompt">メッセージ</label><textarea id="prompt" rows="2" placeholder="作業内容を入力。 / コマンド · @ ファイル · $ スキル" aria-autocomplete="list" aria-controls="completion-list" aria-expanded="false" autofocus></textarea>
        <div id="image-status" role="status" hidden></div>
        <div class="composer-tools">
          <button type="button" id="attach" class="icon-button" title="ファイル・画像を添付" aria-label="ファイル・画像を添付">＋</button>
          <div class="composer-settings">
            <div class="composer-model">
              <div id="usage-gauges" class="usage-gauges" role="group" aria-label="Codexの残量" hidden></div>
              <span id="task-cost" class="task-cost" tabindex="0" aria-label="このタスクのHF利用額" hidden></span>
              <label><span class="sr-only">モデル</span><select id="model" aria-label="モデル" title="モデル"></select></label>
            </div>
            <label><span class="sr-only">推論の強さ</span><select id="effort" aria-label="推論の強さ" title="推論の強さ"></select></label>
            <label><span class="sr-only">Permissions</span><select id="mode" aria-label="Permissions" title="Permissions"></select></label>
          </div>
          <div class="composer-actions">
            <button type="button" id="cycle-preset" class="icon-button" aria-label="プリセットを切り替え" title="設定からプリセットを追加してください" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4"/></svg></button>
            <button type="button" id="stop" hidden>停止</button>
            <button type="submit" id="send">送信</button>
          </div>
        </div>
      </form></footer>
      <script nonce="${nonce}" src="${script}"></script></body></html>`;
}
