import { describe, expect, it } from 'vitest';
import { credentials } from './validation.js';

describe('authentication input validation', () => {
  it('trims and normalizes email addresses', () => {
    expect(
      credentials.parse({ email: '  Person@Example.COM  ', password: 'a safe passphrase' }),
    ).toEqual({
      email: 'person@example.com',
      password: 'a safe passphrase',
    });
  });

  it('rejects passwords that exceed bcrypt’s UTF-8 byte limit', () => {
    expect(() =>
      credentials.parse({ email: 'person@example.com', password: '😀'.repeat(19) }),
    ).toThrow('Password must not exceed 72 UTF-8 bytes.');
  });
});
