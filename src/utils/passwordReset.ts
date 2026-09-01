import { createHash, randomBytes } from 'crypto';

// Long enough that a reset link cannot be reached by trying, short enough to
// survive being copied out of an email client that wraps lines.
const TOKEN_BYTES = 32;

export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * SHA-256 and not bcrypt on purpose. bcrypt is slow so that guessing a human's
 * password costs something; a token of 32 random bytes has nothing to guess, so
 * the cost would only be paid by the server on every reset.
 */
export const hashResetToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export const generateResetToken = (now: Date = new Date()) => {
  const token = randomBytes(TOKEN_BYTES).toString('hex');

  return {
    token,
    tokenHash: hashResetToken(token),
    expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS)
  };
};

export const isResetTokenExpired = (
  expiresAt: Date | null | undefined,
  now: Date = new Date()
): boolean => !expiresAt || expiresAt.getTime() <= now.getTime();

/**
 * Whether a JWT was issued before the password last changed, in which case it
 * belongs to a session that the change was meant to end.
 *
 * `iat` is in whole seconds while passwordChangedAt carries milliseconds, so
 * both sides are truncated to the second before comparing. Comparing
 * milliseconds against `iat * 1000` would reject the token handed out by the
 * login that immediately follows a reset - the DJ would type the password they
 * just chose and still be thrown out. Inside the same second the doubt is
 * resolved in favour of letting the request through.
 */
export const isTokenStale = (
  passwordChangedAt: Date | null | undefined,
  issuedAt: number | undefined
): boolean => {
  if (!passwordChangedAt) return false;
  // A token with no iat cannot be placed in time. Tokens are signed here and
  // jsonwebtoken always sets it, so this is not a case that arises in practice.
  if (typeof issuedAt !== 'number') return true;

  return Math.floor(passwordChangedAt.getTime() / 1000) > issuedAt;
};
