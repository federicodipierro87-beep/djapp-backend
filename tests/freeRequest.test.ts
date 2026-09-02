import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

// A request that costs nothing. The danger is not that it fails - it is that it
// succeeds while looking, in the database, exactly like a request whose payment
// has not arrived yet. Three paths release real money by selecting on
// paymentStatus, so a free row has to be invisible to all three by
// construction: NOT_REQUIRED, no method, no provider, no intent.

const requestCreate = vi.fn();
const eventFindUnique = vi.fn();
const djFindUnique = vi.fn();

const createAuthorization = vi.fn();
const emitNewRequest = vi.fn();

vi.mock('../src/utils/database', () => ({
  default: {
    request: {
      create: (...args: unknown[]) => requestCreate(...args),
      update: vi.fn(),
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

const freeBody = {
  eventCode: 'ABC123',
  songTitle: 'Blue Monday',
  artistName: 'New Order',
  requesterName: 'Ospite',
  donationAmount: 0
};

// The DJ's own minimum stays €5; what decides is the event's.
const eventWithMinimum = (minDonation: number | null) => ({
  id: 'evt-1',
  djId: 'dj-1',
  status: 'ACTIVE',
  minDonation: minDonation === null ? null : new Prisma.Decimal(minDonation),
  dj: {
    id: 'dj-1',
    minDonation: new Prisma.Decimal(5),
    stripeAccountId: 'acct_1',
    chargesEnabled: true,
    paypalMerchantId: null,
    paypalEmail: null,
    satispayKeyId: null,
    satispayPrivateKey: null
  }
});

// asyncHandler hands the promise to `.catch(next)` and returns undefined, so the
// handler is run and then waited on through the response it produces.
const invoke = async (body: unknown) => {
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

  (createRequest as any)({ body }, res, next);
  await answered;

  return { res, next };
};

beforeEach(() => {
  vi.clearAllMocks();
  eventFindUnique.mockResolvedValue(eventWithMinimum(0));
  djFindUnique.mockResolvedValue(null);
  requestCreate.mockImplementation(async ({ data }: any) => ({
    ...data,
    id: 'req-free',
    createdAt: new Date('2026-09-02T21:00:00.000Z')
  }));
});

describe('what the schema lets through', () => {
  it('accepts a zero with no payment method at all', () => {
    expect(createRequestSchema.parse(freeBody)).toMatchObject({ donationAmount: 0 });
  });

  // Every tab loaded before this deploy sends one. Refusing it would break
  // pages nobody can reload on the guests' behalf.
  it('accepts a zero that still carries a payment method', () => {
    expect(() => createRequestSchema.parse({ ...freeBody, paymentMethod: 'CARD' })).not.toThrow();
  });

  it('still requires a method when there is something to charge', () => {
    expect(() => createRequestSchema.parse({ ...freeBody, donationAmount: 10 })).toThrow();
  });

  it('still refuses a negative amount', () => {
    expect(() => createRequestSchema.parse({ ...freeBody, donationAmount: -1 })).toThrow();
  });

  it('still refuses an amount above the cap', () => {
    expect(() =>
      createRequestSchema.parse({ ...freeBody, donationAmount: 1001, paymentMethod: 'CARD' })
    ).toThrow();
  });
});

describe('creating a free request', () => {
  // The whole point: no provider is told anything, because there is nothing to
  // authorise and no money to put on hold.
  it('never reaches a payment provider', async () => {
    await invoke(freeBody);

    expect(createAuthorization).not.toHaveBeenCalled();
  });

  // PENDING because the DJ has to see it now; NOT_REQUIRED because PENDING on
  // the payment column means "a payment is expected", which would make this row
  // indistinguishable from one whose authorisation never landed.
  it('writes a row that says plainly nobody is owed anything', async () => {
    await invoke(freeBody);

    expect(requestCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          donationAmount: 0,
          status: 'PENDING',
          paymentStatus: 'NOT_REQUIRED',
          paymentMethod: null,
          paymentProvider: null,
          paymentIntentId: null
        })
      })
    );
  });

  it('puts it in front of the DJ without waiting for a confirmation', async () => {
    const { res } = await invoke(freeBody);

    expect(emitNewRequest).toHaveBeenCalledWith(
      'dj-1',
      expect.objectContaining({ id: 'req-free', status: 'PENDING' })
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'PENDING', payment: null })
    );
  });

  // A method sent alongside a zero is dropped, not honoured: honouring it would
  // authorise nothing and leave the row claiming a provider it never used.
  it('ignores a payment method sent alongside a zero', async () => {
    await invoke({ ...freeBody, paymentMethod: 'CARD' });

    expect(createAuthorization).not.toHaveBeenCalled();
    expect(requestCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ paymentMethod: null }) })
    );
  });
});

describe('who is allowed to ask for free', () => {
  // The existing minimum check is the only gate there is, and it is enough.
  it('refuses a zero on an event that asks for five euro', async () => {
    eventFindUnique.mockResolvedValue(eventWithMinimum(5));

    const { res } = await invoke(freeBody);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(requestCreate).not.toHaveBeenCalled();
  });

  // An event created before the column existed has no minimum of its own, so
  // the DJ's profile still decides - and theirs is five euro.
  it('refuses a zero on an event that never set a minimum', async () => {
    eventFindUnique.mockResolvedValue(eventWithMinimum(null));

    const { res } = await invoke(freeBody);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(requestCreate).not.toHaveBeenCalled();
  });
});

describe('releasing a hold that was never taken', () => {
  // The guard at the head of releaseAuthorization, not a sixth case in the
  // switch: a null method is the absence of a payment, not a kind of one.
  it('reports nothing to release on a free request', async () => {
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
