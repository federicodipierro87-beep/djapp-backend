import cron from 'node-cron';
import prisma from '../utils/database';
import {
  RELEASABLE_FIELDS,
  releaseAll,
  releaseAuthorization,
  recordReleaseOutcome
} from './paymentRelease.service';
import { AWAITING_PAYMENT_TIMEOUT_MS } from '../config/payments';
import {
  LOCK_EXPIRE_REQUESTS,
  LOCK_RECONCILE_HOLDS,
  withAdvisoryLock
} from '../utils/advisoryLock';

// Long enough for a night's worth of rows, each of which is a provider round
// trip, and short enough that a wedged sweep gives the lock back before the next
// tick has piled up behind it.
const EXPIRY_LOCK_TIMEOUT_MS = 60 * 1000;
const RECONCILE_LOCK_TIMEOUT_MS = 4 * 60 * 1000;

// The safety net, not the normal path. A hold is now released the moment the
// event ends; this only catches the DJ who never closes anything. Twelve hours
// is long enough to cover a night that runs into the morning and short enough
// that a guest's card is not still blocked the following evening.
export const EXPIRATION_HOURS = 12;
export const EXPIRATION_MS = EXPIRATION_HOURS * 60 * 60 * 1000;

// A terminal row whose money is still on hold has been sitting there for at
// least this long, so nothing is half-written and no controller is mid-flight.
const RECONCILE_GRACE_MS = 2 * 60 * 1000;

// Past this, every provider has released the authorisation itself. Retrying
// would only produce errors on rows nobody can do anything about.
const RECONCILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const EXPIRABLE_FIELDS = {
  ...RELEASABLE_FIELDS,
  // Which terminal status this row is on its way to.
  status: true
} as const;

export class ExpirationService {
  private tasks: cron.ScheduledTask[] = [];

  start() {
    // Both jobs run under an advisory lock: they live in the API process, so
    // every instance schedules them, and two instances sweeping at once means
    // two calls to the provider about the same payment. See withAdvisoryLock.
    this.tasks.push(
      cron.schedule('* * * * *', async () => {
        try {
          await withAdvisoryLock(LOCK_EXPIRE_REQUESTS, EXPIRY_LOCK_TIMEOUT_MS, async () => {
            await this.expireOldRequests();
            await this.expireAbandonedDrafts();
          });
        } catch (error) {
          console.error('Error in expiration service:', error);
        }
      })
    );

    // Every five minutes rather than every minute: if a provider is down, a
    // one-minute retry is 1440 failed calls a day for the same rows.
    this.tasks.push(
      cron.schedule('*/5 * * * *', async () => {
        try {
          await withAdvisoryLock(LOCK_RECONCILE_HOLDS, RECONCILE_LOCK_TIMEOUT_MS, () =>
            this.reconcileHolds()
          );
        } catch (error) {
          console.error('Error in hold reconciliation:', error);
        }
      })
    );

    console.log('Expiration service started - expiry every minute, reconciliation every 5');
  }

  stop() {
    for (const task of this.tasks) {
      task.stop();
    }
    this.tasks = [];
  }

  private async expireOldRequests() {
    const expirationTime = new Date(Date.now() - EXPIRATION_MS);

    const candidates = await prisma.request.findMany({
      where: {
        // ACCEPTED used to never expire at all, so a DJ who accepted a song and
        // then went home left the guest's card blocked until the provider gave
        // up on its own.
        status: { in: ['PENDING', 'ACCEPTED'] },
        // Rows where money is genuinely on hold. A request whose capture failed
        // is deliberately excluded: nobody knows whether the money moved, and a
        // blind release could hand back a donation already collected.
        //
        // NOT_REQUIRED is still here even though nothing writes it any more.
        // Free requests existed for one day and the rows they left behind would
        // otherwise sit in a DJ's panel forever. The release below is a no-op on
        // one - no intent, no method - so it reaches EXPIRED with its payment
        // status untouched.
        paymentStatus: { in: ['AUTHORIZED', 'NOT_REQUIRED'] },
        // createdAt, not authorizedAt. authorizedAt is nullable and is null on
        // every row written before the invert_payment_flow migration, and in SQL
        // `NULL < cutoff` is UNKNOWN - those rows would never expire, silently,
        // on real money. The gap between the two is at most the 30 minutes a
        // draft is allowed to live, and it errs towards releasing sooner.
        createdAt: { lt: expirationTime }
      },
      select: EXPIRABLE_FIELDS
    });

    if (candidates.length === 0) return;

    console.log(`Found ${candidates.length} candidate requests to expire`);

    for (const request of candidates) {
      try {
        // Claim the row first. If the DJ moved it in the meantime the status no
        // longer matches, no row is updated, and we must not touch an
        // authorisation the queue still depends on.
        //
        // paymentStatus is deliberately not part of this write: it records where
        // the money is, and the money has not moved yet. It is set below, only
        // once a provider confirms the release - which is what leaves a failed
        // release AUTHORIZED and findable by reconcileHolds.
        const claimed = await prisma.request.updateMany({
          where: { id: request.id, status: request.status },
          data: { status: request.status === 'PENDING' ? 'EXPIRED' : 'CLOSED' }
        });

        if (claimed.count !== 1) {
          continue;
        }

        const outcome = await releaseAuthorization(request);
        await recordReleaseOutcome(request.id, outcome);

        console.log(`Expired request ${request.id} for song "${request.songTitle}"`);
      } catch (error) {
        console.error(`Failed to expire request ${request.id}:`, error);
      }
    }
  }

