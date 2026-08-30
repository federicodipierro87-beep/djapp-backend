import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

// A request id is a uuid, but it is still a value the caller supplies. Nothing
// about holding one proves it belongs to you, so accept and reject both have to
// check who is asking before they move any money.

const requestFindUnique = vi.fn();
const requestUpdate = vi.fn();
const requestUpdateMany = vi.fn();
const queueAggregate = vi.fn();
const transaction = vi.fn();
const queueCreate = vi.fn();

const cancelPaymentIntent = vi.fn();
const voidOrder = vi.fn();

const emitRequestAccepted = vi.fn();
const emitRequestRejected = vi.fn();
const emitQueueUpdated = vi.fn();

vi.mock('../src/utils/database', () => ({
  default: {
    request: {
      findUnique: (...args: unknown[]) => requestFindUnique(...args),
      update: (...args: unknown[]) => requestUpdate(...args),
      updateMany: (...args: unknown[]) => requestUpdateMany(...args)
    },
    queueItem: {
      aggregate: (...args: unknown[]) => queueAggregate(...args),
      create: (...args: unknown[]) => queueCreate(...args)
    },
    $transaction: (...args: unknown[]) => transaction(...args)
  }
}));

vi.mock('../src/services/stripe.service', () => ({
  stripeService: { cancelPaymentIntent: (...args: unknown[]) => cancelPaymentIntent(...args) }
}));

vi.mock('../src/services/paypal.service', () => ({
  paypalService: { voidOrder: (...args: unknown[]) => voidOrder(...args) }
}));

vi.mock('../src/services/satispay.service', () => ({
  satispayService: { cancelPayment: vi.fn(), getPayment: vi.fn() },
  satispayCredentialsFor: () => null
}));

vi.mock('../src/services/expiration.service', () => ({
  expirationService: { isExpired: async () => false }
}));

vi.mock('../src/socket/socket', () => ({
  emitRequestAccepted: (...args: unknown[]) => emitRequestAccepted(...args),
  emitRequestRejected: (...args: unknown[]) => emitRequestRejected(...args),
  emitQueueUpdated: (...args: unknown[]) => emitQueueUpdated(...args),
  emitNewRequest: vi.fn()
}));

const { acceptRequest, rejectRequest } = await import('../src/controllers/request.controller');

const owned = {
  id: 'req-1',
  djId: 'dj-1',
  eventId: 'evt-1',
  songTitle: 'Blue Monday',
  artistName: 'New Order',
  requesterName: 'Ospite',
  status: 'PENDING',
  paymentMethod: 'CARD',
  paymentIntentId: 'pi_1',
  donationAmount: new Prisma.Decimal(10),
  createdAt: new Date(),
  dj: { eventCode: 'ABC123', satispayKeyId: null, satispayPrivateKey: null },
  event: { eventCode: 'EVT999' }
};

// asyncHandler returns undefined by design, so the handler is run and then
// waited on through the response it produces.
const invoke = async (handler: any, djId: string) => {
  const res: any = {};
  let finish: () => void;
  const answered = new Promise<void>((resolve) => {
    finish = resolve;
  });

  res.status = vi.fn(() => res);
  res.json = vi.fn(() => {
    finish();
    return res;
  });
  const next = vi.fn(() => finish());

  handler({ params: { id: 'req-1' }, dj: { djId } }, res, next);
  await answered;

  return { res, next };
};

beforeEach(() => {
  vi.clearAllMocks();
  requestFindUnique.mockResolvedValue(owned);
  requestUpdateMany.mockResolvedValue({ count: 1 });
  requestUpdate.mockResolvedValue({});
  queueAggregate.mockResolvedValue({ _max: { position: 3 } });
  transaction.mockResolvedValue([]);
  // clearAllMocks forgets the calls but keeps the implementations, so a test
  // that makes the provider fail would otherwise leak into the next one.
  cancelPaymentIntent.mockResolvedValue({ id: 'pi_1', status: 'canceled' });
  voidOrder.mockResolvedValue({ id: 'auth-1', status: 'VOIDED' });
});

