export const MAX_MESSAGE_BYTES = 128 * 1024 * 1024;

export function serializeMessage(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('送信データをJSONに変換できませんでした。');
  if (Buffer.byteLength(json) > MAX_MESSAGE_BYTES) throw new Error('送信データは128MiB以下にしてください。画像や添付を減らしてください。');
  return json;
}
