import { beforeEach, describe, expect, it, vi } from 'vitest';

// Ending a night is the moment a guest's card should stop being blocked. Until
// now it closed the requests and left the money on hold until the expiry cron
// noticed - and it never noticed the accepted ones at all.

const requestFindMany = vi.fn();
const requestUpdateMany = vi.fn();
const queueDeleteMany = vi.fn();
const transaction = vi.fn();
const eventFindUnique = vi.fn();
const eventUpdate = vi.fn();
const djFindUnique = vi.fn();
const eventSummaryCreate = vi.fn();
const eventSummaryFindFirst = vi.fn();
const requestCount = vi.fn();
const queueFindMany = vi.fn();

const cancelPaymentIntent = vi.fn();

vi.mock('../src/utils/database', () => ({
  default: {
    request: {
      findMany: (...args: unknown[]) => requestFindMany(...args),
      findFirst: async () => null,
      updateMany: (...args: unknown[]) => requestUpdateMany(...args),
      count: (...args: unknown[]) => requestCount(...args)
    },
    queueItem: {
      deleteMany: (...args: unknown[]) => queueDeleteMany(...args),
      findMany: (...args: unknown[]) => queueFindMany(...args)
    },
    event: {
      findUnique: (...args: unknown[]) => eventFindUnique(...args),
      update: (...args: unknown[]) => eventUpdate(...args)
    },
    dJ: { findUnique: (...args: unknown[]) => djFindUnique(...args) },
    eventSummary: {
      create: (...args: unknown[]) => eventSummaryCreate(...args),
      findFirst: (...args: unknown[]) => eventSummaryFindFirst(...args)
    },
    $transaction: (...args: unknown[]) => transaction(...args)
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

const { closeOutstandingRequests } = await import('../src/services/paymentRelease.service');
const { endCurrentEvent } = await import('../src/controllers/settings.controller');
const { eventService } = await import('../src/services/event.service');

const hold = {
  id: 'req-1',
  songTitle: 'Blue Monday',
  paymentMethod: 'CARD',
  paymentIntentId: 'pi_1',
  dj: { satispayKeyId: null, satispayPrivateKey: null }
};

// asyncHandler hands the promise to `.catch(next)` and returns undefined, so the
// handler is run and then waited on through the response it produces.
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

  handler({ params: {}, dj: { djId } }, res, next);
  await answered;

  return { res, next };
};

beforeEach(() => {
  vi.clearAllMocks();
  requestFindMany.mockResolvedValue([hold]);
  requestUpdateMany.mockResolvedValue({ count: 1 });
  transaction.mockResolvedValue([]);
  cancelPaymentIntent.mockResolvedValue({ id: 'pi_1', status: 'canceled' });

  djFindUnique.mockResolvedValue({ id: 'dj-1', eventCode: 'ABC123' });
  eventSummaryFindFirst.mockResolvedValue(null);
  eventSummaryCreate.mockResolvedValue({ id: 'sum-1' });
  requestCount.mockResolvedValue(0);
  queueFindMany.mockResolvedValue([]);

  eventFindUnique.mockResolvedValue({ id: 'evt-1', djId: 'dj-1', status: 'ACTIVE' });
  eventUpdate.mockResolvedValue({ id: 'evt-1', status: 'ENDED' });
});

describe('what an event close looks for', () => {
  it('only releases requests that are open and still holding money', async () => {
    await closeOutstandingRequests({ djId: 'dj-1' });

    expect(requestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          djId: 'dj-1',
          status: { in: ['PENDING', 'ACCEPTED'] },
          paymentStatus: 'AUTHORIZED'
        }
      })
    );
  });

  // The narrowing applies to the releases only. Closing the night has always
  // meant closing every request of it, whatever state its payment is in, and
  // filtering the flip by paymentStatus would quietly leave rows open forever.
  it('closes every open request, not only the ones holding money', async () => {
    await closeOutstandingRequests({ djId: 'dj-1' });

    const writes = transaction.mock.calls[0][0];
    expect(requestUpdateMany).toHaveBeenCalledWith({
      where: { djId: 'dj-1', status: 'PENDING' },
      data: { status: 'EXPIRED' }
    });
    expect(requestUpdateMany).toHaveBeenCalledWith({
      where: { djId: 'dj-1', status: 'ACCEPTED' },
      data: { status: 'CLOSED' }
    });
    expect(writes).toHaveLength(3);
  });
});

