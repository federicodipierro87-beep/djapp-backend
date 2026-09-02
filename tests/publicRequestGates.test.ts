import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

// Everything the public request endpoint has to refuse before a guest's card is
// touched. It is unauthenticated, anyone holding a six-character code can reach
// it, and what it does on the way through is put real money on hold.
//
// Two of these shipped broken. A request could be filed for a DJ whose panel
// would then answer 403 to every call that could accept or reject it, so the
// hold sat there for twelve hours and nobody was ever told. And the legacy
// per-DJ code reported itself active unconditionally, so last year's QR poster
// still took payments.

const requestCreate = vi.fn();
const requestUpdate = vi.fn();
const eventFindUnique = vi.fn();
const djFindUnique = vi.fn();

const createAuthorization = vi.fn();
const emitNewRequest = vi.fn();

vi.mock('../src/utils/database', () => ({
  default: {
    request: {
      create: (...args: unknown[]) => requestCreate(...args),
      update: (...args: unknown[]) => requestUpdate(...args),
      updateMany: vi.fn(),
      delete: vi.fn()
    },
    event: { findUnique: (...args: unknown[]) => eventFindUnique(...args) },
    dJ: { findUnique: (...args: unknown[]) => djFindUnique(...args) }
  }
}));

vi.mock('../src/services/requestPayment.service', () => ({
  createAuthorization: (...args: unknown[]) => createAuthorization(...args),
  confirmRequestPayment: vi.fn(),
  ensureAuthorization: vi.fn(),
  toCents: (value: number) => Math.round(value * 100)
}));

vi.mock('../src/services/stripe.service', () => ({ stripeService: {} }));
vi.mock('../src/services/paypal.service', () => ({ paypalService: {} }));
vi.mock('../src/services/satispay.service', () => ({
  satispayService: { cancelPayment: vi.fn(), getPayment: vi.fn() },
  satispayCredentialsFor: () => null
}));

vi.mock('../src/socket/socket', () => ({
  emitNewRequest: (...args: unknown[]) => emitNewRequest(...args),
  emitRequestAccepted: vi.fn(),
  emitRequestRejected: vi.fn(),
  emitQueueUpdated: vi.fn()
}));

const { createRequest, createRequestSchema } = await import('../src/controllers/request.controller');
const { releaseAuthorization } = await import('../src/services/paymentRelease.service');
const { MIN_DONATION } = await import('../src/config/payments');

const body = {
  eventCode: 'ABC123',
  songTitle: 'Blue Monday',
  artistName: 'New Order',
  requesterName: 'Ospite',
  donationAmount: 10,
  paymentMethod: 'CARD'
};

const servableDj = {
  id: 'dj-1',
  minDonation: new Prisma.Decimal(5),
  status: 'APPROVED',
  isAdmin: false,
  subscription: { status: 'ACTIVE' },
  eventCodeActive: true,
  stripeAccountId: 'acct_1',
  chargesEnabled: true,
  paypalMerchantId: null,
  paypalEmail: null,
  satispayKeyId: null,
  satispayPrivateKey: null
};

const eventFor = (dj: Record<string, unknown>, minDonation: number | null = 5) => ({
  id: 'evt-1',
  djId: 'dj-1',
  status: 'ACTIVE',
  minDonation: minDonation === null ? null : new Prisma.Decimal(minDonation),
  dj
});

// asyncHandler hands the promise to `.catch(next)` and returns undefined, so the
// handler is run and then waited on through the response it produces.
const invoke = async (payload: unknown) => {
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

  (createRequest as any)({ body: payload }, res, next);
  await answered;

  return { res, next };
};

beforeEach(() => {
  vi.clearAllMocks();
  eventFindUnique.mockResolvedValue(eventFor(servableDj));
  djFindUnique.mockResolvedValue(null);
  requestCreate.mockImplementation(async ({ data }: any) => ({
    ...data,
    id: 'req-1',
    createdAt: new Date('2026-09-02T21:00:00.000Z')
  }));
  requestUpdate.mockResolvedValue({});
  createAuthorization.mockResolvedValue({
    provider: 'STRIPE',
    paymentIntentId: 'pi_1',
    clientSecret: 'secret'
  });
});

describe('what an amount is allowed to be', () => {
  // Not a product preference. Stripe refuses a euro charge under fifty cents at
  // PaymentIntent creation, so a smaller donation is not a smaller payment - it
  // is a request that cannot be filed at all, answered by the provider instead
  // of by us.
  it('accepts the floor', () => {
    expect(createRequestSchema.parse({ ...body, donationAmount: MIN_DONATION })).toMatchObject({
      donationAmount: MIN_DONATION
    });
  });

  it('refuses an amount the provider would reject', () => {
    expect(() => createRequestSchema.parse({ ...body, donationAmount: 0.2 })).toThrow();
  });

  // Free requests existed for one day. They removed the only friction on an
  // unauthenticated endpoint that writes straight into a DJ's panel.
  it('refuses a zero, so there is no such thing as a free request', () => {
    expect(() => createRequestSchema.parse({ ...body, donationAmount: 0 })).toThrow();
  });

  it('refuses a negative amount', () => {
    expect(() => createRequestSchema.parse({ ...body, donationAmount: -1 })).toThrow();
  });

  it('refuses an amount above the cap', () => {
    expect(() => createRequestSchema.parse({ ...body, donationAmount: 1001 })).toThrow();
  });

  // Every request is paid for, so there is always something to pay it with.
  it('refuses a request with no payment method', () => {
    expect(() => createRequestSchema.parse({ ...body, paymentMethod: undefined })).toThrow();
  });
});

