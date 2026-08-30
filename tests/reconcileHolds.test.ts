import { beforeEach, describe, expect, it, vi } from 'vitest';

// The sweep that exists because everything else can fail halfway. A request can
// be finished - rejected, expired, closed - and still be holding a guest's
// money: the provider was down, or the process died between the two writes.
// Nothing else looks for those rows, because every other path searches by
// status and the status is already final.

const findMany = vi.fn();
const updateMany = vi.fn();
const cancelPaymentIntent = vi.fn();

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

vi.mock('../src/services/paypal.service', () => ({ paypalService: { voidOrder: vi.fn() } }));

vi.mock('../src/services/satispay.service', () => ({
  satispayService: { cancelPayment: vi.fn(), getPayment: vi.fn() },
  satispayCredentialsFor: () => null
}));

vi.mock('node-cron', () => ({ default: { schedule: vi.fn() } }));

const { ExpirationService } = await import('../src/services/expiration.service');

const service = new ExpirationService() as any;

const stranded = {
  id: 'req-1',
  songTitle: 'Blue Monday',
  paymentMethod: 'CARD',
  paymentIntentId: 'pi_1',
  dj: { satispayKeyId: null, satispayPrivateKey: null }
};

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([stranded]);
  updateMany.mockResolvedValue({ count: 1 });
  cancelPaymentIntent.mockResolvedValue({ id: 'pi_1', status: 'canceled' });
});

describe('what the sweep considers stranded', () => {
  it('looks for finished requests whose money never came back', async () => {
    await service.reconcileHolds();

    const where = findMany.mock.calls[0][0].where;
    expect(where.paymentStatus).toBe('AUTHORIZED');
    expect(where.status).toEqual({ in: ['REJECTED', 'EXPIRED', 'CLOSED'] });
    expect(where.paymentIntentId).toEqual({ not: null });
  });

  // A row written seconds ago probably belongs to a controller that is still
  // running. Two minutes is long enough that nothing is mid-flight.
  it('gives a controller two minutes to finish before stepping in', async () => {
    await service.reconcileHolds();

    const grace = Date.now() - findMany.mock.calls[0][0].where.updatedAt.lt.getTime();
    expect(grace).toBeGreaterThanOrEqual(2 * MINUTE - 5_000);
    expect(grace).toBeLessThanOrEqual(2 * MINUTE + 5_000);
  });

  // Past a week every provider has released the authorisation itself. Retrying
  // forever would only produce daily errors on rows nobody can act on.
  it('stops trying after a week', async () => {
    await service.reconcileHolds();

    const maxAge = Date.now() - findMany.mock.calls[0][0].where.createdAt.gt.getTime();
    expect(maxAge).toBeGreaterThanOrEqual(7 * DAY - 5_000);
    expect(maxAge).toBeLessThanOrEqual(7 * DAY + 5_000);
  });

  it('does nothing at all when there is nothing stranded', async () => {
    findMany.mockResolvedValue([]);

    await service.reconcileHolds();

    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('releasing what it finds', () => {
  it('releases the hold and records it', async () => {
    await service.reconcileHolds();

    expect(cancelPaymentIntent).toHaveBeenCalledExactlyOnceWith('pi_1');
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'req-1', paymentStatus: { in: ['AUTHORIZED', 'PENDING'] } },
      data: { paymentStatus: 'CANCELED' }
    });
  });

  // There is no claim here, deliberately: a claim would need an "in flight"
  // state, which is a new enum value and a migration. The safety comes from the
  // release being idempotent and the write being conditional. This is the case
  // that condition is for - the song was played and paid for in between.
  it('does not write CANCELED over a row that has since been captured', async () => {
    cancelPaymentIntent.mockRejectedValue(
      Object.assign(new Error('cannot cancel'), {
        code: 'payment_intent_unexpected_state',
        raw: { payment_intent: { id: 'pi_1', status: 'succeeded' } }
      })
    );

    await service.reconcileHolds();

    expect(updateMany).not.toHaveBeenCalled();
  });

  // Still down. The row keeps saying AUTHORIZED, so the next sweep finds it
  // again - which is the entire reason the release stopped writing CANCELED up
  // front.
  it('leaves a row for the next sweep when the provider is still down', async () => {
    cancelPaymentIntent.mockRejectedValue(new Error('stripe down'));

    await service.reconcileHolds();

    expect(updateMany).not.toHaveBeenCalled();
  });

  it('keeps going when one of several rows fails', async () => {
    findMany.mockResolvedValue([stranded, { ...stranded, id: 'req-2', paymentIntentId: 'pi_2' }]);
    cancelPaymentIntent.mockRejectedValueOnce(new Error('stripe down'));

    await service.reconcileHolds();

    expect(cancelPaymentIntent).toHaveBeenCalledTimes(2);
  });
});
