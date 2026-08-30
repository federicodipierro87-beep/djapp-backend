import { beforeEach, describe, expect, it, vi } from 'vitest';

// Releasing a hold is the one payment operation that gets retried, so it has to
// be safe to run twice. None of the three providers is idempotent in the same
// way - Stripe not at all - and the whole point of this module is that the
// caller no longer has to know which is which.

const requestUpdateMany = vi.fn();

const cancelPaymentIntent = vi.fn();
const voidOrder = vi.fn();
const cancelSatispay = vi.fn();
const getSatispayPayment = vi.fn();

vi.mock('../src/utils/database', () => ({
  default: {
    request: { updateMany: (...args: unknown[]) => requestUpdateMany(...args) }
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
    getPayment: (...args: unknown[]) => getSatispayPayment(...args)
  },
  satispayCredentialsFor: (dj: any) =>
    dj?.satispayKeyId && dj?.satispayPrivateKey ? { keyId: dj.satispayKeyId, privateKey: 'k' } : null
}));

const { releaseAuthorization, recordReleaseOutcome, releaseAll } = await import(
  '../src/services/paymentRelease.service'
);

const card = {
  id: 'req-1',
  songTitle: 'Blue Monday',
  paymentMethod: 'CARD' as const,
  paymentIntentId: 'pi_1',
  dj: { satispayKeyId: null, satispayPrivateKey: null }
};

// What the Stripe SDK actually throws when the intent is not in a cancellable
// state: a code plus the intent itself, whose status says which state that is.
const unexpectedState = (status: string) =>
  Object.assign(new Error('You cannot cancel this PaymentIntent'), {
    code: 'payment_intent_unexpected_state',
    raw: { payment_intent: { id: 'pi_1', status } }
  });

beforeEach(() => {
  vi.clearAllMocks();
  requestUpdateMany.mockResolvedValue({ count: 1 });
  cancelPaymentIntent.mockResolvedValue({ id: 'pi_1', status: 'canceled' });
  voidOrder.mockResolvedValue({ id: 'auth-1', status: 'VOIDED' });
  cancelSatispay.mockResolvedValue({ id: 'sp-1', status: 'CANCELED' });
});

describe('routing a release to the provider that holds the money', () => {
  it('sends a card hold to Stripe', async () => {
    const outcome = await releaseAuthorization(card as any);

    expect(cancelPaymentIntent).toHaveBeenCalledExactlyOnceWith('pi_1');
    expect(outcome).toEqual({ released: true, reason: 'canceled' });
  });

  it('sends Apple Pay and Google Pay to Stripe as well', async () => {
    await releaseAuthorization({ ...card, paymentMethod: 'APPLE_PAY' } as any);
    await releaseAuthorization({ ...card, paymentMethod: 'GOOGLE_PAY' } as any);

    expect(cancelPaymentIntent).toHaveBeenCalledTimes(2);
    expect(voidOrder).not.toHaveBeenCalled();
  });

  it('sends a PayPal hold to PayPal', async () => {
    const outcome = await releaseAuthorization({
      ...card,
      paymentMethod: 'PAYPAL',
      paymentIntentId: 'order-1'
    } as any);

    expect(voidOrder).toHaveBeenCalledExactlyOnceWith('order-1');
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect(outcome.released).toBe(true);
  });

  it('signs a Satispay release with the DJ own credentials', async () => {
    await releaseAuthorization({
      ...card,
      paymentMethod: 'SATISPAY',
      paymentIntentId: 'sp-1',
      dj: { satispayKeyId: 'key-1', satispayPrivateKey: 'enc' }
    } as any);

    expect(cancelSatispay).toHaveBeenCalledExactlyOnceWith(
      { keyId: 'key-1', privateKey: 'k' },
      'sp-1'
    );
  });

  // A request abandoned before any provider was reached. There is no hold, so
  // there is nothing to fail at, and the row is free to reach a final state.
  it('has nothing to release when no payment was ever attached', async () => {
    const outcome = await releaseAuthorization({ ...card, paymentIntentId: null } as any);

    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect(outcome).toEqual({ released: true, reason: 'nothing_to_release' });
  });
});

describe('running a release twice', () => {
  // Stripe answers a second cancel with an error, not a shrug. Two crons, or a
  // cron and a DJ, reaching the same row must both end up believing the money
  // is free - because it is.
  it('treats an already-cancelled Stripe intent as released', async () => {
    cancelPaymentIntent.mockRejectedValue(unexpectedState('canceled'));

    const outcome = await releaseAuthorization(card as any);

    expect(outcome).toEqual({ released: true, reason: 'already_released' });
  });

  // The opposite case, and the dangerous one: the song was played and the money
  // taken between the read and the cancel. Reporting this as released would let
  // the caller write CANCELED over a real, collected donation.
  it('refuses to call a captured Stripe payment released', async () => {
    cancelPaymentIntent.mockRejectedValue(unexpectedState('succeeded'));

    const outcome = await releaseAuthorization(card as any);

    expect(outcome).toMatchObject({ released: false, retryable: false, reason: 'captured' });
  });

  it('reads the Satispay payment back to tell cancelled from accepted', async () => {
    cancelSatispay.mockRejectedValue(new Error('Satispay PUT failed with 403'));
    getSatispayPayment.mockResolvedValue({ id: 'sp-1', status: 'ACCEPTED' });

    const outcome = await releaseAuthorization({
      ...card,
      paymentMethod: 'SATISPAY',
      paymentIntentId: 'sp-1',
      dj: { satispayKeyId: 'key-1', satispayPrivateKey: 'enc' }
    } as any);

    expect(outcome).toMatchObject({ released: false, retryable: false, reason: 'captured' });
  });

  it('accepts a Satispay payment that turns out to be cancelled already', async () => {
    cancelSatispay.mockRejectedValue(new Error('Satispay PUT failed with 403'));
    getSatispayPayment.mockResolvedValue({ id: 'sp-1', status: 'CANCELED' });

    const outcome = await releaseAuthorization({
      ...card,
      paymentMethod: 'SATISPAY',
      paymentIntentId: 'sp-1',
      dj: { satispayKeyId: 'key-1', satispayPrivateKey: 'enc' }
    } as any);

    expect(outcome).toEqual({ released: true, reason: 'already_released' });
  });
});