describe('acceptRequest', () => {
  it('queues a request the caller owns', async () => {
    await invoke(acceptRequest, 'dj-1');

    expect(transaction).toHaveBeenCalledOnce();
    expect(emitRequestAccepted).toHaveBeenCalledOnce();
  });

  // The lookup is by id alone, so the ownership check afterwards is the only
  // thing standing between a DJ and another DJ's queue.
  it('refuses a request belonging to another DJ', async () => {
    const { res } = await invoke(acceptRequest, 'dj-2');

    expect(res.status).toHaveBeenCalledWith(404);
    expect(transaction).not.toHaveBeenCalled();
    expect(emitRequestAccepted).not.toHaveBeenCalled();
  });

  // Telling the two apart would confirm that a request with this id exists and
  // belongs to someone else.
  it('answers a foreign request exactly as it answers a missing one', async () => {
    const { res: foreign } = await invoke(acceptRequest, 'dj-2');
    const foreignBody = foreign.json.mock.calls[0][0];

    requestFindUnique.mockResolvedValue(null);
    const { res: missing } = await invoke(acceptRequest, 'dj-1');

    expect(missing.status).toHaveBeenCalledWith(404);
    expect(missing.json.mock.calls[0][0]).toEqual(foreignBody);
  });

  // Accepting is a promise to play the song, not a sale. The charge happens
  // when it is actually played.
  it('does not take the money at accept time', async () => {
    await invoke(acceptRequest, 'dj-1');

    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect(requestUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ paymentStatus: 'CAPTURED' }) })
    );
  });

  it('refuses a request that is not pending any more', async () => {
    requestFindUnique.mockResolvedValue({ ...owned, status: 'ACCEPTED' });

    const { res } = await invoke(acceptRequest, 'dj-1');

    expect(res.status).toHaveBeenCalledWith(400);
    expect(transaction).not.toHaveBeenCalled();
  });

  // Positions used to be a count over the DJ's whole history, so the first song
  // of the night started wherever the last one had left off.
  it('numbers the queue within the event, not the DJ history', async () => {
    await invoke(acceptRequest, 'dj-1');

    expect(queueAggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { eventId: 'evt-1' } })
    );
  });
});

describe('rejectRequest', () => {
  it('releases the hold on a request the caller owns', async () => {
    await invoke(rejectRequest, 'dj-1');

    expect(cancelPaymentIntent).toHaveBeenCalledExactlyOnceWith('pi_1');
    expect(emitRequestRejected).toHaveBeenCalledOnce();
  });

  // Rejecting another DJ's request would release a hold on a guest who is still
  // waiting for their song.
  it('refuses a request belonging to another DJ', async () => {
    const { res } = await invoke(rejectRequest, 'dj-2');

    expect(res.status).toHaveBeenCalledWith(404);
    expect(requestUpdateMany).not.toHaveBeenCalled();
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
  });

  it('claims the row by status before releasing anything', async () => {
    await invoke(rejectRequest, 'dj-1');

    expect(requestUpdateMany).toHaveBeenCalledWith({
      where: { id: 'req-1', status: 'PENDING' },
      data: { status: 'REJECTED' }
    });
  });

  // Two clicks, or a click racing the expiry cron, must not void twice.
  it('does not release the hold when the row was already claimed', async () => {
    requestUpdateMany.mockResolvedValue({ count: 0 });

    const { res } = await invoke(rejectRequest, 'dj-1');

    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  // The rejection is already written by the time the provider is called, so a
  // provider outage used to hand the DJ a 500 for something that had in fact
  // happened. The row stays AUTHORIZED and the reconciliation sweep retries it.
  it('still tells the DJ the request is rejected when the provider is down', async () => {
    cancelPaymentIntent.mockRejectedValue(new Error('stripe down'));

    const { res, next } = await invoke(rejectRequest, 'dj-1');

    expect(next).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ message: 'Request rejected' });
    expect(emitRequestRejected).toHaveBeenCalledOnce();
  });

  // The write that follows the release is conditional, not a bare update: the
  // song could have been played and paid for in between.
  it('records the cancellation only over a row that still holds money', async () => {
    await invoke(rejectRequest, 'dj-1');

    expect(requestUpdate).not.toHaveBeenCalled();
    expect(requestUpdateMany).toHaveBeenCalledWith({
      where: { id: 'req-1', paymentStatus: { in: ['AUTHORIZED', 'PENDING'] } },
      data: { paymentStatus: 'CANCELED' }
    });
  });
});
