import { describe, expect, it } from 'vitest';

process.env.JWT_SECRET = 'test-secret';

import { generateToken, verifyToken } from '../src/utils/jwt';

describe('jwt utils', () => {
  it('round trips the payload', () => {
    const token = generateToken({ djId: 'dj-1', email: 'dj@example.com' });

    expect(verifyToken(token)).toMatchObject({ djId: 'dj-1', email: 'dj@example.com' });
  });

  it('rejects a tampered payload', () => {
    const token = generateToken({ djId: 'dj-1', email: 'dj@example.com' });
    const [header, , signature] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ djId: 'dj-1', email: 'dj@example.com', isAdmin: true })
    ).toString('base64url');

    expect(() => verifyToken(`${header}.${forgedPayload}.${signature}`)).toThrow();
  });

  it('rejects a token signed with another secret', async () => {
    const jwt = await import('jsonwebtoken');
    const forged = jwt.default.sign({ djId: 'dj-1', email: 'dj@example.com' }, 'other-secret');

    expect(() => verifyToken(forged)).toThrow();
  });
});
