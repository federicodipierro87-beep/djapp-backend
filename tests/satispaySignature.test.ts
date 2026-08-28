import crypto from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  authorizationHeader,
  bodyDigest,
  generateKeyPair,
  signMessage,
  signedHeaders,
  signingString
} from '../src/services/satispay.service';

// Satispay answers a malformed signature with a bare 401, so none of this can be
// caught by trying it: either the shape is right before it ships or the
// integration is dead on arrival. Everything here is checked against the
// published specification and against Node's own verifier, with no network.
//
// https://developers.satispay.com/reference/create-the-string

let publicKey: string;
let privateKey: string;

beforeAll(() => {
  // 2048 rather than the 4096 used in production: the key is thrown away at the
  // end of the file and generating it is the slowest thing in the suite.
  const pair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  publicKey = pair.publicKey;
  privateKey = pair.privateKey;
});

const credentials = () => ({ keyId: 'key-1', privateKey });

describe('bodyDigest', () => {
  it('prefixes the algorithm, as the header format requires', () => {
    const body = '{"flow":"FUND_LOCK"}';
    const expected = crypto.createHash('sha256').update(body).digest('base64');

    expect(bodyDigest(body)).toBe(`SHA-256=${expected}`);
  });

  it('digests an empty body rather than omitting the header', () => {
    // A GET has no body and still has to send this, which is the single most
    // common reason a first integration gets 401s.
    expect(bodyDigest('')).toBe('SHA-256=47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
    expect(bodyDigest('')).toBe(
      `SHA-256=${crypto.createHash('sha256').update('').digest('base64')}`
    );
  });
});

describe('signingString', () => {
  it('is the four headers, in order, joined by newlines and nothing else', () => {
    const message = signingString(
      'POST',
      '/g_business/v1/payments',
      'staging.authservices.satispay.com',
      'Mon, 05 Jan 2026 12:00:00 GMT',
      'SHA-256=abc'
    );

    expect(message).toBe(
      '(request-target): post /g_business/v1/payments\n' +
        'host: staging.authservices.satispay.com\n' +
        'date: Mon, 05 Jan 2026 12:00:00 GMT\n' +
        'digest: SHA-256=abc'
    );
    // A trailing newline would change the hash and fail verification.
    expect(message.endsWith('\n')).toBe(false);
  });

  it('lower-cases the method in the request target', () => {
    const message = signingString('PUT', '/g_business/v1/payments/p-1', 'host', 'date', 'digest');

    expect(message.startsWith('(request-target): put /g_business/v1/payments/p-1')).toBe(true);
  });
});

describe('signMessage', () => {
  it('signs with PKCS#1 v1.5, which is what rsa-sha256 means here', () => {
    const message = 'anything';
    const signature = Buffer.from(signMessage(privateKey, message), 'base64');

    expect(
      crypto.verify(
        'sha256',
        Buffer.from(message),
        { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
        signature
      )
    ).toBe(true);
  });

  it('is not a PSS signature', () => {
    // The previous implementation used PSS padding. It produces a signature
    // that looks entirely reasonable and that Satispay rejects every time.
    const message = 'anything';
    const signature = Buffer.from(signMessage(privateKey, message), 'base64');

    expect(
      crypto.verify(
        'sha256',
        Buffer.from(message),
        { key: publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING },
        signature
      )
    ).toBe(false);
  });
});

describe('authorizationHeader', () => {
  it('names the key, the algorithm and exactly the headers that were signed', () => {
    const header = authorizationHeader(credentials(), 'message');

    expect(header).toMatch(
      /^Signature keyId="key-1", algorithm="rsa-sha256", headers="\(request-target\) host date digest", signature="[A-Za-z0-9+/=]+"$/
    );
  });
});

describe('signedHeaders', () => {
  const date = 'Mon, 05 Jan 2026 12:00:00 GMT';
  const host = 'staging.authservices.satispay.com';

  it('signs the same digest it sends', () => {
    const body = '{"action":"ACCEPT","amount_unit":1000}';
    const headers = signedHeaders(credentials(), 'PUT', '/g_business/v1/payments/p-1', body, host, date);

    expect(headers.Digest).toBe(bodyDigest(body));

    const signature = Buffer.from(/signature="([^"]+)"/.exec(headers.Authorization)![1], 'base64');

    expect(
      crypto.verify(
        'sha256',
        Buffer.from(
          signingString('PUT', '/g_business/v1/payments/p-1', host, date, headers.Digest)
        ),
        { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
        signature
      )
    ).toBe(true);
  });

  it('does not vouch for a body that was changed after signing', () => {
    const headers = signedHeaders(credentials(), 'POST', '/g_business/v1/payments', '{"amount_unit":1000}', host, date);

    const signature = Buffer.from(/signature="([^"]+)"/.exec(headers.Authorization)![1], 'base64');

    expect(
      crypto.verify(
        'sha256',
        Buffer.from(
          signingString('POST', '/g_business/v1/payments', host, date, bodyDigest('{"amount_unit":100000}'))
        ),
        { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
        signature
      )
    ).toBe(false);
  });

  it('sends a digest on a GET too', () => {
    const headers = signedHeaders(credentials(), 'GET', '/g_business/v1/payments/p-1', '', host, date);

    expect(headers.Digest).toBe('SHA-256=47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
    expect(headers.Authorization).toContain('headers="(request-target) host date digest"');
  });

  it('dates the request in RFC 1123, not ISO 8601', () => {
    const headers = signedHeaders(credentials(), 'GET', '/g_business/v1/payments/p-1', '');

    // "Mon, 05 Jan 2026 12:00:00 GMT". The old implementation sent
    // toISOString(), which Satispay does not accept.
    expect(headers.Date).toMatch(
      /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/
    );
  });
});

describe('generateKeyPair', () => {
  it('produces a pair Satispay will accept and that can sign', () => {
    const pair = generateKeyPair();

    // Satispay wants the public key as PEM with real newlines.
    expect(pair.publicKey.startsWith('-----BEGIN PUBLIC KEY-----\n')).toBe(true);
    expect(pair.privateKey.startsWith('-----BEGIN PRIVATE KEY-----\n')).toBe(true);

    const signature = Buffer.from(signMessage(pair.privateKey, 'message'), 'base64');
    expect(
      crypto.verify(
        'sha256',
        Buffer.from('message'),
        { key: pair.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
        signature
      )
    ).toBe(true);
  });
});
