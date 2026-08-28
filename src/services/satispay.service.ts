import crypto from 'crypto';
import axios, { Method } from 'axios';
import { decryptSecret } from '../utils/secrets';

// Satispay authenticates every call with an HTTP signature over four specific
// headers. The format is not negotiable and getting any part of it wrong - the
// order of the lines, the date format, a missing digest on a GET - is a 401 with
// no further explanation, so the parts are separated out and unit tested.
//
// Reference: https://developers.satispay.com/reference/create-the-string

const SIGNED_HEADERS = '(request-target) host date digest';

// The digest of an empty body, which every GET and every unsigned-body request
// still has to send.
const EMPTY_DIGEST = 'SHA-256=47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=';

export interface SatispayCredentials {
  // Issued by Satispay when the public key is activated. Not a secret.
  keyId: string;
  // PEM, and the reason DJ credentials are encrypted at rest.
  privateKey: string;
}

// Only the fields this server acts on. Satispay returns a good deal more.
export interface SatispayPayment {
  id: string;
  status: 'PENDING' | 'AUTHORIZED' | 'ACCEPTED' | 'CANCELED';
  amount_unit: number;
  currency: string;
  redirect_url?: string;
  code_identifier?: string;
  expired?: boolean;
}

export function satispayHost(): string {
  return process.env.SATISPAY_MODE === 'live'
    ? 'authservices.satispay.com'
    : 'staging.authservices.satispay.com';
}

// SHA-256 of the exact bytes that go on the wire. Computed from the serialised
// string rather than the object, because re-serialising it later would produce
// different bytes and a digest that does not match.
export function bodyDigest(body: string): string {
  if (body === '') return EMPTY_DIGEST;
  return `SHA-256=${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}`;
}

// Four lines joined by newlines, with no trailing newline. The method is lower
// case and the path includes the query string.
export function signingString(
  method: string,
  path: string,
  host: string,
  date: string,
  digest: string
): string {
  return [
    `(request-target): ${method.toLowerCase()} ${path}`,
    `host: ${host}`,
    `date: ${date}`,
    `digest: ${digest}`
  ].join('\n');
}

// rsa-sha256 in the HTTP Signatures sense is PKCS#1 v1.5, not PSS. Node signs
// with PKCS#1 v1.5 by default; it is named here so nobody has to remember that.
export function signMessage(privateKey: string, message: string): string {
  return crypto
    .sign('sha256', Buffer.from(message, 'utf8'), {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_PADDING
    })
    .toString('base64');
}

export function authorizationHeader(credentials: SatispayCredentials, message: string): string {
  return [
    `Signature keyId="${credentials.keyId}"`,
    'algorithm="rsa-sha256"',
    `headers="${SIGNED_HEADERS}"`,
    `signature="${signMessage(credentials.privateKey, message)}"`
  ].join(', ');
}

// Everything a signed call needs, built together so the headers and the string
// that was signed can never drift apart.
export function signedHeaders(
  credentials: SatispayCredentials,
  method: string,
  path: string,
  body: string,
  host = satispayHost(),
  // RFC 1123, in English. toUTCString() produces exactly that regardless of the
  // server locale, which toLocaleString() would not.
  date = new Date().toUTCString()
): Record<string, string> {
  const digest = bodyDigest(body);

  return {
    Host: host,
    Date: date,
    Digest: digest,
    Authorization: authorizationHeader(
      credentials,
      signingString(method, path, host, date, digest)
    ),
    'Content-Type': 'application/json'
  };
}

export class SatispayService {
  private async call<T>(
    credentials: SatispayCredentials,
    method: Method,
    path: string,
    payload?: unknown,
    extraHeaders: Record<string, string> = {}
  ): Promise<T> {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const host = satispayHost();

    const response = await axios.request<T>({
      method,
      url: `https://${host}${path}`,
      // The serialised string, not the object. axios would re-serialise an
      // object and the digest computed above would no longer describe it.
      data: body === '' ? undefined : body,
      headers: { ...signedHeaders(credentials, method, path, body, host), ...extraHeaders },
      // Satispay's errors carry a reason in the body, which is lost if axios
      // throws before the caller can look at it.
      validateStatus: () => true
    });

    if (response.status >= 400) {
      throw new Error(
        `Satispay ${method} ${path} failed with ${response.status}: ${JSON.stringify(response.data)}`
      );
    }

    return response.data;
  }