describe('failures the caller has to tell apart', () => {
  // A provider outage. The money is still on hold and a retry is the right
  // answer, which is what the sweep does.
  it('marks a provider outage as worth retrying', async () => {
    cancelPaymentIntent.mockRejectedValue(new Error('stripe down'));

    const outcome = await releaseAuthorization(card as any);

    expect(outcome).toEqual({
      released: false,
      retryable: true,
      reason: 'provider_error',
      detail: 'stripe down'
    });
  });

  // A Satispay fund lock lives in the DJ's own account. If they disconnected it
  // while this was outstanding, no retry will ever find a key: the lock has to
  // time out on Satispay's side and a human has to know.
  it('does not retry a Satispay lock the DJ has no key for', async () => {
    const outcome = await releaseAuthorization({
      ...card,
      paymentMethod: 'SATISPAY',
      paymentIntentId: 'sp-1',
      dj: { satispayKeyId: null, satispayPrivateKey: null }
    } as any);

    expect(cancelSatispay).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ released: false, retryable: false, reason: 'no_credentials' });
  });

  // Every caller of this module runs inside something else - a cron loop, an
  // HTTP handler that has already answered - where a throw is either swallowed
  // or crashes the process. It classifies instead.
  it('never throws, whatever the provider does', async () => {
    cancelPaymentIntent.mockRejectedValue('not even an Error');
    voidOrder.mockRejectedValue(new Error('paypal down'));
    cancelSatispay.mockRejectedValue(new Error('satispay down'));
    getSatispayPayment.mockRejectedValue(new Error('satispay still down'));

    await expect(releaseAuthorization(card as any)).resolves.toMatchObject({ released: false });
    await expect(
      releaseAuthorization({ ...card, paymentMethod: 'PAYPAL' } as any)
    ).resolves.toMatchObject({ released: false });
    await expect(
      releaseAuthorization({
        ...card,
        paymentMethod: 'SATISPAY',
        dj: { satispayKeyId: 'key-1', satispayPrivateKey: 'enc' }
      } as any)
    ).resolves.toMatchObject({ released: false });
  });
});

describe('recording where the money ended up', () => {
  // The guard that makes the whole design work: a capture landing at the same
  // moment moved the row to CAPTURED, and CANCELED must not be written over it.
  it('only writes CANCELED over a row that still holds money', async () => {
    await recordReleaseOutcome('req-1', { released: true, reason: 'canceled' });

    expect(requestUpdateMany).toHaveBeenCalledWith({
      where: { id: 'req-1', paymentStatus: { in: ['AUTHORIZED', 'PENDING'] } },
      data: { paymentStatus: 'CANCELED' }
    });
  });

  // A Satispay lock nobody can reach is not cancelled, and saying so would hide
  // real money from every sweep. FAILED is the flag for a human.
  it('records an unreachable hold as FAILED, not CANCELED', async () => {
    await recordReleaseOutcome('req-1', {
      released: false,
      retryable: false,
      reason: 'no_credentials',
      detail: 'gone'
    });

    expect(requestUpdateMany).toHaveBeenCalledWith({
      where: { id: 'req-1', paymentStatus: { in: ['AUTHORIZED', 'PENDING'] } },
      data: { paymentStatus: 'FAILED' }
    });
  });

  // This is the bug the module exists for. Writing CANCELED before the provider
  // confirmed left the row terminal, the money on hold, and nothing looking for
  // it: the crons search by status.
  it('leaves a retryable failure alone so the sweep can find it again', async () => {
    await recordReleaseOutcome('req-1', {
      released: false,
      retryable: true,
      reason: 'provider_error',
      detail: 'stripe down'
    });

    expect(requestUpdateMany).not.toHaveBeenCalled();
  });

  it('does not touch a row whose money was already captured', async () => {
    await recordReleaseOutcome('req-1', {
      released: false,
      retryable: false,
      reason: 'captured',
      detail: 'already captured'
    });

    expect(requestUpdateMany).not.toHaveBeenCalled();
  });
});

describe('releasing a batch', () => {
  it('keeps going when one provider call fails', async () => {
    cancelPaymentIntent.mockRejectedValueOnce(new Error('stripe down'));

    const summary = await releaseAll([card, { ...card, id: 'req-2', paymentIntentId: 'pi_2' }] as any);

    expect(cancelPaymentIntent).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({ attempted: 2, released: 1, failed: 1 });
  });

  // Forty guests at midnight is forty calls to the same provider. In a row they
  // are unremarkable; all at once they are a rate limit and a retry storm.
  it('calls the providers one at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    cancelPaymentIntent.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return { id: 'pi_1', status: 'canceled' };
    });

    await releaseAll([card, { ...card, id: 'req-2' }, { ...card, id: 'req-3' }] as any);

    expect(peak).toBe(1);
  });

  it('survives the database failing on one row', async () => {
    requestUpdateMany.mockRejectedValueOnce(new Error('connection lost'));

    const summary = await releaseAll([card, { ...card, id: 'req-2' }] as any);

    expect(summary).toEqual({ attempted: 2, released: 1, failed: 1 });
  });
});