  // A guest who closes the tab mid-payment leaves a request nobody can confirm
  // and, if their bank did put the money on hold, a card authorisation that
  // would otherwise sit there for days.
  private async expireAbandonedDrafts() {
    const cutoff = new Date(Date.now() - AWAITING_PAYMENT_TIMEOUT_MS);

    const candidates = await prisma.request.findMany({
      where: {
        status: 'AWAITING_PAYMENT',
        createdAt: { lt: cutoff }
      },
      select: EXPIRABLE_FIELDS
    });

    for (const request of candidates) {
      try {
        // Same claim-first rule as above: the confirmation may have landed
        // between the read and the write.
        //
        // Unlike the path above, this one still writes paymentStatus up front.
        // A draft by definition never reached AUTHORIZED - that transition is
        // what turns it into a PENDING request - so there is no hold here for
        // the reconciliation sweep to recover, and nothing to keep findable.
        const claimed = await prisma.request.updateMany({
          where: { id: request.id, status: 'AWAITING_PAYMENT' },
          data: { status: 'EXPIRED', paymentStatus: 'CANCELED' }
        });

        if (claimed.count !== 1) {
          continue;
        }

        const outcome = await releaseAuthorization(request);
        if (!outcome.released) {
          console.warn(
            `Could not release the hold on discarded draft ${request.id}: ${outcome.detail}`
          );
        }
      } catch (error) {
        console.error(`Failed to discard unpaid request ${request.id}:`, error);
      }
    }
  }

  /**
   * Picks up requests that are finished but whose money is still on hold: a
   * provider that was down when the event closed, or a request authorised in
   * the seconds between an event close reading its list and flipping the rows.
   *
   * There is no claim here, which is a deliberate exception to the rule the rest
   * of this codebase follows. That rule exists because capturing twice takes the
   * money twice; releasing twice is a no-op now that releaseAuthorization is
   * idempotent, and the write is still conditional on the row holding money. A
   * claim would need an "in flight" state, which means a new enum value, which
   * means a migration.
   */
  private async reconcileHolds() {
    const now = Date.now();

    const stranded = await prisma.request.findMany({
      where: {
        paymentStatus: 'AUTHORIZED',
        // Terminal status, yet the money never came back.
        status: { in: ['REJECTED', 'EXPIRED', 'CLOSED'] },
        paymentIntentId: { not: null },
        updatedAt: { lt: new Date(now - RECONCILE_GRACE_MS) },
        createdAt: { gt: new Date(now - RECONCILE_MAX_AGE_MS) }
      },
      select: RELEASABLE_FIELDS
    });

    if (stranded.length === 0) return;

    console.log(`Reconciling ${stranded.length} authorisation(s) left on hold`);

    await releaseAll(stranded);
  }

  expiresAt(createdAt: Date): Date {
    return new Date(createdAt.getTime() + EXPIRATION_MS);
  }

  async getTimeRemaining(createdAt: Date): Promise<number> {
    return Math.max(0, this.expiresAt(createdAt).getTime() - Date.now());
  }

  async isExpired(createdAt: Date): Promise<boolean> {
    const timeRemaining = await this.getTimeRemaining(createdAt);
    return timeRemaining <= 0;
  }
}

export const expirationService = new ExpirationService();
