import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@paypal/paypal-server-sdk';

// Both read when their module is first imported, so they have to be set before
// the dynamic import below. A static import would be hoisted above these lines.
process.env.PLATFORM_FEE_PERCENT = '10';
process.env.PAYPAL_CLIENT_ID = 'test-client-id';
process.env.PAYPAL_CLIENT_SECRET = 'test-client-secret';
process.env.FRONTEND_URL = 'https://app.example.com';

const createOrder = vi.fn();
const getOrder = vi.fn();
const authorizeOrder = vi.fn();
const captureAuthorizedPayment = vi.fn();
const voidPayment = vi.fn();
const reauthorizePayment = vi.fn();

// Only the two controllers are replaced. The enums and the error class are the
// real ones, because the service compares against them and a hand-written copy
// would pass the test while the real values had moved on.
vi.mock('@paypal/paypal-server-sdk', async () => {
  const actual = await vi.importActual<typeof import('@paypal/paypal-server-sdk')>(
    '@paypal/paypal-server-sdk'
  );

  return {
    ...actual,
    Client: class {},
    OrdersController: class {
      createOrder = createOrder;
      getOrder = getOrder;
      authorizeOrder = authorizeOrder;
    },
    PaymentsController: class {
      captureAuthorizedPayment = captureAuthorizedPayment;
      voidPayment = voidPayment;
      reauthorizePayment = reauthorizePayment;
    }
  };
});

const { paypalService } = await import('../src/services/paypal.service');

function authorization(overrides: Record<string, unknown> = {}) {
  return {
    id: 'auth-1',
    status: 'CREATED',
    amount: { currencyCode: 'EUR', value: '10.00' },
    ...overrides
  };
}

function orderWith(authorizations: unknown[] | undefined, status = 'APPROVED') {
  return {
    result: {
      id: 'order-1',
      status,
      purchaseUnits: authorizations ? [{ payments: { authorizations } }] : [{}]
    }
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  createOrder.mockResolvedValue({
    result: {
      id: 'order-1',
      links: [
        { rel: 'self', href: 'https://api.paypal.com/order-1' },
        { rel: 'approve', href: 'https://paypal.com/checkoutnow?token=order-1' }
      ]
    }
  });
});

async function orderPayload(payee?: { merchantId?: string | null; email?: string | null }) {
  await paypalService.createOrder(1000, 'EUR', 'req-1', payee);
  return createOrder.mock.calls[0][0];
}

describe('createOrder', () => {
  it('asks for a hold rather than a charge, priced as a decimal string', async () => {
    const payload = await orderPayload();

    expect(payload.body.intent).toBe('AUTHORIZE');
    // Not 10, not 1000, and not 9.999999999.
    expect(payload.body.purchaseUnits[0].amount).toEqual({
      currencyCode: 'EUR',
      value: '10.00'
    });
  });

  it('carries the request id where both the browser and the webhook can find it', async () => {
    const payload = await orderPayload();

    expect(payload.body.purchaseUnits[0].referenceId).toBe('req-1');
    expect(payload.body.purchaseUnits[0].customId).toBe('req-1');
    expect(payload.body.paymentSource.paypal.experienceContext.returnUrl).toBe(
      'https://app.example.com/payment/return?requestId=req-1'
    );
  });

  it('does not take a second hold when the create is retried', async () => {
    const payload = await orderPayload();

    expect(payload.paypalRequestId).toBe('request-req-1');
    // Without this PayPal answers with an id and nothing else, and there is no
    // approval URL to send the guest to.
    expect(payload.prefer).toBe('return=representation');
  });

  it('pays the DJ by merchant id when they have been through onboarding', async () => {
    const payload = await orderPayload({ merchantId: 'MERCH1', email: 'dj@example.com' });

    expect(payload.body.purchaseUnits[0].payee).toEqual({ merchantId: 'MERCH1' });
  });

  it('falls back to the PayPal address when they have not', async () => {
    const payload = await orderPayload({ merchantId: null, email: 'dj@example.com' });

    expect(payload.body.purchaseUnits[0].payee).toEqual({ emailAddress: 'dj@example.com' });
  });

  it('keeps the platform fee out of what the DJ receives', async () => {
    const payload = await orderPayload({ merchantId: 'MERCH1' });

    // 10% of €10.00.
    expect(payload.body.purchaseUnits[0].paymentInstruction.platformFees).toEqual([
      { amount: { currencyCode: 'EUR', value: '1.00' } }
    ]);
  });

  it('names no payee and takes no fee when the DJ has told us nothing', async () => {
    const payload = await orderPayload();

    expect(payload.body.purchaseUnits[0].payee).toBeUndefined();
    // A fee on an order that has no payee would be charged against ourselves.
    expect(payload.body.purchaseUnits[0].paymentInstruction).toBeUndefined();
  });

  it('returns the URL the guest has to be sent to', async () => {
    const order = await paypalService.createOrder(1000, 'EUR', 'req-1');

    expect(order.approvalUrl).toBe('https://paypal.com/checkoutnow?token=order-1');
  });
});

