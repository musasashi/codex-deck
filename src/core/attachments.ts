export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const IMAGE_FORMAT_ERROR = '8MB以下のPNG・JPEG・WebP・GIF画像を使用してください。';

export function isImageDataUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 32) return false;
  const prefix = /^data:(image\/[a-z]+);base64,/.exec(value);
  if (!prefix || !IMAGE_TYPES.has(prefix[1]!)) return false;
  const data = value.slice(prefix[0].length);
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  if (!data.length || data.length % 4 || /[^A-Za-z0-9+/]/.test(data.slice(0, data.length - padding))) return false;
  const bytes = data.length / 4 * 3 - padding;
  return bytes <= MAX_ATTACHMENT_BYTES;
}
