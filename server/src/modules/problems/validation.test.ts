import { describe, expect, it } from 'vitest';
import { createProblemInput, testCaseInput } from './validation.js';

const validProblem = {
  slug: 'two-sum',
  title: 'Two Sum',
  description: 'Return the pair of indices.',
  difficulty: 'EASY',
  constraints: 'Two values exist.',
  inputFormat: 'An array and target.',
  outputFormat: 'Two indices.',
  examples: [{ input: '2 7', output: '0 1' }],
};

describe('problem input validation', () => {
  it('normalizes surrounding whitespace in problem copy', () => {
    expect(createProblemInput.parse({ ...validProblem, title: '  Two Sum  ' }).title).toBe(
      'Two Sum',
    );
  });

  it('rejects unbounded descriptions and oversized examples', () => {
    expect(() =>
      createProblemInput.parse({ ...validProblem, description: 'x'.repeat(20_001) }),
    ).toThrow();
    expect(() =>
      createProblemInput.parse({
        ...validProblem,
        examples: [{ input: 'x'.repeat(20_001), output: '0' }],
      }),
    ).toThrow();
  });

  it('measures test data in UTF-8 bytes as well as characters', () => {
    expect(() => testCaseInput.parse({ input: '😀'.repeat(25_001), expectedOut: 'ok' })).toThrow(
      'Text must not exceed 100000 UTF-8 bytes.',
    );
  });
});
