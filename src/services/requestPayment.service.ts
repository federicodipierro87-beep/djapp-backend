import { PaymentProvider } from '@prisma/client';
import prisma from '../utils/database';
import { CURRENCY } from '../config/payments';
import { stripeService } from './stripe.service';
import { paypalService } from './paypal.service';
import { satispayService } from './satispay.service';
import { emitNewRequest } from '../socket/socket';

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
  amount: number
): Promise<PaymentInstructions> {
  switch (provider) {
    case PaymentProvider.STRIPE: {
      const paymentIntent = await stripeService.createPaymentIntent(amount, CURRENCY, {
        requestId
      });

      return {
        provider,
        paymentIntentId: paymentIntent.id,
        clientSecret: paymentIntent.client_secret ?? undefined
      };
    }

    case PaymentProvider.PAYPAL: {
      const order = await paypalService.createOrder(amount);

      return {
        provider,
        paymentIntentId: order.id,
        approvalUrl: order.links?.find((link: { rel: string }) => link.rel === 'approve')?.href
      };
    }

    case PaymentProvider.SATISPAY: {
      const payment = await satispayService.createPayment(amount);

      return {
        provider,
        paymentIntentId: payment.id,
        redirectUrl: payment.redirect_url
      };
    }
  }
}

export async function readAuthorization(
  provider: PaymentProvider,
  paymentIntentId: string
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
      const order = await paypalService.getOrder(paymentIntentId);
      const authorization = order.purchase_units?.[0]?.payments?.authorizations?.[0];
      const captured = authorization?.amount;

      return {
        authorized: authorization?.status === 'CREATED',
        amountInCents: captured ? toCents(Number(captured.value)) : 0,
        currency: captured?.currency_code ?? ''
      };
    }

    case PaymentProvider.SATISPAY: {
      const payment = await satispayService.getPayment(paymentIntentId);

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
  const request = await prisma.request.findUnique({ where: { id: requestId } });

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

  const authorization = await readAuthorization(
    request.paymentProvider,
    request.paymentIntentId
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
