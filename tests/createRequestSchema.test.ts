import { describe, expect, it } from 'vitest';
import { createRequestSchema } from '../src/controllers/request.controller';

const valid = {
  eventCode: 'ABC123',
  songTitle: 'Blue Monday',
  artistName: 'New Order',
  requesterName: 'Ospite',
  donationAmount: 10,
  paymentMethod: 'CARD' as const
};

describe('createRequestSchema', () => {
  it('accepts a well formed request', () => {
    expect(createRequestSchema.parse(valid)).toMatchObject(valid);
  });

  // This is the free-requests bug: the handler used to store whatever id the
  // body carried, so any string here bought a request nobody had paid for. The
  // transition shim still reads the raw body, but only to check the id against
  // Stripe - it must never arrive as validated data.
  it('drops a client supplied paymentIntentId', () => {
    const parsed = createRequestSchema.parse({ ...valid, paymentIntentId: 'pi_forged' });

    expect(parsed).not.toHaveProperty('paymentIntentId');
  });

  // Same idea one level down: the event the request belongs to has to be
  // derived from the event code, never taken from the body, or a guest of one
  // DJ could file requests into another DJ's night.
  it('drops a client supplied eventId', () => {
    const parsed = createRequestSchema.parse({
      ...valid,
      eventId: '11111111-1111-4111-8111-111111111111'
    });

    expect(parsed).not.toHaveProperty('eventId');
  });

  // Below the floor is not a smaller donation, it is one no card will accept.
  // See publicRequestGates.test.ts for the floor itself.
  it('rejects a negative donation', () => {
    expect(() => createRequestSchema.parse({ ...valid, donationAmount: -1 })).toThrow();
  });

  it('rejects a donation above the cap', () => {
    expect(() => createRequestSchema.parse({ ...valid, donationAmount: 1001 })).toThrow();
  });

  it('rejects an unknown payment method', () => {
    expect(() => createRequestSchema.parse({ ...valid, paymentMethod: 'BITCOIN' })).toThrow();
  });

  it('rejects an album cover that is not hosted by Spotify', () => {
    expect(() =>
      createRequestSchema.parse({ ...valid, albumCover: 'https://evil.example/cover.png' })
    ).toThrow();
  });
});
