import { PaymentProvider } from '@prisma/client';
import { AuthorizationStatus } from '@paypal/paypal-server-sdk';
import prisma from '../utils/database';
import { CURRENCY } from '../config/payments';
import { stripeService } from './stripe.service';
import { paypalService } from './paypal.service';
import {
  SatispayCredentials,
  satispayCredentialsFor,
  satispayService
} from './satispay.service';
import { emitNewRequest } from '../socket/socket';

// Where a donation is meant to end up. Each provider reads only its own fields,
// and all-null means the money stays on the platform account - the behaviour
// from before any of this existed, and still what happens while the DJ has not
// connected anything.
//
// Satispay is the exception: it has no platform account to fall back to, so
// without the DJ's own credentials there is no payment to create at all.
export interface PayoutDestination {
  stripeAccountId?: string | null;
  paypalMerchantId?: string | null;
  paypalEmail?: string | null;
  satispay?: SatispayCredentials | null;
}

// What a guest is handed so their browser can complete the payment. Which field
// is populated depends on the provider; the shape is stable so the client does
// not have to know the difference.
export interface PaymentInstructions {
  provider: PaymentProvider;
  paymentIntentId: string;
  clientSecret?: string;
  approvalUrl?: string;
  redirectUrl?: string;
}

// The provider's own view of the authorisation, in the smallest currency unit.
// Everything the server decides is based on this, never on what the client says.
interface AuthorizationState {
  authorized: boolean;
  amountInCents: number;
  currency: string;
}

export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export async function createAuthorization(
  provider: PaymentProvider,
  requestId: string,
  amount: number,
  destination: PayoutDestination = {}
): Promise<PaymentInstructions> {
  switch (provider) {
    case PaymentProvider.STRIPE: {
      const paymentIntent = await stripeService.createPaymentIntent(
        amount,
        CURRENCY,
        { requestId },
        destination.stripeAccountId
      );

      return {
        provider,
        paymentIntentId: paymentIntent.id,
        clientSecret: paymentIntent.client_secret ?? undefined
      };
    }

    case PaymentProvider.PAYPAL: {
      // PayPal wants the currency in upper case and the amount as a decimal
      // string, both of which the service handles; it needs the request id so
      // the guest comes back to a page that knows what they were paying for.
      const order = await paypalService.createOrder(
        toCents(amount),
        CURRENCY.toUpperCase(),
        requestId,
        { merchantId: destination.paypalMerchantId, email: destination.paypalEmail }
      );

      return {
        provider,
        paymentIntentId: order.id,
        approvalUrl: order.approvalUrl ?? undefined
      };
    }

    case PaymentProvider.SATISPAY: {
      if (!destination.satispay) {
        throw new Error('This DJ has not connected a Satispay account');
      }

      // Created PENDING; it becomes AUTHORIZED when the guest approves it in
      // the Satispay app, which is what the redirect sends them off to do.
      const payment = await satispayService.createFundLock(
        destination.satispay,
        toCents(amount),
        CURRENCY.toUpperCase(),
        requestId
      );

      return {
        provider,
        paymentIntentId: payment.id,
        redirectUrl: payment.redirect_url
      };
    }
  }
}

