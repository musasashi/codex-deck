import { isImageDataUrl, IMAGE_FORMAT_ERROR, MAX_IMAGE_ATTACHMENT_BYTES } from '../core/attachments';
import { string, type Attachment, type ImagePoint, type ImageStroke, type JsonObject } from '../core/types';

interface EditSession {
  id: string;
  originalUrl: string;
  strokes: ImageStroke[];
  initialStrokes: string;
  bitmap?: ImageBitmap;
  pointerId?: number;
  applying: boolean;
  requestId?: string;
}

export class ImageAnnotationEditor {
  private readonly canvas: HTMLCanvasElement;
  private readonly stage: HTMLElement;
  private readonly status: HTMLElement;
  private readonly undo: HTMLButtonElement;
  private readonly clear: HTMLButtonElement;
  private readonly scale: HTMLButtonElement;
  private readonly apply: HTMLButtonElement;
  private readonly cancel: HTMLButtonElement;
  private session?: EditSession;
  private previousFocus?: HTMLElement;
  private frame?: number;
  private actualSize = false;

  constructor(private readonly dialog: HTMLDialogElement,
    private readonly post: (type: string, data: Record<string, unknown>) => void,
    private readonly changed: () => void, private readonly updated: (attachment: Attachment) => void) {
    const element = <T extends HTMLElement>(id: string): T => dialog.querySelector<T>(`#${id}`)!;
    this.canvas = element('annotation-canvas'); this.stage = element('annotation-stage'); this.status = element('annotation-status');
    this.undo = element('annotation-undo'); this.clear = element('annotation-clear');
    this.scale = element('annotation-scale');
    this.apply = element('annotation-apply'); this.cancel = element('annotation-cancel');
    this.undo.addEventListener('click', () => this.removeStroke());
    this.scale.addEventListener('click', () => {
      if (!this.session?.bitmap || this.session.applying) return;
      this.finishStroke(); this.actualSize = !this.actualSize;
      this.stage.dataset.actualSize = String(this.actualSize);
      this.scale.textContent = this.actualSize ? '全体表示' : '実寸表示';
      this.fit(); this.stage.scrollTo(0, 0);
    });
    this.clear.addEventListener('click', () => {
      if (!this.session || this.session.applying) return;
      this.finishStroke(); this.session.strokes = []; this.paint(); this.controls(); this.showStatus('');
    });
    this.apply.addEventListener('click', () => void this.commit());
    this.cancel.addEventListener('click', () => this.close());
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (!this.session?.applying) this.close(); });
    dialog.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z') {
        event.preventDefault(); event.stopPropagation(); this.removeStroke();
      }
    });
    this.canvas.addEventListener('pointerdown', event => {
      const session = this.session;
      if (!session?.bitmap || session.applying || session.pointerId !== undefined || !event.isPrimary || event.button !== 0) return;
      event.preventDefault(); this.canvas.focus();
      session.pointerId = event.pointerId;
      session.strokes.push({ width: 3 * this.canvas.width / this.canvas.getBoundingClientRect().width, points: [this.point(event)] });
      this.canvas.setPointerCapture(event.pointerId);
      this.schedulePaint(); this.controls(); this.showStatus('');
    });
    this.canvas.addEventListener('pointermove', event => {
      if (this.session?.pointerId !== event.pointerId) return;
      const events = event.getCoalescedEvents?.();
      for (const point of events?.length ? events : [event]) this.addPoint(point);
      this.schedulePaint();
    });
    this.canvas.addEventListener('pointerup', event => {
      if (this.session?.pointerId !== event.pointerId) return;
      this.addPoint(event); this.finishStroke(); this.schedulePaint();
    });
    for (const type of ['pointercancel', 'lostpointercapture']) this.canvas.addEventListener(type, () => this.finishStroke());
    new ResizeObserver(() => this.fit()).observe(this.stage);
  }

  get opened(): boolean { return this.dialog.open; }

  async open(attachment: Attachment): Promise<void> {
    if (this.opened || attachment.input.type !== 'image' || !isImageDataUrl(attachment.input.url)) return;
    const strokes = structuredClone(attachment.annotation?.strokes ?? []);
    const session: EditSession = { id: attachment.id, originalUrl: attachment.annotation?.originalUrl ?? attachment.input.url,
      strokes, initialStrokes: JSON.stringify(strokes), applying: false };
    this.session = session;
    this.actualSize = false; this.stage.dataset.actualSize = 'false'; this.scale.textContent = '実寸表示';
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.canvas.hidden = true;
    this.showStatus('画像を読み込み中…'); this.controls();
    this.dialog.showModal(); this.changed();
    try {
      const image = new Image(); image.src = session.originalUrl;
      await image.decode();
      const bitmap = await createImageBitmap(image);
      if (this.session !== session) { bitmap.close(); return; }
      session.bitmap = bitmap;
      this.canvas.width = bitmap.width; this.canvas.height = bitmap.height; this.canvas.hidden = false;
      this.fit(); this.paint(); this.showStatus(''); this.controls(); this.canvas.focus();
    } catch {
      if (this.session === session) this.showStatus('画像を読み込めませんでした。', true);
    }
  }

  sync(attachments: Attachment[]): void {
    if (this.session && !attachments.some(attachment => attachment.id === this.session!.id)) this.close();
  }

  handleMessage(message: JsonObject): boolean {
    const session = this.session;
    if (message.type !== 'imageAttachmentUpdated') return false;
    if (!session?.requestId || message.requestId !== session.requestId) return true;
    session.requestId = undefined;
    session.applying = false;
    const attachment = message.attachment as Attachment | undefined;
    if (message.error || !attachment || attachment.id !== session.id || !isImageDataUrl(attachment.input?.url)) {
      this.showStatus(string(message.error, '画像を更新できませんでした。もう一度反映してください。'), true);
      this.controls(); return true;
    }
    this.updated(attachment); this.close();
    return true;
  }

  private close(): void {
    this.finishStroke();
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.session?.bitmap?.close(); this.session = undefined;
    this.canvas.width = 0; this.canvas.height = 0;
    this.dialog.close(); this.changed();
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
    else document.getElementById('prompt')?.focus();
  }

  private controls(): void {
    const session = this.session;
    const drawing = !!session?.bitmap && !session.applying;
    this.undo.disabled = this.clear.disabled = !drawing || !session.strokes.length;
    this.apply.disabled = !drawing;
    this.scale.disabled = !drawing;
    this.cancel.disabled = !!session?.applying;
    this.canvas.setAttribute('aria-disabled', String(!drawing));
  }

  private showStatus(text: string, error = false): void {
    this.status.textContent = text; this.status.hidden = !text;
    this.status.classList.toggle('error-notice', error);
  }

  private fit(): void {
    if (!this.session?.bitmap) return;
    const scale = this.actualSize ? 1 : Math.min(this.stage.clientWidth / this.canvas.width, this.stage.clientHeight / this.canvas.height, 1);
    this.canvas.style.width = `${this.canvas.width * scale}px`;
    this.canvas.style.height = `${this.canvas.height * scale}px`;
  }

  private point(event: PointerEvent): ImagePoint {
    const rect = this.canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(this.canvas.width, (event.clientX - rect.left) * this.canvas.width / rect.width)),
      y: Math.max(0, Math.min(this.canvas.height, (event.clientY - rect.top) * this.canvas.height / rect.height)) };
  }

  private addPoint(event: PointerEvent): void {
    const stroke = this.session?.strokes.at(-1);
    if (!stroke) return;
    const point = this.point(event), last = stroke.points.at(-1)!;
    if (point.x !== last.x || point.y !== last.y) stroke.points.push(point);
  }

  private finishStroke(): void {
    const pointerId = this.session?.pointerId;
    if (pointerId === undefined) return;
    this.session!.pointerId = undefined;
    if (this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId);
  }

  private removeStroke(): void {
    if (!this.session || this.session.applying) return;
    this.finishStroke(); this.session.strokes.pop(); this.paint(); this.controls(); this.showStatus('');
  }

  private schedulePaint(): void {
    if (this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => { this.frame = undefined; this.paint(); });
  }

  private paint(): void {
    const session = this.session, context = this.canvas.getContext('2d');
    if (!session?.bitmap || !context) return;
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    context.drawImage(session.bitmap, 0, 0);
    context.lineCap = context.lineJoin = 'round';
    for (const stroke of session.strokes) for (const [color, factor] of [['#000000', 7 / 3], ['#ffffff', 5 / 3], ['#ff3b30', 1]] as const) {
      context.strokeStyle = context.fillStyle = color; context.lineWidth = stroke.width * factor;
      context.beginPath();
      const first = stroke.points[0]!;
      if (stroke.points.length === 1) { context.arc(first.x, first.y, context.lineWidth / 2, 0, Math.PI * 2); context.fill(); }
      else {
        context.moveTo(first.x, first.y);
        for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y);
        context.stroke();
      }
    }
  }

  private async commit(): Promise<void> {
    const session = this.session;
    if (!session?.bitmap || session.applying) return;
    this.finishStroke();
    if (JSON.stringify(session.strokes) === session.initialStrokes) { this.close(); return; }
    session.applying = true; this.controls(); this.showStatus('画像を反映中…');
    try {
      let url = session.originalUrl;
      if (session.strokes.length) {
        this.paint();
        const blob = await new Promise<Blob>((resolve, reject) => this.canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('画像を作成できませんでした。')), 'image/png'));
        if (blob.size > MAX_IMAGE_ATTACHMENT_BYTES) throw new Error(IMAGE_FORMAT_ERROR);
        url = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('画像を読み込めませんでした。'));
          reader.onerror = reader.onabort = () => reject(new Error('画像を読み込めませんでした。'));
          reader.readAsDataURL(blob);
        });
      }
      if (this.session !== session) return;
      session.requestId = crypto.randomUUID();
      this.post('updateImageAttachment', { requestId: session.requestId, id: session.id, url, strokes: session.strokes });
    } catch (error) {
      if (this.session !== session) return;
      session.applying = false; this.controls();
      this.showStatus(error instanceof Error ? error.message : '画像を更新できませんでした。', true);
    }
  }
}
