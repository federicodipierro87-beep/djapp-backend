import { beforeEach, describe, expect, it, vi } from 'vitest';

// The expiry cron and the DJ tapping "accept" can reach the same request at the
// same moment. Whoever loses must not touch the payment: releasing the hold on
// a request the DJ just accepted means playing the song for free.

const findMany = vi.fn();
const updateMany = vi.fn();
const cancelPaymentIntent = vi.fn();
const voidOrder = vi.fn();
const cancelSatispay = vi.fn();

vi.mock('../src/utils/database', () => ({
  default: {
    request: {
      findMany: (...args: unknown[]) => findMany(...args),
      updateMany: (...args: unknown[]) => updateMany(...args)
    }
  }
}));

vi.mock('../src/services/stripe.service', () => ({
  stripeService: { cancelPaymentIntent: (...args: unknown[]) => cancelPaymentIntent(...args) }
}));

vi.mock('../src/services/paypal.service', () => ({
  paypalService: { voidOrder: (...args: unknown[]) => voidOrder(...args) }
}));

vi.mock('../src/services/satispay.service', () => ({
  satispayService: {
    cancelPayment: (...args: unknown[]) => cancelSatispay(...args),
    getPayment: vi.fn()
  },
  satispayCredentialsFor: (dj: any) =>
    dj?.satispayKeyId && dj?.satispayPrivateKey ? { keyId: dj.satispayKeyId, privateKey: 'k' } : null
}));

vi.mock('node-cron', () => ({ default: { schedule: vi.fn() } }));

const { ExpirationService, EXPIRATION_MS } = await import('../src/services/expiration.service');

const service = new ExpirationService() as any;

const stale = {
  id: 'req-1',
  songTitle: 'Blue Monday',
  status: 'PENDING',
  paymentMethod: 'CARD',
  paymentIntentId: 'pi_1',
  dj: { satispayKeyId: null, satispayPrivateKey: null }
};

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([stale]);
  updateMany.mockResolvedValue({ count: 1 });
});

