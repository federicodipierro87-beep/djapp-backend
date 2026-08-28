import {
  ApiError,
  AuthorizationStatus,
  CheckoutPaymentIntent,
  Client,
  Environment,
  OrderStatus,
  OrdersController,
  PaymentsController,
  PaypalExperienceUserAction
} from '@paypal/paypal-server-sdk';
import type {
  AuthorizationWithAdditionalData,
  OrderRequest,
  PurchaseUnitRequest
} from '@paypal/paypal-server-sdk';
import { platformFeeInCents } from '../config/payments';

// The order as the rest of the app cares about it: an id to remember and a URL
// to send the guest to.
export interface PayPalOrder {
  id: string;
  approvalUrl: string | null;
}

// One authorisation, flattened out of the nest of optional fields PayPal
// returns it in.
export interface PayPalAuthorization {
  id: string;
  status: AuthorizationStatus | undefined;
  amountInCents: number;
  currency: string;
}

export interface PayPalPayee {
  merchantId?: string | null;
  email?: string | null;
}

// PayPal only accepts money as a decimal string, and rounding it late is how a
// €10.00 request ends up authorised for €9.999999999.
function toAmountValue(amountInCents: number): string {
  return (amountInCents / 100).toFixed(2);
}

// Built here rather than passed in: the guest comes back from paypal.com to a
// page that has to know which request to confirm, and the request id is the
// only thing that identifies it.
function returnUrls(requestId: string) {
  const base = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

  return {
    returnUrl: `${base}/payment/return?requestId=${requestId}`,
    cancelUrl: `${base}/payment/cancelled?requestId=${requestId}`
  };
}

// Constructed on first use, not at import. PayPal is switched off by default,
// and a server that will never call it should not refuse to boot because its
// credentials are missing.
let cached: { orders: OrdersController; payments: PaymentsController } | null = null;

function api() {
  if (cached) return cached;

  const oAuthClientId = process.env.PAYPAL_CLIENT_ID;
  const oAuthClientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!oAuthClientId || !oAuthClientSecret) {
    throw new Error('PayPal credentials are not configured');
  }

  const client = new Client({
    clientCredentialsAuthCredentials: { oAuthClientId, oAuthClientSecret },
    environment: process.env.PAYPAL_MODE === 'live' ? Environment.Production : Environment.Sandbox,
    timeout: 15000
  });

  cached = {
    orders: new OrdersController(client),
    payments: new PaymentsController(client)
  };

  return cached;
}