describe('authorizeApprovedOrder', () => {
  it('places the hold that approving at paypal.com does not', async () => {
    getOrder.mockResolvedValue(orderWith(undefined));
    authorizeOrder.mockResolvedValue(orderWith([authorization()]));

    const result = await paypalService.authorizeApprovedOrder('order-1');

    expect(authorizeOrder).toHaveBeenCalledOnce();
    expect(result).toEqual({
      id: 'auth-1',
      status: 'CREATED',
      amountInCents: 1000,
      currency: 'EUR'
    });
  });

  it('does not authorize twice when the webhook and the browser both arrive', async () => {
    getOrder.mockResolvedValue(orderWith([authorization()]));

    const result = await paypalService.authorizeApprovedOrder('order-1');

    expect(authorizeOrder).not.toHaveBeenCalled();
    expect(result?.id).toBe('auth-1');
  });

  it('holds nothing while the guest is still at paypal.com', async () => {
    getOrder.mockResolvedValue(orderWith(undefined, 'CREATED'));

    expect(await paypalService.authorizeApprovedOrder('order-1')).toBeNull();
    expect(authorizeOrder).not.toHaveBeenCalled();
  });
});

describe('captureOrder', () => {
  it('captures the hold once, and only once', async () => {
    getOrder.mockResolvedValue(orderWith([authorization()]));
    captureAuthorizedPayment.mockResolvedValue({ result: { id: 'capture-1', status: 'COMPLETED' } });

    await paypalService.captureOrder('order-1');

    expect(captureAuthorizedPayment).toHaveBeenCalledOnce();
    const payload = captureAuthorizedPayment.mock.calls[0][0];
    expect(payload.authorizationId).toBe('auth-1');
    expect(payload.body.finalCapture).toBe(true);
    // A retry after a timeout must not charge the guest a second time.
    expect(payload.paypalRequestId).toBe('capture-order-1');
  });

  it('asks for the hold back rather than losing a donation left in the queue too long', async () => {
    getOrder.mockResolvedValue(orderWith([authorization()]));
    captureAuthorizedPayment
      .mockRejectedValueOnce(expiredAuthorization())
      .mockResolvedValueOnce({ result: { id: 'capture-1', status: 'COMPLETED' } });
    reauthorizePayment.mockResolvedValue({ result: { id: 'auth-2' } });

    await paypalService.captureOrder('order-1');

    expect(reauthorizePayment).toHaveBeenCalledOnce();
    expect(captureAuthorizedPayment).toHaveBeenCalledTimes(2);
    expect(captureAuthorizedPayment.mock.calls[1][0].authorizationId).toBe('auth-2');
  });

  it('refuses to guess when there is no hold to capture', async () => {
    getOrder.mockResolvedValue(orderWith(undefined));

    await expect(paypalService.captureOrder('order-1')).rejects.toThrow('no authorization');
  });
});

describe('voidOrder', () => {
  it('releases the hold', async () => {
    getOrder.mockResolvedValue(orderWith([authorization()]));
    voidPayment.mockResolvedValue({ result: { id: 'auth-1', status: 'VOIDED' } });

    await paypalService.voidOrder('order-1');

    expect(voidPayment).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationId: 'auth-1' })
    );
  });

  it('does nothing for an order the guest abandoned before approving it', async () => {
    getOrder.mockResolvedValue(orderWith(undefined));

    expect(await paypalService.voidOrder('order-1')).toBeNull();
    expect(voidPayment).not.toHaveBeenCalled();
  });

  it('does not void an authorisation that is already void', async () => {
    getOrder.mockResolvedValue(orderWith([authorization({ status: 'VOIDED' })]));

    await paypalService.voidOrder('order-1');

    expect(voidPayment).not.toHaveBeenCalled();
  });
});

// PayPal reports the expired honor period as an issue code inside the body, not
// as a status code, so the service has to dig for it.
function expiredAuthorization() {
  const error = new ApiError(
    {
      request: { method: 'POST', url: '' },
      response: { statusCode: 422, headers: {}, body: '' }
    } as never,
    'Unprocessable Entity'
  );

  error.result = { details: [{ issue: 'AUTHORIZATION_EXPIRED' }] };
  return error;
}