describe('expiring pending requests', () => {
  it('releases the hold on a request nobody answered', async () => {
    await service.expireOldRequests();

    expect(cancelPaymentIntent).toHaveBeenCalledExactlyOnceWith('pi_1');
  });

  // The claim and the status check are the same statement, so the DJ's accept
  // either happened before it (count 0) or after it (count 1). There is no
  // in-between in which both sides think they won.
  //
  // paymentStatus is no longer part of the claim, and that is the whole point.
  // It used to be written to CANCELED here, before any provider had been asked:
  // if the cancel then failed, the row was terminal, the money was still on
  // hold, and nothing could find it again because the crons search by status.
  // It now stays AUTHORIZED until a provider confirms.
  it('claims the row by status alone, leaving the money where it says it is', async () => {
    await service.expireOldRequests();

    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'req-1', status: 'PENDING' },
      data: { status: 'EXPIRED' }
    });
  });

  // Written only after the provider answered, and conditionally: a capture that
  // landed in between moved the row to CAPTURED and must not be overwritten.
  it('records the cancellation only once the provider has confirmed it', async () => {
    await service.expireOldRequests();

    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'req-1', paymentStatus: { in: ['AUTHORIZED', 'PENDING'] } },
      data: { paymentStatus: 'CANCELED' }
    });
  });

  // The failure that used to strand the money. Leaving the row AUTHORIZED is
  // what lets the reconciliation sweep pick it up five minutes later.
  it('leaves the row holding money when the provider is down', async () => {
    cancelPaymentIntent.mockRejectedValue(new Error('stripe down'));

    await service.expireOldRequests();

    expect(updateMany).toHaveBeenCalledOnce();
  });

  // An accepted song used to be excluded from expiry entirely, so a DJ who
  // accepted a request and then went home left that card blocked until the
  // provider gave up on its own. CLOSED matches what ending an event writes.
  it('closes an accepted request the DJ never played', async () => {
    findMany.mockResolvedValue([{ ...stale, status: 'ACCEPTED' }]);

    await service.expireOldRequests();

    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'req-1', status: 'ACCEPTED' },
      data: { status: 'CLOSED' }
    });
    expect(cancelPaymentIntent).toHaveBeenCalledExactlyOnceWith('pi_1');
  });

  // This is the race: the DJ accepted between the read and the write, so the
  // row is no longer PENDING. The queue now depends on that authorisation.
  it('leaves the payment alone when the DJ accepted first', async () => {
    updateMany.mockResolvedValue({ count: 0 });

    await service.expireOldRequests();

    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect(voidOrder).not.toHaveBeenCalled();
    expect(cancelSatispay).not.toHaveBeenCalled();
  });

  // Both open statuses now, and only rows whose money is actually on hold or
  // that never had any: a request whose capture failed is left for a human,
  // because nobody knows whether the money moved and releasing it could give
  // back a real donation. A free one has no hold to give back but would
  // otherwise sit in the DJ's panel forever.
  it('only looks at open requests, older than the window, with nothing left owing', async () => {
    await service.expireOldRequests();

    const where = findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ['PENDING', 'ACCEPTED'] });
    expect(where.paymentStatus).toEqual({ in: ['AUTHORIZED', 'NOT_REQUIRED'] });
    const cutoff = where.createdAt.lt.getTime();
    expect(Date.now() - cutoff).toBeGreaterThanOrEqual(EXPIRATION_MS - 5_000);
    expect(Date.now() - cutoff).toBeLessThanOrEqual(EXPIRATION_MS + 5_000);
  });

  // One provider being down must not stop the rest of the queue expiring.
  it('keeps going when releasing one payment fails', async () => {
    findMany.mockResolvedValue([stale, { ...stale, id: 'req-2', paymentIntentId: 'pi_2' }]);
    cancelPaymentIntent.mockRejectedValueOnce(new Error('stripe down'));

    await service.expireOldRequests();

    expect(cancelPaymentIntent).toHaveBeenCalledTimes(2);
  });

  it('has nothing to release when no payment was ever attached', async () => {
    findMany.mockResolvedValue([{ ...stale, paymentIntentId: null }]);

    await service.expireOldRequests();

    expect(cancelPaymentIntent).not.toHaveBeenCalled();
  });

  it('releases a PayPal hold through PayPal', async () => {
    findMany.mockResolvedValue([{ ...stale, paymentMethod: 'PAYPAL', paymentIntentId: 'order-1' }]);

    await service.expireOldRequests();

    expect(voidOrder).toHaveBeenCalledExactlyOnceWith('order-1');
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
  });

  // A Satispay fund lock lives in the DJ's own account. If they disconnected it
  // while this was outstanding there is no key left to sign the release with,
  // and the lock has to time out on Satispay's side.
  it('cannot release a Satispay lock once the DJ has disconnected', async () => {
    findMany.mockResolvedValue([
      {
        ...stale,
        paymentMethod: 'SATISPAY',
        paymentIntentId: 'sp-1',
        dj: { satispayKeyId: null, satispayPrivateKey: null }
      }
    ]);

    await service.expireOldRequests();

    expect(cancelSatispay).not.toHaveBeenCalled();
    // The request is still expired: the guest must not keep waiting for a song
    // nobody is going to play.
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'req-1', status: 'PENDING' },
      data: { status: 'EXPIRED' }
    });
    // FAILED, not CANCELED. Nothing was cancelled - the lock is still there and
    // no retry will ever reach it - and calling it CANCELED would hide it.
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'req-1', paymentStatus: { in: ['AUTHORIZED', 'PENDING'] } },
      data: { paymentStatus: 'FAILED' }
    });
  });
});

describe('discarding drafts nobody paid for', () => {
  it('claims the draft by its own status, not the pending one', async () => {
    await service.expireAbandonedDrafts();

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'req-1', status: 'AWAITING_PAYMENT' },
      data: { status: 'EXPIRED', paymentStatus: 'CANCELED' }
    });
  });

  // Same race, other end: the guest's confirmation landed while the cron was
  // reading. The request is now a real PENDING one with a live authorisation.
  it('leaves the payment alone when the confirmation arrived first', async () => {
    updateMany.mockResolvedValue({ count: 0 });

    await service.expireAbandonedDrafts();

    expect(cancelPaymentIntent).not.toHaveBeenCalled();
  });

  it('releases the hold on a tab the guest closed mid-payment', async () => {
    await service.expireAbandonedDrafts();

    expect(cancelPaymentIntent).toHaveBeenCalledExactlyOnceWith('pi_1');
  });

  // Drafts are dropped long before the twelve hour safety net: they are
  // invisible to the DJ, so the only thing they cost is a hold on a card.
  it('gives up on a draft sooner than on a request the DJ can see', async () => {
    await service.expireAbandonedDrafts();
    const draftCutoff = findMany.mock.calls[0][0].where.createdAt.lt.getTime();

    findMany.mockClear();
    await service.expireOldRequests();
    const pendingCutoff = findMany.mock.calls[0][0].where.createdAt.lt.getTime();

    expect(draftCutoff).toBeGreaterThan(pendingCutoff);
  });
});