// Express types every header as possibly repeated. PayPal never repeats these,
// and a request that does is not one of theirs.
function header(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

function restBase(): string {
  return process.env.PAYPAL_MODE === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

// The SDK has controllers for orders and payments but none for webhook
// verification, so that one call is made by hand and needs a token of its own.
let token: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (token && token.expiresAt > Date.now()) return token.value;

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('PayPal credentials are not configured');
  }

  const response = await fetch(`${restBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (!response.ok) {
    throw new Error(`PayPal token request failed with ${response.status}`);
  }

  const body = (await response.json()) as { access_token: string; expires_in: number };

  // A minute of slack, so a token that is about to lapse is not handed to a
  // call that takes longer than it has left.
  token = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in - 60) * 1000
  };

  return token.value;
}

// PayPal reports business failures as a list of issue codes rather than status
// codes, and this is the one that means the honor period ran out.
function isExpiredAuthorization(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;

  const details = (error.result as { details?: Array<{ issue?: string }> } | undefined)?.details;
  return Boolean(details?.some((detail) => detail.issue === 'AUTHORIZATION_EXPIRED'));
}

function flatten(
  authorization: AuthorizationWithAdditionalData | undefined
): PayPalAuthorization | null {
  if (!authorization?.id) return null;

  return {
    id: authorization.id,
    status: authorization.status,
    amountInCents: Math.round(Number(authorization.amount?.value ?? 0) * 100),
    currency: authorization.amount?.currencyCode ?? ''
  };
}

export class PayPalService {
  // The money is held, not taken: the guest is only charged when the DJ
  // actually plays the song, which is the same contract as the Stripe side.
  async createOrder(
    amountInCents: number,
    currency: string,
    requestId: string,
    payee: PayPalPayee = {}
  ): Promise<PayPalOrder> {
    const { returnUrl, cancelUrl } = returnUrls(requestId);
    const value = toAmountValue(amountInCents);

    const purchaseUnit: PurchaseUnitRequest = {
      referenceId: requestId,
      // Echoed back on the webhook, which is how an authorisation found without
      // the guest's browser still leads to the right row.
      customId: requestId,
      description: 'Richiesta musicale',
      amount: { currencyCode: currency, value }
    };

    // Multiparty: the DJ is the merchant and we take a fee, rather than the
    // money landing on the platform account with no way out of it. A merchant
    // id comes from partner onboarding; the email is the fallback for a DJ who
    // has only told us their PayPal address.
    if (payee.merchantId || payee.email) {
      purchaseUnit.payee = payee.merchantId
        ? { merchantId: payee.merchantId }
        : { emailAddress: payee.email! };

      const fee = platformFeeInCents(amountInCents);
      if (fee > 0) {
        purchaseUnit.paymentInstruction = {
          platformFees: [{ amount: { currencyCode: currency, value: toAmountValue(fee) } }]
        };
      }
    }

    const body: OrderRequest = {
      intent: CheckoutPaymentIntent.Authorize,
      purchaseUnits: [purchaseUnit],
      paymentSource: {
        paypal: {
          experienceContext: {
            brandName: 'DJ Request',
            locale: 'it-IT',
            returnUrl,
            cancelUrl,
            userAction: PaypalExperienceUserAction.PayNow
          }
        }
      }
    };

    try {
      const { result } = await api().orders.createOrder({
        body,
        // Without this PayPal answers with an id and nothing else.
        prefer: 'return=representation',
        // Makes a retried create return the original order instead of taking a
        // second hold on the guest's account.
        paypalRequestId: `request-${requestId}`
      });

      if (!result.id) {
        throw new Error('PayPal returned an order without an id');
      }

      return {
        id: result.id,
        approvalUrl: result.links?.find((link) => link.rel === 'approve')?.href ?? null
      };
    } catch (error) {
      console.error('PayPal order creation failed:', error);
      throw error;
    }
  }

  // The step the old integration never took. Approving an order at paypal.com
  // does not place a hold on anything: without this call there is no
  // authorisation to capture later, which is why capture never once worked.
  async authorizeApprovedOrder(orderId: string): Promise<PayPalAuthorization | null> {
    const existing = await this.findAuthorization(orderId);

    // Authorising twice is an error, and both the guest's browser and the
    // webhook come through here.
    if (existing) return existing;

    const { result: order } = await api().orders.getOrder({ id: orderId });

    // Anything else means the guest has not finished at paypal.com yet.
    if (order.status !== OrderStatus.Approved) return null;

    try {
      const { result } = await api().orders.authorizeOrder({
        id: orderId,
        prefer: 'return=representation'
      });

      return flatten(result.purchaseUnits?.[0]?.payments?.authorizations?.[0]);
    } catch (error) {
      console.error('PayPal order authorization failed:', error);
      throw error;
    }
  }

  async findAuthorization(orderId: string): Promise<PayPalAuthorization | null> {
    try {
      const { result } = await api().orders.getOrder({ id: orderId });
      return flatten(result.purchaseUnits?.[0]?.payments?.authorizations?.[0]);
    } catch (error) {
      console.error('PayPal order retrieval failed:', error);
      throw error;
    }
  }

  // Called when the song is played. Every caller has an order id, because that
  // is what the request row stores; the authorisation id lives inside it.
  async captureOrder(orderId: string) {
    const authorization = await this.requireAuthorization(orderId);

    try {
      return await this.capture(authorization.id, orderId);
    } catch (error) {
      if (!isExpiredAuthorization(error)) throw error;

      // PayPal guarantees a hold for three days and lets it stand for
      // twenty-nine. A song still sitting in the queue after three days is odd
      // but not the guest's fault, so ask for the hold back rather than losing
      // the donation.
      console.warn(`PayPal authorization ${authorization.id} expired, reauthorizing`);

      const { result } = await api().payments.reauthorizePayment({
        authorizationId: authorization.id,
        prefer: 'return=representation'
      });

      if (!result.id) {
        throw new Error('PayPal reauthorization returned no authorization id');
      }

      return this.capture(result.id, orderId);
    }
  }

  // Called when the song is skipped, rejected or expires: the hold is released
  // and the guest is never charged.
  async voidOrder(orderId: string) {
    const authorization = await this.findAuthorization(orderId);

    // An order the guest never approved has no hold on it, which is the normal
    // state of a request abandoned mid-payment. There is nothing to release and
    // PayPal drops the order on its own.
    if (!authorization) return null;

    if (authorization.status === AuthorizationStatus.Voided) {
      return authorization;
    }

    try {
      const { result } = await api().payments.voidPayment({
        authorizationId: authorization.id,
        prefer: 'return=representation'
      });

      return result;
    } catch (error) {
      console.error('PayPal authorization void failed:', error);
      throw error;
    }
  }

  // PayPal signs its notifications and only PayPal can check the signature, so
  // this is a round trip rather than a local computation. Without it the webhook
  // is an unauthenticated endpoint that moves money.
  async verifyWebhookSignature(
    headers: Record<string, string | string[] | undefined>,
    event: unknown
  ): Promise<boolean> {
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;

    if (!webhookId) {
      throw new Error('PAYPAL_WEBHOOK_ID is not configured');
    }

    const response = await fetch(`${restBase()}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        auth_algo: header(headers, 'paypal-auth-algo'),
        cert_url: header(headers, 'paypal-cert-url'),
        transmission_id: header(headers, 'paypal-transmission-id'),
        transmission_sig: header(headers, 'paypal-transmission-sig'),
        transmission_time: header(headers, 'paypal-transmission-time'),
        webhook_id: webhookId,
        webhook_event: event
      })
    });

    if (!response.ok) {
      console.error(`PayPal webhook verification returned ${response.status}`);
      return false;
    }

    const body = (await response.json()) as { verification_status?: string };
    return body.verification_status === 'SUCCESS';
  }

  private async capture(authorizationId: string, orderId: string) {
    const { result } = await api().payments.captureAuthorizedPayment({
      authorizationId,
      prefer: 'return=representation',
      // A retry after a timeout must not charge the guest a second time.
      paypalRequestId: `capture-${orderId}`,
      // Nothing else will ever be taken against this hold, so PayPal can
      // release the remainder immediately.
      body: { finalCapture: true }
    });

    return result;
  }

  private async requireAuthorization(orderId: string): Promise<PayPalAuthorization> {
    const authorization = await this.findAuthorization(orderId);

    if (!authorization) {
      // Loudly, because the alternative is a donation that quietly never
      // arrives.
      throw new Error(`PayPal order ${orderId} has no authorization to act on`);
    }

    return authorization;
  }
}

export const paypalService = new PayPalService();
