import { z } from 'zod';

export const credentials = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(255)
    .transform((email) => email.toLowerCase()),
  password: z
    .string()
    .min(8)
    .max(72)
    .refine((password) => Buffer.byteLength(password, 'utf8') <= 72, {
      message: 'Password must not exceed 72 UTF-8 bytes.',
    }),
});
