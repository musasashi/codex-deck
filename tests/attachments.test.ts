import test from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_TYPES, isImageDataUrl, isImageStrokes, MAX_IMAGE_ATTACHMENT_BYTES } from '../src/core/attachments';

test('inline images accept supported formats and enforce the decoded 32MiB limit', () => {
  for (const type of IMAGE_TYPES) assert.equal(isImageDataUrl(`data:${type};base64,YQ==`), true);
  for (const size of [8 * 1024 * 1024 + 1, MAX_IMAGE_ATTACHMENT_BYTES - 1, MAX_IMAGE_ATTACHMENT_BYTES, MAX_IMAGE_ATTACHMENT_BYTES + 1]) {
    assert.equal(isImageDataUrl(`data:image/png;base64,${Buffer.alloc(size).toString('base64')}`), size <= MAX_IMAGE_ATTACHMENT_BYTES);
  }
});

test('image strokes accept dots and lines but reject malformed coordinates and widths', () => {
  assert.equal(isImageStrokes([]), true);
  assert.equal(isImageStrokes([{ width: 3, points: [{ x: 0, y: 5 }, { x: 120, y: 80 }] }]), true);
  for (const value of [undefined, {}, [null], [{ width: 0, points: [{ x: 0, y: 0 }] }], [{ width: Infinity, points: [{ x: 0, y: 0 }] }],
    [{ width: 3, points: [] }], [{ width: 3, points: [null] }], [{ width: 3, points: [{ x: NaN, y: 0 }] }],
    [{ width: 3, points: [{ x: -1, y: 0 }] }], [{ width: 3, points: [{ x: 0, y: '1' }] }]]) assert.equal(isImageStrokes(value), false);
});

test('inline images reject remote URLs, executable formats and malformed base64', () => {
  for (const value of [undefined, {}, 'https://example.com/image.png', 'data:image/svg+xml;base64,PHN2Zz4=',
    'data:text/html;base64,YQ==', 'data:image/png;base64,', 'data:image/png;base64,A===',
    'data:image/png;base64,Y=Q=', 'data:image/png;base64,YQ', 'data:image/png;base64,YQ==" onerror="alert(1)',
    'data:image/png;base64,YQ==\n', 'data:image/png;base64,YQ=\n']) assert.equal(isImageDataUrl(value), false);
});
