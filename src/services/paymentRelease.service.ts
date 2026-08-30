import { Prisma } from '@prisma/client';
import prisma from '../utils/database';
import { stripeService } from './stripe.service';
import { paypalService } from './paypal.service';
import { satispayCredentialsFor, satispayService } from './satispay.service';

// Releasing a guest's authorisation used to be a provider switch copied into
// three files, each with its own idea of what a failure means. This is the one
// copy, and the only one that is idempotent: after the first release the second
// call is a no-op instead of an error the caller has to guess about.
//
// The rule that holds everything else up: `paymentStatus` records where the
// money is, not what we decided. It stays AUTHORIZED until a provider confirms
// the release, which is what makes a failed release findable again by the
// reconciliation sweep in the expiration service.

// Only the columns a release actually needs. Widening it later is a compile
// error rather than a silent `any` access.
export const RELEASABLE_FIELDS = {
  id: true,
  songTitle: true,
  paymentMethod: true,
  paymentIntentId: true,
  // Releasing a Satispay fund lock is a call into the DJ's own business
  // account, so it cannot be done without their credentials.
  dj: { select: { satispayKeyId: true, satispayPrivateKey: true } }
} as const;

export type ReleasableRequest = Prisma.RequestGetPayload<{ select: typeof RELEASABLE_FIELDS }>;

export type ReleaseOutcome =
  // The money is definitely no longer on hold.
  | { released: true; reason: 'canceled' | 'already_released' | 'nothing_to_release' }
  // It is still on hold, and retrying will not change that: either we have no
  // way to reach it, or it was captured and releasing it is the wrong verb.
  | { released: false; retryable: false; reason: 'no_credentials' | 'captured'; detail: string }
  // The provider was unreachable or unhappy. The row stays AUTHORIZED so the
  // sweep picks it up again.
  | { released: false; retryable: true; reason: 'provider_error'; detail: string };

