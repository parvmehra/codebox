import { z } from 'zod';

function boundedUtf8Text(maxBytes: number) {
  return z
    .string()
    .max(maxBytes)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= maxBytes, {
      message: `Text must not exceed ${maxBytes} UTF-8 bytes.`,
    });
}

export const createProblemInput = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .max(120),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(1).max(20_000),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']),
  constraints: z.string().trim().min(1).max(5_000),
  inputFormat: z.string().trim().min(1).max(2_000),
  outputFormat: z.string().trim().min(1).max(2_000),
  examples: z
    .array(
      z.object({
        input: z.string().max(20_000),
        output: z.string().max(20_000),
        explanation: z.string().max(20_000).optional(),
      }),
    )
    .max(10),
  isPublished: z.boolean().default(false),
});

export const testCaseInput = z.object({
  input: boundedUtf8Text(100_000),
  expectedOut: boundedUtf8Text(100_000),
  isHidden: z.boolean().default(true),
});

export const updateTestCaseInput = testCaseInput.extend({
  expectedVersion: z.number().int().positive(),
});