  // Turns the guest's approval into a hold on their balance. FUND_LOCK is the
  // only flow that matches how this app works: the money is reserved when the
  // request is made and taken only if the DJ plays the song.
  //
  // The payment is created PENDING and becomes AUTHORIZED once the guest
  // approves it in the Satispay app.
  async createFundLock(
    credentials: SatispayCredentials,
    amountInCents: number,
    currency: string,
    requestId: string
  ): Promise<SatispayPayment> {
    const frontend = process.env.FRONTEND_URL ?? '';
    const backend = process.env.BACKEND_URL ?? '';

    return this.call<SatispayPayment>(
      credentials,
      'POST',
      '/g_business/v1/payments',
      {
        flow: 'FUND_LOCK',
        amount_unit: amountInCents,
        currency,
        // Max 50 characters; a uuid is 36.
        external_code: requestId,
        // Satispay substitutes the payment id for {uuid}. The callback carries
        // no status, so this is only a nudge to go and read the payment.
        callback_url: `${backend}/api/payments/webhook/satispay?paymentId={uuid}`,
        redirect_url: `${frontend}/payment/return?requestId=${requestId}`
        // expiration_date is deliberately left off. Satispay's default of ten
        // days outlasts any night, and a hold that lapses while the song is
        // still in the queue is a donation the DJ never receives. Abandoned
        // drafts are cancelled by the expiry sweep long before then.
      },
      // A retried create must not put a second hold on the guest's balance.
      { 'Idempotency-Key': `request-${requestId}` }
    );
  }

  async getPayment(credentials: SatispayCredentials, paymentId: string): Promise<SatispayPayment> {
    return this.call<SatispayPayment>(credentials, 'GET', `/g_business/v1/payments/${paymentId}`);
  }

  // Takes the money that has been on hold. The amount is required and may be
  // less than the amount locked, never more - so it is sent explicitly rather
  // than left to Satispay to infer.
  async acceptPayment(
    credentials: SatispayCredentials,
    paymentId: string,
    amountInCents: number
  ): Promise<SatispayPayment> {
    return this.call<SatispayPayment>(credentials, 'PUT', `/g_business/v1/payments/${paymentId}`, {
      action: 'ACCEPT',
      amount_unit: amountInCents
    });
  }

  // Releases the hold. Only valid while the payment is PENDING or AUTHORIZED;
  // once it is ACCEPTED the money is gone and a refund is a separate payment.
  async cancelPayment(credentials: SatispayCredentials, paymentId: string): Promise<SatispayPayment> {
    return this.call<SatispayPayment>(credentials, 'PUT', `/g_business/v1/payments/${paymentId}`, {
      action: 'CANCEL'
    });
  }

  // The one call that is not signed, because it is how a key gets the id that
  // signing needs. The token is a single-use activation code the DJ copies out
  // of their Satispay Business dashboard.
  async activateKey(publicKey: string, token: string): Promise<{ key_id: string }> {
    const response = await axios.post<{ key_id: string }>(
      `https://${satispayHost()}/g_business/v1/authentication_keys`,
      { public_key: publicKey, token },
      { validateStatus: () => true }
    );

    if (response.status >= 400) {
      throw new Error(
        `Satispay key activation failed with ${response.status}: ${JSON.stringify(response.data)}`
      );
    }

    return response.data;
  }

  // Satispay's own signature checker. It answers 200 either way and reports in
  // the body whether the signature was actually validated: an unverified caller
  // comes back as "public". Checking for anything else catches a key that was
  // never activated or has been revoked here, rather than on the first real
  // payment in front of a guest.
  async verifyCredentials(credentials: SatispayCredentials): Promise<boolean> {
    const result = await this.call<{ authentication_key?: { role?: string } }>(
      credentials,
      'POST',
      '/wally-services/protocol/tests/signature',
      {}
    ).catch(() => null);

    const role = result?.authentication_key?.role;
    return Boolean(role) && role !== 'public';
  }
}

// A DJ's stored credentials, ready to sign with, or null if they have not
// connected Satispay. Every caller has to handle the null: without it there is
// no way to reach that DJ's money and the method is simply not on offer.
export function satispayCredentialsFor(dj: {
  satispayKeyId: string | null;
  satispayPrivateKey: string | null;
}): SatispayCredentials | null {
  if (!dj.satispayKeyId || !dj.satispayPrivateKey) return null;

  return { keyId: dj.satispayKeyId, privateKey: decryptSecret(dj.satispayPrivateKey) };
}

// Generated here rather than by the DJ so that a private key for money never
// travels over anything, not even once. The DJ only ever sends us an activation
// code, which is useless on its own.
export function generateKeyPair(): { publicKey: string; privateKey: string } {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
}

export const satispayService = new SatispayService();
