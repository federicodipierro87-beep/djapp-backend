import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

// The money-moving half of the queue controller. Every test here is a bug that
// actually shipped: the capture used to be reachable twice, and reachable after
// the payment had already been released.

const queueFindUnique = vi.fn();
const queueUpdateMany = vi.fn();
const requestUpdate = vi.fn();
// Skipping now goes through the shared release module, which never writes the
// payment status with a bare update: the `where` is what stops a concurrent
// capture being overwritten.
const requestUpdateMany = vi.fn();

const capturePaymentIntent = vi.fn();
const cancelPaymentIntent = vi.fn();
const captureOrder = vi.fn();
const voidOrder = vi.fn();

vi.mock('../src/utils/database', () => ({
  default: {
    queueItem: {
      findUnique: (...args: unknown[]) => queueFindUnique(...args),
      updateMany: (...args: unknown[]) => queueUpdateMany(...args)
    },
    request: {
      update: (...args: unknown[]) => requestUpdate(...args),
      updateMany: (...args: unknown[]) => requestUpdateMany(...args)
    }
  }
}));

vi.mock('../src/services/stripe.service', () => ({
  stripeService: {
    capturePaymentIntent: (...args: unknown[]) => capturePaymentIntent(...args),
    cancelPaymentIntent: (...args: unknown[]) => cancelPaymentIntent(...args)
  }
}));

vi.mock('../src/services/paypal.service', () => ({
  paypalService: {
    captureOrder: (...args: unknown[]) => captureOrder(...args),
    voidOrder: (...args: unknown[]) => voidOrder(...args)
  }
}));

vi.mock('../src/services/satispay.service', () => ({
  satispayService: { cancelPayment: vi.fn(), getPayment: vi.fn() },
  satispayCredentialsFor: () => null
}));

vi.mock('../src/socket/socket', () => ({
  emitQueueUpdated: vi.fn(),
  emitNowPlayingChanged: vi.fn()
}));

const { markAsPlayed, skipSong } = await import('../src/controllers/queue.controller');

const queueItem = {
  id: 'q-1',
  djId: 'dj-1',
  status: 'WAITING',
  request: {
    id: 'req-1',
    paymentMethod: 'CARD',
    paymentIntentId: 'pi_1',
    paymentStatus: 'AUTHORIZED',
    donationAmount: new Prisma.Decimal(10)
  },
  dj: { eventCode: 'ABC123', satispayKeyId: null, satispayPrivateKey: null },
  event: { eventCode: 'EVT999' }
};

// asyncHandler hands the promise to `.catch(next)` and returns undefined, which
// is what Express wants but means awaiting the handler proves nothing. So we
// run it and wait for it to answer instead: every path ends in res.json, and a
// throw ends in next.
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

  handler({ params: { id: 'q-1' }, dj: { djId } }, res, next);
  await answered;

  return { res, next };
};

beforeEach(() => {
  vi.clearAllMocks();
  queueFindUnique.mockResolvedValue(queueItem);
  queueUpdateMany.mockResolvedValue({ count: 1 });
  requestUpdate.mockResolvedValue({});
  requestUpdateMany.mockResolvedValue({ count: 1 });
  capturePaymentIntent.mockResolvedValue({ id: 'pi_1', status: 'succeeded' });
  cancelPaymentIntent.mockResolvedValue({ id: 'pi_1', status: 'canceled' });
});

