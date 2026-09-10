import test from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_TYPES, isImageDataUrl, MAX_ATTACHMENT_BYTES } from '../src/core/attachments';

test('inline images accept supported formats and enforce the decoded 8MB limit', () => {
  for (const type of IMAGE_TYPES) assert.equal(isImageDataUrl(`data:${type};base64,YQ==`), true);
  for (const size of [MAX_ATTACHMENT_BYTES - 1, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES + 1]) {
    assert.equal(isImageDataUrl(`data:image/png;base64,${Buffer.alloc(size).toString('base64')}`), size <= MAX_ATTACHMENT_BYTES);
  }
});

test('inline images reject remote URLs, executable formats and malformed base64', () => {
  for (const value of [undefined, {}, 'https://example.com/image.png', 'data:image/svg+xml;base64,PHN2Zz4=',
    'data:text/html;base64,YQ==', 'data:image/png;base64,', 'data:image/png;base64,A===',
    'data:image/png;base64,Y=Q=', 'data:image/png;base64,YQ', 'data:image/png;base64,YQ==" onerror="alert(1)',
    'data:image/png;base64,YQ==\n', 'data:image/png;base64,YQ=\n']) assert.equal(isImageDataUrl(value), false);
});
