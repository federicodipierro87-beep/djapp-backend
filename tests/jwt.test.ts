import { describe, expect, it, vi } from 'vitest';
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

describe('startup guard', () => {
  it('refuses to load without JWT_SECRET instead of picking a default', async () => {
    const original = process.env.JWT_SECRET;
    vi.resetModules();
    // dotenv would repopulate the variable from a developer's local .env, which
    // is precisely what must not decide the outcome here.
    vi.doMock('dotenv', () => ({ default: { config: () => ({}) } }));
    delete process.env.JWT_SECRET;

    try {
      await expect(import('../src/config/env')).rejects.toThrow(/JWT_SECRET/);
    } finally {
      process.env.JWT_SECRET = original;
      vi.doUnmock('dotenv');
      vi.resetModules();
    }
  });
});
