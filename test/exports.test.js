import { test } from 'node:test';
import assert from 'node:assert/strict';

test('package exports resolve', async () => {
  const core = await import('cdp-screenshot-extension/core');
  const electron = await import('cdp-screenshot-extension/adapter-electron');
  assert.equal(typeof core, 'object');
  assert.equal(typeof electron, 'object');
});
