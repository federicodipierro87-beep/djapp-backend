import prisma from './database';

/**
 * The background jobs run inside the API process, so every instance runs them.
 * One instance is the current shape of production, but a second one - a scale-up,
 * or the overlap of a rolling deploy - would have both copies sweeping the same
 * rows at the same time, each calling a provider about the other's payments.
 *
 * Nothing corrupts if that happens: the expiry sweep claims each row with a
 * conditional updateMany before touching money, and the reconciliation is
 * idempotent by design. What it produces is duplicated provider calls, which
 * cost rate limit and fill the logs with errors about payments that were already
 * released. This is what stops that.
 *
 * A Postgres advisory lock, because it lives on the connection rather than in a
 * row: a process killed mid-sweep releases it, where a lock table would need a
 * heartbeat and a way to decide when a holder is dead.
 *
 * Note `try`: a run that cannot get the lock is skipped, not queued. The jobs
 * are periodic, so the next tick picks up whatever was left.
 */
export async function withAdvisoryLock(
  key: number,
  timeoutMs: number,
  run: () => Promise<void>
): Promise<boolean> {
  // Taking the lock and doing the work have to sit on the same connection, or
  // the lock is released the moment the first query returns to the pool. An
  // interactive transaction is what pins them together; the xact form then
  // releases at commit, so there is nothing to unlock by hand and nothing to
  // leak if this throws.
  //
  // The work itself runs on the pooled client, not on `tx`, so this transaction
  // stays empty and holds no row locks - it is a mutex, not a unit of work.
  // Overrunning `timeoutMs` therefore only aborts the empty transaction: the
  // writes are already committed, and the caller logs the error.
  return prisma.$transaction(
    async (tx) => {
      const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${key}::bigint) AS locked
      `;

      if (!locked) return false;

      await run();
      return true;
    },
    // maxWait is short on purpose: if no connection is free, the tick is skipped
    // rather than made to queue behind live guest traffic.
    { timeout: timeoutMs, maxWait: 2000 }
  );
}

// Arbitrary but fixed: the numbers mean nothing beyond being unique to each job.
// Kept together so a future one cannot reuse a key by accident.
export const LOCK_EXPIRE_REQUESTS = 4210001;
export const LOCK_RECONCILE_HOLDS = 4210002;
