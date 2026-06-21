import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFixture } from './helpers.js';
import { getSelectors } from '../adapters/index.js';
import { extractOutline } from '../page-scripts/outline.js';
import { quizPageScript } from '../page-scripts/quiz.js';
import { extractTranscript } from '../page-scripts/transcript.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COURSE_URL = 'https://www.udemy.com/course/complete-python-bootcamp/learn/lecture/1';
const fixture = (name) => path.join(__dirname, 'fixtures', 'udemy', name);

test('outline: finds curriculum items via the Udemy-specific selector', () => {
  loadFixture(fixture('outline.html'));
  const result = extractOutline(getSelectors(COURSE_URL, 'outline'));

  assert.equal(result.success, true);
  assert.equal(result.itemCount, 3);
  assert.equal(result.items[0].title, 'Section 1: Introduction');
  assert.equal(result.items[2].title, 'Quiz 1: Python Basics');
});

test('quiz extraction: falls back to generic role=group markup (Udemy has no dedicated quiz selectors yet)', () => {
  loadFixture(fixture('quiz.html'));
  const result = quizPageScript(getSelectors(COURSE_URL, 'quiz'), 'extract');

  assert.equal(result.success, true);
  assert.equal(result.questionCount, 1);
  assert.equal(result.questions[0].question, 'Which keyword defines a function in Python?');
  assert.equal(result.questions[0].optionCount, 3);
});

test('transcript: extracts text from the Udemy transcript panel', () => {
  loadFixture(fixture('transcript.html'));
  const result = extractTranscript(getSelectors(COURSE_URL, 'transcript'));

  assert.equal(result.success, true);
  assert.match(result.text, /Python Bootcamp/);
});
