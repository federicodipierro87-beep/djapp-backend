import crypto from 'crypto';

// Reversible encryption for the few secrets this server holds on someone else's
// behalf. Passwords are hashed instead, and must stay that way: these are values
// we have to be able to read back, which is a weaker guarantee and is only
// acceptable because the alternative is storing them in the clear.
//
// The only one today is a DJ's Satispay private key. It is the key that signs
// requests for money out of their business account, so the database alone must
// not be enough to use it.

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;

  const configured = process.env.CREDENTIALS_ENCRYPTION_KEY;

  if (!configured) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY is not configured');
  }

  // Base64 of 32 random bytes: `openssl rand -base64 32`. A passphrase would be
  // guessable, so the length is checked rather than stretched.
  const decoded = Buffer.from(configured, 'base64');

  if (decoded.length !== 32) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY must be 32 bytes, base64 encoded');
  }

  cachedKey = decoded;
  return cachedKey;
}

// Whether a secret can be stored at all. Checked at startup so the failure is a
// boot error rather than a DJ getting halfway through connecting Satispay.
export function encryptionAvailable(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

// iv:tag:ciphertext, all base64. Self-describing, so a future key rotation can
// tell an old value from a new one without a schema change.
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(
    ':'
  );
}

export function decryptSecret(stored: string): string {
  const [iv, tag, ciphertext] = stored.split(':');

  if (!iv || !tag || !ciphertext) {
    throw new Error('Stored secret is not in the expected format');
  }

  const authTag = Buffer.from(tag, 'base64');

  if (authTag.length !== TAG_LENGTH) {
    throw new Error('Stored secret has the wrong authentication tag length');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key(), Buffer.from(iv, 'base64'));
  // GCM verifies this on final(), so a value edited in the database fails to
  // decrypt rather than decrypting to something else.
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString(
    'utf8'
  );
}
