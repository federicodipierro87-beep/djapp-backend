import { DJStatus, SubscriptionStatus } from '@prisma/client';

/**
 * Whether a DJ can be handed a request at all.
 *
 * This is the same verdict subscriptionMiddleware reaches, but asked on the
 * public side of the app, before a guest's card is touched. The two have to
 * agree: a request filed for a DJ who fails this check becomes PENDING, the
 * DJ's own panel answers 403 to every call that could accept or reject it, and
 * the hold sits on the guest's card until the twelve-hour sweep releases it.
 * Nobody involved is told. The guest paid for a song that could not be asked
 * for.
 */

// Mirrors subscriptionMiddleware. PAST_DUE is deliberately in: a failed renewal
// must not take a DJ's night down mid-set, Stripe retries it for days.
const ACTIVE_SUBSCRIPTION_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.TRIALING,
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE
];

export type DJAvailability = {
  status: DJStatus;
  isAdmin: boolean;
  subscription: { status: SubscriptionStatus } | null;
};

// For a findUnique that already pulls the whole DJ row.
export const DJ_AVAILABILITY_INCLUDE = {
  subscription: { select: { status: true } }
} as const;

// For a findUnique that lists its columns.
export const DJ_AVAILABILITY_SELECT = {
  status: true,
  isAdmin: true,
  subscription: { select: { status: true } }
} as const;

export function canServeRequests(dj: DJAvailability): boolean {
  // The platform's own accounts have no subscription and are not approved by
  // anyone, so they would fail both tests below.
  if (dj.isAdmin) return true;

  if (dj.status !== DJStatus.APPROVED) return false;

  return dj.subscription !== null && ACTIVE_SUBSCRIPTION_STATUSES.includes(dj.subscription.status);
}
