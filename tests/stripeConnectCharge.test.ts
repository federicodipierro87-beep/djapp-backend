import { beforeEach, describe, expect, it, vi } from 'vitest';

// Read when src/config/payments is first imported, so it has to be set before
// the dynamic import below. A static import would be hoisted above this line.
process.env.PLATFORM_FEE_PERCENT = '10';

const create = vi.fn();

vi.mock('stripe', () => ({
  default: class {
    paymentIntents = { create: (...args: unknown[]) => create(...args) };
  }
}));

const { stripeService } = await import('../src/services/stripe.service');

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({ id: 'pi_1', client_secret: 'cs_1' });
});

async function paramsFor(connectedAccountId?: string | null) {
  await stripeService.createPaymentIntent(12.5, 'eur', { requestId: 'req-1' }, connectedAccountId);
  return create.mock.calls[0][0];
}

describe('createPaymentIntent', () => {
  it('holds the money on the platform when there is no connected account', async () => {
    const params = await paramsFor(null);

    expect(params.amount).toBe(1250);
    expect(params.capture_method).toBe('manual');
    expect(params.transfer_data).toBeUndefined();
    expect(params.on_behalf_of).toBeUndefined();
    expect(params.application_fee_amount).toBeUndefined();
  });

  it('settles into the DJ account when one is given', async () => {
    const params = await paramsFor('acct_dj');

    expect(params.transfer_data).toEqual({ destination: 'acct_dj' });
    expect(params.on_behalf_of).toBe('acct_dj');
  });

  it('keeps the platform fee out of what the DJ receives', async () => {
    const params = await paramsFor('acct_dj');

    // 10% of €12.50, in cents, and never more than the charge itself.
    expect(params.application_fee_amount).toBe(125);
    expect(params.application_fee_amount).toBeLessThan(params.amount);
  });

  it('still tags the request so a webhook can find it', async () => {
    const params = await paramsFor('acct_dj');

    expect(params.metadata).toMatchObject({ requestId: 'req-1', service: 'dj-request' });
  });
});
