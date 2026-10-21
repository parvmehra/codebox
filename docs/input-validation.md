# Input validation

API request bodies and route parameters are validated with Zod before database writes. Email addresses are trimmed and normalized to lowercase. Passwords are limited to bcrypt's 72-byte UTF-8 input size. Problem descriptions, examples, and test-case input/output have explicit size limits; test-case limits are checked by encoded bytes as well as JavaScript string length.

The JSON parser also rejects bodies larger than 1 MB. These application bounds make error behavior predictable and limit accidental oversized writes; they do not replace authentication, rate limits, or sandbox isolation.

## Learning notes

- **Problem solved:** invalid and oversized input is rejected at the API boundary instead of surfacing as a database error or being silently truncated by bcrypt.
- **Why validate bytes:** JavaScript string length counts UTF-16 code units, while bcrypt and network/storage limits operate on encoded bytes.
- **Important failure case:** a non-ASCII password can fit within 72 characters but exceed bcrypt's byte limit. The API returns a validation error rather than hashing a truncated password.
- **Interview question — Why normalize email?** The database's unique key is case-sensitive, so normalization prevents visually identical addresses from creating separate accounts.
