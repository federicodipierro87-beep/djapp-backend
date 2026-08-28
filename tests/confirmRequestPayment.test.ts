import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const findUnique = vi.fn();
const updateMany = vi.fn();
const retrieve = vi.fn();
const emitNewRequest = vi.fn();

vi.mock('../src/utils/database', () => ({
  default: { request: { findUnique: (...args: unknown[]) => findUnique(...args), updateMany: (...args: unknown[]) => updateMany(...args) } }
}));

vi.mock('../src/services/stripe.service', () => ({
  stripeService: { getPaymentIntent: (...args: unknown[]) => retrieve(...args) }
}));

vi.mock('../src/services/paypal.service', () => ({ paypalService: {} }));
vi.mock('../src/services/satispay.service', () => ({
  satispayService: {},
  // Reading the real one would need the encryption key. These drafts are all
  // Stripe, so the answer never gets as far as being used.
  satispayCredentialsFor: () => null
}));

vi.mock('../src/socket/socket', () => ({
  emitNewRequest: (...args: unknown[]) => emitNewRequest(...args)
}));

const { confirmRequestPayment } = await import('../src/services/requestPayment.service');

const draft = {
  id: 'req-1',
  djId: 'dj-1',
  songTitle: 'Blue Monday',
  artistName: 'New Order',
  albumCover: null,
  requesterName: 'Ospite',
  donationAmount: new Prisma.Decimal(10),
  status: 'AWAITING_PAYMENT',
  paymentStatus: 'PENDING',
  paymentProvider: 'STRIPE',
  paymentIntentId: 'pi_1',
  createdAt: new Date()
};

const authorized = { status: 'requires_capture', amount_capturable: 1000, currency: 'eur' };

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(draft);
  updateMany.mockResolvedValue({ count: 1 });
  retrieve.mockResolvedValue(authorized);
});

describe('confirmRequestPayment', () => {
  it('promotes a draft whose authorisation checks out', async () => {
    await expect(confirmRequestPayment('req-1')).resolves.toEqual({ outcome: 'confirmed' });

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'req-1', status: 'AWAITING_PAYMENT' },
        data: expect.objectContaining({ status: 'PENDING', paymentStatus: 'AUTHORIZED' })
      })
    );
    expect(emitNewRequest).toHaveBeenCalledOnce();
  });

  // The whole point of the inverted flow: the DJ never sees a request until the
  // provider itself says the money is on hold.
  it('refuses a payment the provider has not authorised', async () => {
    retrieve.mockResolvedValue({ ...authorized, status: 'requires_payment_method', amount_capturable: 0 });

    await expect(confirmRequestPayment('req-1')).resolves.toMatchObject({ outcome: 'not_authorized' });
    expect(updateMany).not.toHaveBeenCalled();
    expect(emitNewRequest).not.toHaveBeenCalled();
  });

  it('refuses an authorisation smaller than the donation it claims to pay', async () => {
    retrieve.mockResolvedValue({ ...authorized, amount_capturable: 100 });

    await expect(confirmRequestPayment('req-1')).resolves.toMatchObject({ outcome: 'not_authorized' });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('refuses an authorisation in another currency', async () => {
    retrieve.mockResolvedValue({ ...authorized, currency: 'usd' });

    await expect(confirmRequestPayment('req-1')).resolves.toMatchObject({ outcome: 'not_authorized' });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('refuses a request that has no payment attached', async () => {
    findUnique.mockResolvedValue({ ...draft, paymentIntentId: null });

    await expect(confirmRequestPayment('req-1')).resolves.toMatchObject({ outcome: 'not_authorized' });
  });

  // The webhook and the guest's browser race each other, and both call this.
  it('is idempotent once the request is already pending', async () => {
    findUnique.mockResolvedValue({ ...draft, status: 'PENDING' });

    await expect(confirmRequestPayment('req-1')).resolves.toEqual({ outcome: 'already_confirmed' });
    expect(updateMany).not.toHaveBeenCalled();
    expect(emitNewRequest).not.toHaveBeenCalled();
  });

  it('does not announce a request a concurrent caller already claimed', async () => {
    updateMany.mockResolvedValue({ count: 0 });

    await expect(confirmRequestPayment('req-1')).resolves.toEqual({ outcome: 'already_confirmed' });
    expect(emitNewRequest).not.toHaveBeenCalled();
  });

  it('reports an expired draft as gone rather than resurrecting it', async () => {
    findUnique.mockResolvedValue({ ...draft, status: 'EXPIRED' });

    await expect(confirmRequestPayment('req-1')).resolves.toEqual({ outcome: 'no_longer_available' });
  });

  it('reports an unknown request', async () => {
    findUnique.mockResolvedValue(null);

    await expect(confirmRequestPayment('nope')).resolves.toEqual({ outcome: 'not_found' });
  });
});
