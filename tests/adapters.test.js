import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getPlatformLabel, isLmsAdapter } from '../adapters/index.js';

test('resolves named platforms by domain', () => {
  assert.equal(getPlatformLabel('https://www.coursera.org/learn/neural-networks'), 'Coursera');
  assert.equal(getPlatformLabel('https://www.udemy.com/course/x/learn/lecture/1'), 'Udemy');
});

test('splits LinkedIn social from LinkedIn Learning by path', () => {
  assert.equal(getPlatformLabel('https://www.linkedin.com/feed/'), 'LinkedIn');
  assert.equal(getPlatformLabel('https://www.linkedin.com/learning/python-basics/welcome'), 'LinkedIn Learning');

  assert.equal(isLmsAdapter('https://www.linkedin.com/feed/'), false);
  assert.equal(isLmsAdapter('https://www.linkedin.com/learning/python-basics/welcome'), true);
});

test('returns null for sites with no matching adapter', () => {
  assert.equal(getPlatformLabel('https://example.com'), null);
  assert.equal(isLmsAdapter('https://example.com'), false);
});
