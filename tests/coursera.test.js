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
const COURSE_URL = 'https://www.coursera.org/learn/neural-networks';
const fixture = (name) => path.join(__dirname, 'fixtures', 'coursera', name);

test('outline: finds items in document order and marks completion', () => {
  loadFixture(fixture('outline.html'));
  const result = extractOutline(getSelectors(COURSE_URL, 'outline'));

  assert.equal(result.success, true);
  assert.equal(result.itemCount, 3);
  assert.equal(result.items[0].title, 'Welcome to the Course');
  assert.equal(result.items[0].completed, true);
  assert.equal(result.items[1].title, 'Introduction to Perceptrons');
  assert.equal(result.items[1].completed, false);
});

test('quiz extraction: reads questions, text, and option counts', () => {
  loadFixture(fixture('quiz.html'));
  const result = quizPageScript(getSelectors(COURSE_URL, 'quiz'), 'extract');

  assert.equal(result.success, true);
  assert.equal(result.questionCount, 2);
  assert.equal(result.questions[0].question, 'What does a perceptron compute?');
  assert.equal(result.questions[0].optionCount, 3);
  assert.equal(result.questions[1].optionCount, 3);
});

test('quiz answering: selects the requested option and checks the input', () => {
  loadFixture(fixture('quiz.html'));
  const result = quizPageScript(getSelectors(COURSE_URL, 'quiz'), 'select', 0, 1);

  assert.equal(result.success, true);
  assert.match(result.selectedLabel, /random number/);

  const inputs = document.querySelectorAll('input[name="q1"]');
  assert.equal(inputs[1].checked, true);
  assert.equal(inputs[0].checked, false);
});

test('quiz answering: rejects out-of-range indices', () => {
  loadFixture(fixture('quiz.html'));
  const result = quizPageScript(getSelectors(COURSE_URL, 'quiz'), 'select', 5, 0);

  assert.equal(result.success, false);
});

test('transcript: concatenates paragraph text from the Coursera container', () => {
  loadFixture(fixture('transcript.html'));
  const result = extractTranscript(getSelectors(COURSE_URL, 'transcript'));

  assert.equal(result.success, true);
  assert.match(result.text, /perceptrons/);
});
