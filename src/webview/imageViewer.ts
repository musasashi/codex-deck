declare function acquireVsCodeApi(): { postMessage(value: unknown): void };
const vscode = acquireVsCodeApi();
const stage = document.getElementById('image-stage')!;
const preview = document.getElementById('preview') as HTMLImageElement;
const scale = document.getElementById('scale') as HTMLButtonElement;
const error = document.getElementById('image-error')!;

function setScale(actual: boolean): void {
  stage.classList.toggle('actual-size', actual);
  scale.textContent = actual ? '全体表示' : '実寸表示';
  stage.scrollTo(0, 0);
}
function toggleScale(): void { setScale(!stage.classList.contains('actual-size')); }
scale.addEventListener('click', toggleScale);
preview.addEventListener('click', toggleScale);
preview.addEventListener('load', () => { preview.hidden = false; scale.disabled = false; });
preview.addEventListener('error', () => { preview.hidden = true; error.hidden = false; scale.disabled = true; });
window.addEventListener('message', event => {
  const message = event.data;
  if (message?.type !== 'image' || typeof message.src !== 'string') return;
  setScale(false);
  error.hidden = true;
  preview.alt = message.label;
  if (preview.getAttribute('src') !== message.src || !preview.naturalWidth) {
    preview.hidden = true; scale.disabled = true; preview.src = message.src;
  }
  stage.focus();
});
const close = (): void => vscode.postMessage({ type: 'close' });
document.getElementById('close')!.addEventListener('click', close);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
});
vscode.postMessage({ type: 'ready', fullscreen: matchMedia('(display-mode: fullscreen)').matches
  || window.outerWidth >= screen.width && window.outerHeight >= screen.height });
