import crypto from 'crypto';
import { describe, expect, it } from 'vitest';

// Read when the module first needs a key, so it has to be set before the import
// below rather than inside a test.
process.env.CREDENTIALS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const { decryptSecret, encryptSecret, encryptionAvailable } = await import('../src/utils/secrets');

describe('encryptSecret', () => {
  it('round trips a private key', () => {
    const secret = '-----BEGIN PRIVATE KEY-----\nnot really\n-----END PRIVATE KEY-----\n';

    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it('does not leave the secret readable in what it stores', () => {
    expect(encryptSecret('hunter2')).not.toContain('hunter2');
  });

  it('uses a fresh iv every time, so identical secrets do not look identical', () => {
    // Two DJs who somehow held the same key must not be visibly matched by
    // comparing the two columns.
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('refuses a value that has been tampered with', () => {
    const [iv, tag, ciphertext] = encryptSecret('signing key').split(':');
    const flipped = Buffer.from(ciphertext, 'base64');
    flipped[0] ^= 0xff;

    expect(() => decryptSecret([iv, tag, flipped.toString('base64')].join(':'))).toThrow();
  });

  it('refuses a value that is not in the stored format at all', () => {
    expect(() => decryptSecret('just some text')).toThrow();
  });
});

describe('encryptionAvailable', () => {
  it('is true once a well formed key is configured', () => {
    expect(encryptionAvailable()).toBe(true);
  });
});