describe('scoping a close', () => {
  // The legacy path has always emptied the queue, because a DJ has one current
  // event code and the next night starts from nothing.
  it('empties the queue when closing a DJ whole night', async () => {
    await closeOutstandingRequests({ djId: 'dj-1' });

    expect(queueDeleteMany).toHaveBeenCalledExactlyOnceWith({ where: { djId: 'dj-1' } });
  });

  // getPublicQueue filters queue items by eventId, so an ended event's queue is
  // never shown again. Deleting it would only erase what was played.
  it('leaves the queue alone when closing a single event', async () => {
    await closeOutstandingRequests({ eventId: 'evt-1' });

    expect(queueDeleteMany).not.toHaveBeenCalled();
    expect(transaction.mock.calls[0][0]).toHaveLength(2);
  });

  // The one scoping mistake that would cost real money: a DJ running two events
  // ends one, and the other one's guests lose their place in the queue.
  it('never widens an event close to the whole DJ', async () => {
    await eventService.endEvent('evt-1', 'dj-1');

    for (const call of [...requestFindMany.mock.calls, ...requestUpdateMany.mock.calls]) {
      expect(call[0].where).toMatchObject({ eventId: 'evt-1' });
      expect(call[0].where).not.toHaveProperty('djId');
    }
  });

  // The mirror image: the legacy path must stay scoped to the DJ. Narrowing it
  // to eventId: null would strand the Event-system requests of a DJ who uses
  // both systems at once.
  it('keeps the legacy close scoped to the DJ, both systems included', async () => {
    await invoke(endCurrentEvent, 'dj-1');

    expect(requestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ djId: 'dj-1' }) })
    );
    expect(requestFindMany.mock.calls[0][0].where).not.toHaveProperty('eventId');
  });
});

describe('answering the DJ', () => {
  // Forty guests is forty provider round trips, roughly twelve seconds, while
  // the house lights are coming up and Railway's proxy is counting. Nothing the
  // DJ does next depends on the answer, so the release runs after the response.
  it('does not make the DJ wait for the providers', async () => {
    let releaseTheProvider: () => void;
    const providerIsSlow = new Promise<void>((resolve) => {
      releaseTheProvider = resolve;
    });
    cancelPaymentIntent.mockImplementation(async () => {
      await providerIsSlow;
      return { id: 'pi_1', status: 'canceled' };
    });

    const { res } = await invoke(endCurrentEvent, 'dj-1');

    // The response is already out while the cancel is still in flight.
    expect(res.json).toHaveBeenCalledOnce();
    expect(cancelPaymentIntent).toHaveBeenCalledOnce();

    releaseTheProvider!();
  });

  // The requests are closed before the answer, though: the DJ is told the night
  // is over, so it has to be over.
  it('closes the requests before answering', async () => {
    await invoke(endCurrentEvent, 'dj-1');

    expect(transaction).toHaveBeenCalledOnce();
  });

  it('releases the hold it found', async () => {
    await invoke(endCurrentEvent, 'dj-1');

    expect(cancelPaymentIntent).toHaveBeenCalledExactlyOnceWith('pi_1');
  });
});

describe('ending an Event row', () => {
  it('releases the holds of that event', async () => {
    await eventService.endEvent('evt-1', 'dj-1');

    expect(cancelPaymentIntent).toHaveBeenCalledExactlyOnceWith('pi_1');
    expect(eventUpdate).toHaveBeenCalledOnce();
  });

  // A cancelled event owes its guests their money back just as much as an ended
  // one. On a SCHEDULED event there is nothing to find, which is harmless.
  it('releases the holds of a cancelled event too', async () => {
    eventFindUnique.mockResolvedValue({ id: 'evt-1', djId: 'dj-1', status: 'ACTIVE' });
    eventUpdate.mockResolvedValue({ id: 'evt-1', status: 'CANCELLED' });

    await eventService.cancelEvent('evt-1', 'dj-1');

    expect(cancelPaymentIntent).toHaveBeenCalledExactlyOnceWith('pi_1');
  });

  it('does not touch another DJ event', async () => {
    await expect(eventService.endEvent('evt-1', 'dj-2')).rejects.toThrow('Not authorized');

    expect(requestFindMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});