export interface ReleaseSummary {
  attempted: number;
  released: number;
  failed: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Stripe answers a cancel on an intent that is not cancellable with this one
// code, and puts the intent's real state in the raw error body. That state is
// the difference between "someone already released it" and "the money is gone".
function unexpectedIntentState(error: unknown): string | null {
  const stripeError = error as
    | { code?: string; raw?: { payment_intent?: { status?: string } } }
    | undefined;

  if (stripeError?.code !== 'payment_intent_unexpected_state') return null;

  return stripeError.raw?.payment_intent?.status ?? null;
}

async function releaseStripe(paymentIntentId: string): Promise<ReleaseOutcome> {
  try {
    await stripeService.cancelPaymentIntent(paymentIntentId);
    return { released: true, reason: 'canceled' };
  } catch (error) {
    const state = unexpectedIntentState(error);

    // Stripe's cancel is not idempotent on its own; this is where it becomes so.
    if (state === 'canceled') {
      return { released: true, reason: 'already_released' };
    }

    if (state === 'succeeded') {
      return {
        released: false,
        retryable: false,
        reason: 'captured',
        detail: `Stripe payment ${paymentIntentId} has already been captured`
      };
    }

    return {
      released: false,
      retryable: true,
      reason: 'provider_error',
      detail: messageOf(error)
    };
  }
}

async function releasePayPal(orderId: string): Promise<ReleaseOutcome> {
  try {
    // Already idempotent: voidOrder returns null for an order with no
    // authorisation on it and short-circuits one that is already voided.
    await paypalService.voidOrder(orderId);
    return { released: true, reason: 'canceled' };
  } catch (error) {
    return {
      released: false,
      retryable: true,
      reason: 'provider_error',
      detail: messageOf(error)
    };
  }
}

async function releaseSatispay(request: ReleasableRequest, paymentId: string): Promise<ReleaseOutcome> {
  const credentials = satispayCredentialsFor(request.dj);

  if (!credentials) {
    // The DJ disconnected Satispay while this payment was outstanding. Without
    // their key there is no way to reach that money, now or on any retry: the
    // fund lock has to time out on Satispay's side.
    console.warn(
      `Cannot release Satispay payment ${paymentId}: the DJ has no credentials`
    );

    return {
      released: false,
      retryable: false,
      reason: 'no_credentials',
      detail: 'The DJ has disconnected their Satispay account'
    };
  }

  try {
    await satispayService.cancelPayment(credentials, paymentId);
    return { released: true, reason: 'canceled' };
  } catch (error) {
    // Satispay reports a cancel on an already-final payment as a plain HTTP
    // error with no machine-readable code, so the state has to be read back.
    const payment = await satispayService.getPayment(credentials, paymentId).catch(() => null);

    if (payment?.status === 'CANCELED') {
      return { released: true, reason: 'already_released' };
    }

    if (payment?.status === 'ACCEPTED') {
      return {
        released: false,
        retryable: false,
        reason: 'captured',
        detail: `Satispay payment ${paymentId} has already been accepted`
      };
    }

    return {
      released: false,
      retryable: true,
      reason: 'provider_error',
      detail: messageOf(error)
    };
  }
}

/**
 * Releases the hold on a guest's card, and never throws: a failure is a value
 * the caller can act on, because "the provider is down" and "the money was
 * already taken" need opposite handling.
 */
export async function releaseAuthorization(request: ReleasableRequest): Promise<ReleaseOutcome> {
  if (!request.paymentIntentId) {
    // No authorisation was ever attached, so there is nothing on hold. Counting
    // it as a success is what lets the row reach a terminal payment state.
    return { released: true, reason: 'nothing_to_release' };
  }

  switch (request.paymentMethod) {
    case 'CARD':
    case 'APPLE_PAY':
    case 'GOOGLE_PAY':
      return releaseStripe(request.paymentIntentId);

    case 'PAYPAL':
      return releasePayPal(request.paymentIntentId);

    case 'SATISPAY':
      return releaseSatispay(request, request.paymentIntentId);

    default: {
      // Unreachable while PaymentMethod has exactly the members above. A sixth
      // one added without a branch here must not quietly look like a success.
      const unhandled: never = request.paymentMethod;
      return {
        released: false,
        retryable: false,
        reason: 'no_credentials',
        detail: `Unknown payment method: ${String(unhandled)}`
      };
    }
  }
}

/**
 * Writes the outcome onto the request, conditionally. The status is never
 * written with a bare `update`: a capture landing at the same moment must not
 * be overwritten with CANCELED, and the `where` is what guarantees that.
 */
export async function recordReleaseOutcome(id: string, outcome: ReleaseOutcome): Promise<void> {
  if (outcome.released) {
    await prisma.request.updateMany({
      where: { id, paymentStatus: { in: ['AUTHORIZED', 'PENDING'] } },
      data: { paymentStatus: 'CANCELED' }
    });
    return;
  }

  // The row already says CAPTURED and that is the truth. Overwriting it would
  // turn a collected donation into one nobody can find.
  if (outcome.reason === 'captured') return;

  // The money is still on hold and the provider might answer next time. Leaving
  // the row AUTHORIZED is what makes the reconciliation sweep find it again.
  if (outcome.retryable) return;

  await prisma.request.updateMany({
    where: { id, paymentStatus: { in: ['AUTHORIZED', 'PENDING'] } },
    data: { paymentStatus: 'FAILED' }
  });
}

/**
 * Releases a batch, one at a time. Serial on purpose: forty calls in a row are
 * nothing to any of these providers, forty at once are a rate limit.
 */
export async function releaseAll(requests: ReleasableRequest[]): Promise<ReleaseSummary> {
  const summary: ReleaseSummary = { attempted: requests.length, released: 0, failed: 0 };

  for (const request of requests) {
    try {
      const outcome = await releaseAuthorization(request);
      await recordReleaseOutcome(request.id, outcome);

      if (outcome.released) {
        summary.released++;
      } else {
        summary.failed++;
        console.warn(`Could not release the hold on request ${request.id}: ${outcome.detail}`);
      }
    } catch (error) {
      // releaseAuthorization does not throw, so this is the database write
      // failing. One bad row must not abandon the rest of the batch.
      summary.failed++;
      console.error(`Failed to record the release of request ${request.id}:`, error);
    }
  }

  return summary;
}

/**
 * Fire-and-forget for the paths where a DJ is waiting on an HTTP response.
 * Forty provider round trips are twelve seconds of spinner while the house
 * lights come up, and nothing the DJ does next depends on the answer. If the
 * process dies halfway the reconciliation sweep picks up what is left.
 */
export function releaseInBackground(requests: ReleasableRequest[]): void {
  if (requests.length === 0) return;

  void releaseAll(requests).catch((error) => {
    console.error('Background release batch failed:', error);
  });
}

// Either the whole of a DJ's current night (the legacy per-DJ event code) or one
// Event row. Never both: another event belonging to the same DJ must not be
// closed because this one ended.
export type CloseScope = { djId: string } | { eventId: string };

/**
 * Ends a night: closes every request still open and hands back the ones that
 * are still holding money, for the caller to release once it has answered.
 *
 * The status flip is deliberately *not* filtered by paymentStatus - every
 * request of the night is closed exactly as before. Only the releases are
 * narrowed to the rows where money is actually on hold.
 */
export async function closeOutstandingRequests(scope: CloseScope): Promise<ReleasableRequest[]> {
  const holds = await prisma.request.findMany({
    where: {
      ...scope,
      status: { in: ['PENDING', 'ACCEPTED'] },
      paymentStatus: 'AUTHORIZED'
    },
    select: RELEASABLE_FIELDS
  });

  await prisma.$transaction([
    // The legacy per-DJ path empties the queue, because a DJ only ever has one
    // current event code and the next night starts from nothing. The Event path
    // must not: getPublicQueue filters queue items by eventId, so an ended
    // event's queue is simply never shown again, and deleting it would erase
    // the record of what was played.
    ...('djId' in scope ? [prisma.queueItem.deleteMany({ where: { djId: scope.djId } })] : []),
    prisma.request.updateMany({
      where: { ...scope, status: 'PENDING' },
      data: { status: 'EXPIRED' }
    }),
    prisma.request.updateMany({
      where: { ...scope, status: 'ACCEPTED' },
      data: { status: 'CLOSED' }
    })
  ]);

  return holds;
}
