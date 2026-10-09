import type { ImageStroke } from './types';

export const MAX_IMAGE_ATTACHMENT_BYTES = 32 * 1024 * 1024;
export const MAX_TEXT_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const IMAGE_FORMAT_ERROR = '32MiB以下のPNG・JPEG・WebP・GIF画像を使用してください。';

export function isImageDataUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_IMAGE_ATTACHMENT_BYTES / 3) * 4 + 32) return false;
  const prefix = /^data:(image\/[a-z]+);base64,/.exec(value);
  if (!prefix || !IMAGE_TYPES.has(prefix[1]!)) return false;
  const data = value.slice(prefix[0].length);
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  if (!data.length || data.length % 4 || /[^A-Za-z0-9+/]/.test(data.slice(0, data.length - padding))) return false;
  const bytes = data.length / 4 * 3 - padding;
  return bytes <= MAX_IMAGE_ATTACHMENT_BYTES;
}

export function isImageStrokes(value: unknown): value is ImageStroke[] {
  return Array.isArray(value) && value.every(stroke => stroke && typeof stroke === 'object'
    && Number.isFinite(stroke.width) && stroke.width > 0
    && Array.isArray(stroke.points) && stroke.points.length > 0
    && stroke.points.every((point: { x?: unknown; y?: unknown } | null) => point && typeof point === 'object'
      && typeof point.x === 'number' && Number.isFinite(point.x) && point.x >= 0
      && typeof point.y === 'number' && Number.isFinite(point.y) && point.y >= 0));
}
