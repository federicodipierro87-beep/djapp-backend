import { describe, expect, it } from 'vitest';

import {
  RESET_TOKEN_TTL_MS,
  generateResetToken,
  hashResetToken,
  isResetTokenExpired,
  isTokenStale
} from '../src/utils/passwordReset';
import { forgotPasswordSchema, resetPasswordSchema } from '../src/controllers/auth.controller';

describe('reset tokens', () => {
  it('verifies a token against its own hash and not against another', () => {
    const mine = generateResetToken();
    const someoneElses = generateResetToken();

    expect(hashResetToken(mine.token)).toBe(mine.tokenHash);
    expect(hashResetToken(someoneElses.token)).not.toBe(mine.tokenHash);
  });

  // The whole reason the column exists in this shape: a copy of the djs table
  // must not be a list of working reset links.
  it('stores something that is not the token', () => {
    const { token, tokenHash } = generateResetToken();

    expect(tokenHash).not.toBe(token);
    expect(tokenHash).not.toContain(token);
  });

  it('gives the link an hour', () => {
    const now = new Date('2026-09-01T12:00:00.000Z');
    const { expiresAt } = generateResetToken(now);

    expect(expiresAt.getTime() - now.getTime()).toBe(RESET_TOKEN_TTL_MS);
  });

  it('refuses a token past its expiry', () => {
    const now = new Date('2026-09-01T12:00:00.000Z');
    const { expiresAt } = generateResetToken(now);

    expect(isResetTokenExpired(expiresAt, new Date(now.getTime() + 59 * 60 * 1000))).toBe(false);
    expect(isResetTokenExpired(expiresAt, new Date(now.getTime() + 61 * 60 * 1000))).toBe(true);
  });

  // A DJ who has never asked for a reset has no expiry either, so a lookup that
  // somehow found them must not be treated as a live link.
  it('refuses a missing expiry', () => {
    expect(isResetTokenExpired(null)).toBe(true);
  });
});

describe('session invalidation', () => {
  const changedAt = new Date('2026-09-01T12:00:00.400Z');
  const second = Math.floor(changedAt.getTime() / 1000);

  // The trap: iat is whole seconds and passwordChangedAt carries milliseconds,
  // so comparing them directly throws out the token issued by the login the DJ
  // makes right after the reset - correct password, still locked out.
  it('accepts a token issued in the same second as the change', () => {
    expect(isTokenStale(changedAt, second)).toBe(false);
  });

  it('rejects a token issued the second before', () => {
    expect(isTokenStale(changedAt, second - 1)).toBe(true);
  });

  it('accepts a token issued afterwards', () => {
    expect(isTokenStale(changedAt, second + 1)).toBe(false);
  });

  // Nothing has invalidated anything yet, which is every DJ until they reset.
  it('accepts everything when the password has never changed', () => {
    expect(isTokenStale(null, second - 10_000)).toBe(false);
  });
});

describe('request schemas', () => {
  it('takes an email and rejects what is not one', () => {
    expect(forgotPasswordSchema.parse({ email: ' dj@example.com ' })).toEqual({
      email: 'dj@example.com'
    });
    expect(forgotPasswordSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });

  it('rejects a password under six characters', () => {
    const token = generateResetToken().token;

    expect(resetPasswordSchema.safeParse({ token, password: 'abcde' }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ token, password: 'abcdef' }).success).toBe(true);
  });

  // Anything that is not shaped like one of our tokens is turned away before it
  // reaches the database.
  it('rejects a malformed token', () => {
    const password = 'nuova-password';

    expect(resetPasswordSchema.safeParse({ token: 'short', password }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ token: 'g'.repeat(64), password }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ token: '', password }).success).toBe(false);
  });
});