describe('the minimum quoted for a night', () => {
  it('takes the event over the DJ when the event has one', async () => {
    eventFindUnique.mockResolvedValue(eventFor(servableDj, 20));

    const { res } = await invoke({ ...body, donationAmount: 10 });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(createAuthorization).not.toHaveBeenCalled();
  });

  // Rows written during the free-request window still hold a zero, and the DJ's
  // own default predates the floor entirely. Reading either back unfloored would
  // quote a guest an amount their card refuses.
  it('never quotes below the floor, whatever is stored', async () => {
    eventFindUnique.mockResolvedValue(eventFor(servableDj, 0));

    const { res } = await invoke({ ...body, donationAmount: MIN_DONATION });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(createAuthorization).toHaveBeenCalledOnce();
  });
});

describe('a DJ who could not answer the request', () => {
  // The one that costs the guest money. The subscription lapses mid-week, the
  // event code and the QR poster are untouched, the guest pays - and then every
  // call the DJ's panel makes to accept or reject it comes back 403. Nobody can
  // move the row, so the hold sits on the card until the twelve-hour sweep.
  it('refuses before the card is touched when the subscription is gone', async () => {
    eventFindUnique.mockResolvedValue(eventFor({ ...servableDj, subscription: null }));

    const { res } = await invoke(body);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(createAuthorization).not.toHaveBeenCalled();
    expect(requestCreate).not.toHaveBeenCalled();
  });

  it('refuses when the subscription is no longer active', async () => {
    eventFindUnique.mockResolvedValue(
      eventFor({ ...servableDj, subscription: { status: 'CANCELED' } })
    );

    const { res } = await invoke(body);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(createAuthorization).not.toHaveBeenCalled();
  });

  it('refuses a DJ the admin has not approved', async () => {
    eventFindUnique.mockResolvedValue(eventFor({ ...servableDj, status: 'PENDING' }));

    const { res } = await invoke(body);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(createAuthorization).not.toHaveBeenCalled();
  });

  // The same verdict subscriptionMiddleware reaches, or the two would disagree
  // and this gate would start refusing requests a DJ could perfectly well serve.
  it('lets a failed renewal through, exactly as the panel does', async () => {
    eventFindUnique.mockResolvedValue(
      eventFor({ ...servableDj, subscription: { status: 'PAST_DUE' } })
    );

    const { res } = await invoke(body);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(createAuthorization).toHaveBeenCalledOnce();
  });

  it('lets an admin through, who has no subscription to check', async () => {
    eventFindUnique.mockResolvedValue(
      eventFor({ ...servableDj, isAdmin: true, status: 'PENDING', subscription: null })
    );

    const { res } = await invoke(body);

    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe('the legacy per-DJ event code', () => {
  beforeEach(() => {
    eventFindUnique.mockResolvedValue(null);
  });

  it('takes requests while the night is running', async () => {
    djFindUnique.mockResolvedValue(servableDj);

    const { res } = await invoke(body);

    expect(res.status).toHaveBeenCalledWith(201);
  });

  // It used to report itself active unconditionally, which meant there was no
  // way to close it at all: ending the night released the holds and wrote the
  // summary, and the same poster went on charging cards.
  it('stops taking them once the night has been ended', async () => {
    djFindUnique.mockResolvedValue({ ...servableDj, eventCodeActive: false });

    const { res } = await invoke(body);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(createAuthorization).not.toHaveBeenCalled();
  });

  it('checks the DJ can be served here too', async () => {
    djFindUnique.mockResolvedValue({ ...servableDj, subscription: null });

    const { res } = await invoke(body);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(createAuthorization).not.toHaveBeenCalled();
  });
});

describe('releasing a hold that was never taken', () => {
  // Nothing writes a free request any more, but the rows from that day are
  // still there and the expiry sweep still walks them. The guard at the head of
  // releaseAuthorization is what keeps a null method from reaching the switch.
  it('reports nothing to release', async () => {
    const outcome = await releaseAuthorization({
      id: 'req-free',
      songTitle: 'Blue Monday',
      paymentMethod: null,
      paymentIntentId: null,
      dj: { satispayKeyId: null, satispayPrivateKey: null }
    });

    expect(outcome).toEqual({ released: true, reason: 'nothing_to_release' });
  });
});