describe('markAsPlayed', () => {
  it('captures the donation once the song has been played', async () => {
    await invoke(markAsPlayed, 'dj-1');

    expect(capturePaymentIntent).toHaveBeenCalledExactlyOnceWith('pi_1');
    expect(requestUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paymentStatus: 'CAPTURED' })
      })
    );
  });

  // The claim has to be part of the write, not a check before it. Reading the
  // status and then writing leaves a window in which two taps both pass.
  it('claims the row by status, so the guard cannot be raced', async () => {
    await invoke(markAsPlayed, 'dj-1');

    expect(queueUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'q-1',
          djId: 'dj-1',
          status: { in: ['WAITING', 'NOW_PLAYING'] }
        })
      })
    );
  });

  // Two taps on the same button used to charge the guest twice.
  it('does not capture again when the row was already claimed', async () => {
    queueUpdateMany.mockResolvedValue({ count: 0 });
    const { res } = await invoke(markAsPlayed, 'dj-1');

    expect(capturePaymentIntent).not.toHaveBeenCalled();
    expect(requestUpdate).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
  });

  // A DJ must not be able to play, and collect, another DJ's queue item. The
  // lookup is scoped by djId, so it simply does not find one.
  it('does not let a DJ touch another DJ queue item', async () => {
    queueFindUnique.mockResolvedValue(null);
    const { res } = await invoke(markAsPlayed, 'dj-2');

    expect(res.status).toHaveBeenCalledWith(404);
    expect(queueUpdateMany).not.toHaveBeenCalled();
    expect(capturePaymentIntent).not.toHaveBeenCalled();
  });

  it('scopes the lookup to the caller rather than trusting the id alone', async () => {
    await invoke(markAsPlayed, 'dj-1');

    expect(queueFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'q-1', djId: 'dj-1' } })
    );
  });

  // The song was played, so the queue state is right either way. What must not
  // happen is reporting success and quietly losing the donation.
  it('keeps the song played but records the failure when the capture breaks', async () => {
    capturePaymentIntent.mockRejectedValue(new Error('card declined'));
    const { res } = await invoke(markAsPlayed, 'dj-1');

    expect(requestUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { paymentStatus: 'FAILED' } })
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ captureError: 'card declined' })
    );
  });

  // A free request has nothing to capture. Writing CAPTURED on it would claim
  // zero euros were collected, and the row would stop reading as free to every
  // path that goes by paymentStatus.
  it('leaves a free request alone instead of capturing nothing', async () => {
    queueFindUnique.mockResolvedValue({
      ...queueItem,
      request: {
        ...queueItem.request,
        paymentMethod: null,
        paymentIntentId: null,
        paymentStatus: 'NOT_REQUIRED',
        donationAmount: new Prisma.Decimal(0)
      }
    });

    const { res } = await invoke(markAsPlayed, 'dj-1');

    expect(capturePaymentIntent).not.toHaveBeenCalled();
    expect(requestUpdate).not.toHaveBeenCalled();
    // The song is still played: only the money side is skipped.
    expect(queueUpdateMany).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('captures a PayPal order through PayPal, not Stripe', async () => {
    queueFindUnique.mockResolvedValue({
      ...queueItem,
      request: { ...queueItem.request, paymentMethod: 'PAYPAL', paymentIntentId: 'order-1' }
    });
    captureOrder.mockResolvedValue({ id: 'order-1' });
    await invoke(markAsPlayed, 'dj-1');

    expect(captureOrder).toHaveBeenCalledExactlyOnceWith('order-1');
    expect(capturePaymentIntent).not.toHaveBeenCalled();
  });
});

describe('skipSong', () => {
  it('releases the hold instead of keeping the money', async () => {
    await invoke(skipSong, 'dj-1');

    expect(cancelPaymentIntent).toHaveBeenCalledExactlyOnceWith('pi_1');
    expect(capturePaymentIntent).not.toHaveBeenCalled();
  });

  // Skipping after playing used to void an authorisation that had already been
  // captured, which the provider answers with an error the DJ never sees.
  it('does not release a hold the row no longer owns', async () => {
    queueUpdateMany.mockResolvedValue({ count: 0 });
    const { res } = await invoke(skipSong, 'dj-1');

    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('does not let a DJ skip another DJ queue item', async () => {
    queueFindUnique.mockResolvedValue(null);
    const { res } = await invoke(skipSong, 'dj-2');

    expect(res.status).toHaveBeenCalledWith(404);
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
  });

  // A bare update here would overwrite a capture that landed in between. The
  // queue claim above does not cover it: the two rows are different rows.
  it('records the cancellation only over a row that still holds money', async () => {
    await invoke(skipSong, 'dj-1');

    expect(requestUpdate).not.toHaveBeenCalled();
    expect(requestUpdateMany).toHaveBeenCalledWith({
      where: { id: 'req-1', paymentStatus: { in: ['AUTHORIZED', 'PENDING'] } },
      data: { paymentStatus: 'CANCELED' }
    });
  });

  // The song is skipped either way. What must not happen is claiming the money
  // was released when it is still on hold.
  it('reports a failed release instead of silently marking it cancelled', async () => {
    cancelPaymentIntent.mockRejectedValue(new Error('stripe down'));

    const { res } = await invoke(skipSong, 'dj-1');

    expect(requestUpdateMany).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ cancelError: 'stripe down' })
    );
  });
});