// Not a pure read for every provider: PayPal only places the hold when it is
// asked to, and this is where it gets asked. Idempotent all the same, because
// both the guest's browser and the webhook come through here.
export async function ensureAuthorization(
  provider: PaymentProvider,
  paymentIntentId: string,
  // Only Satispay needs these: Stripe and PayPal are read with the platform's
  // own credentials whoever the money is destined for, while a Satispay payment
  // exists only inside the DJ's business account and is invisible without them.
  satispay?: SatispayCredentials | null
): Promise<AuthorizationState> {
  switch (provider) {
    case PaymentProvider.STRIPE: {
      const paymentIntent = await stripeService.getPaymentIntent(paymentIntentId);

      // A manual-capture intent sits in requires_capture once the card has been
      // authorised. amount_capturable is what the bank actually put on hold,
      // which can be less than the amount we asked for.
      return {
        authorized: paymentIntent.status === 'requires_capture',
        amountInCents: paymentIntent.amount_capturable,
        currency: paymentIntent.currency
      };
    }

    case PaymentProvider.PAYPAL: {
      // Approving an order at paypal.com does not put anything on hold. This
      // call is what turns the approval into an authorisation, and skipping it
      // is why capture never worked before.
      const authorization = await paypalService.authorizeApprovedOrder(paymentIntentId);

      return {
        authorized: authorization?.status === AuthorizationStatus.Created,
        amountInCents: authorization?.amountInCents ?? 0,
        currency: authorization?.currency ?? ''
      };
    }

    case PaymentProvider.SATISPAY: {
      if (!satispay) {
        throw new Error('This DJ has not connected a Satispay account');
      }

      // A fund lock is a genuine hold, so unlike PayPal there is nothing to
      // trigger here - only to look at. AUTHORIZED means the guest approved it
      // and the money is reserved.
      const payment = await satispayService.getPayment(satispay, paymentIntentId);

      return {
        authorized: payment.status === 'AUTHORIZED',
        amountInCents: payment.amount_unit ?? 0,
        currency: payment.currency ?? ''
      };
    }
  }
}

export type ConfirmOutcome =
  | { outcome: 'confirmed' }
  | { outcome: 'already_confirmed' }
  | { outcome: 'not_found' }
  | { outcome: 'no_longer_available' }
  | { outcome: 'not_authorized'; detail: string };

// The single place a request is allowed to become visible to the DJ. Both the
// guest's confirm call and the provider webhook go through here, so whichever
// arrives first wins and the second one is a no-op.
export async function confirmRequestPayment(requestId: string): Promise<ConfirmOutcome> {
  const request = await prisma.request.findUnique({
    where: { id: requestId },
    // A Satispay payment cannot even be read without the DJ's own credentials,
    // so they are fetched alongside rather than in a second round trip.
    include: { dj: { select: { satispayKeyId: true, satispayPrivateKey: true } } }
  });

  if (!request) {
    return { outcome: 'not_found' };
  }

  if (request.status !== 'AWAITING_PAYMENT') {
    // Someone got here first, or the request has already run its course.
    return request.status === 'EXPIRED' || request.status === 'REJECTED'
      ? { outcome: 'no_longer_available' }
      : { outcome: 'already_confirmed' };
  }

  if (!request.paymentIntentId || !request.paymentProvider) {
    return { outcome: 'not_authorized', detail: 'No payment is attached to this request' };
  }

  const authorization = await ensureAuthorization(
    request.paymentProvider,
    request.paymentIntentId,
    satispayCredentialsFor(request.dj)
  );

  if (!authorization.authorized) {
    return { outcome: 'not_authorized', detail: 'The payment has not been authorised' };
  }

  if (authorization.currency.toLowerCase() !== CURRENCY) {
    return { outcome: 'not_authorized', detail: 'The payment is in the wrong currency' };
  }

  // Guards against an authorisation for one euro being used to buy a request
  // the guest declared as fifty.
  if (authorization.amountInCents < toCents(request.donationAmount.toNumber())) {
    return { outcome: 'not_authorized', detail: 'The authorised amount is too low' };
  }

  const claimed = await prisma.request.updateMany({
    where: { id: requestId, status: 'AWAITING_PAYMENT' },
    data: {
      status: 'PENDING',
      paymentStatus: 'AUTHORIZED',
      authorizedAt: new Date()
    }
  });

  if (claimed.count !== 1) {
    return { outcome: 'already_confirmed' };
  }

  emitNewRequest(request.djId, {
    id: request.id,
    songTitle: request.songTitle,
    artistName: request.artistName,
    albumCover: request.albumCover,
    requesterName: request.requesterName,
    donationAmount: request.donationAmount,
    status: 'PENDING',
    createdAt: request.createdAt
  });

  return { outcome: 'confirmed' };
}
