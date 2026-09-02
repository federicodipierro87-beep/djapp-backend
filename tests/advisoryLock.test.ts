import { beforeEach, describe, expect, it, vi } from 'vitest';

// The background sweeps live inside the API process, so a second instance - a
// scale-up, or the overlap of a rolling deploy - runs them too. Nothing corrupts
// if both run: the expiry claims each row before touching money and the
// reconciliation is idempotent. What it produces is two calls to Stripe about
// the same payment, the second of which comes back as an error about a hold
// that was already released.

const transaction = vi.fn();
const queryRaw = vi.fn();

vi.mock('../src/utils/database', () => ({
  default: {
    $transaction: (...args: unknown[]) => transaction(...args)
  }
}));

const { withAdvisoryLock, LOCK_EXPIRE_REQUESTS, LOCK_RECONCILE_HOLDS } = await import(
  '../src/utils/advisoryLock'
);

// Stands in for the interactive transaction: hands the callback a client whose
// $queryRaw answers whatever the test has decided about the lock.
const runTransaction = async (fn: any) => fn({ $queryRaw: queryRaw });

beforeEach(() => {
  vi.clearAllMocks();
  transaction.mockImplementation(runTransaction);
  queryRaw.mockResolvedValue([{ locked: true }]);
});

describe('withAdvisoryLock', () => {
  it('runs the work when it holds the lock', async () => {
    const work = vi.fn(async () => undefined);

    await expect(withAdvisoryLock(LOCK_EXPIRE_REQUESTS, 1000, work)).resolves.toBe(true);
    expect(work).toHaveBeenCalledOnce();
  });

  // Skipped, not queued. The jobs are periodic, so whatever the other instance
  // does not finish is picked up on the next tick rather than piling up behind
  // a lock nobody is watching.
  it('skips the work when another process holds the lock', async () => {
    queryRaw.mockResolvedValue([{ locked: false }]);
    const work = vi.fn(async () => undefined);

    await expect(withAdvisoryLock(LOCK_EXPIRE_REQUESTS, 1000, work)).resolves.toBe(false);
    expect(work).not.toHaveBeenCalled();
  });

  // Taking the lock and doing the work have to sit on the same connection, or
  // the lock is handed back to the pool the moment the first query returns and
  // guards nothing at all.
  it('takes the lock on the transaction client, not the pool', async () => {
    await withAdvisoryLock(LOCK_EXPIRE_REQUESTS, 1000, async () => undefined);

    expect(transaction).toHaveBeenCalledOnce();
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(queryRaw.mock.calls[0][1]).toBe(LOCK_EXPIRE_REQUESTS);
  });

  // xact, so a process killed mid-sweep gives the lock back when its connection
  // dies. A session lock would need an explicit unlock that never runs, and the
  // job would then be wedged until the database was restarted.
  it('uses the transaction-scoped lock, which releases itself', async () => {
    await withAdvisoryLock(LOCK_RECONCILE_HOLDS, 1000, async () => undefined);

    expect(queryRaw.mock.calls[0][0].join('')).toContain('pg_try_advisory_xact_lock');
  });

  it('gives each job its own key', () => {
    expect(LOCK_EXPIRE_REQUESTS).not.toBe(LOCK_RECONCILE_HOLDS);
  });

  // The work runs on the pooled client, so this transaction stays empty and
  // holds no row locks - it is a mutex, not a unit of work. Without an explicit
  // timeout it would inherit Prisma's five seconds and abort halfway through a
  // night's worth of provider round trips.
  it('carries the timeout it was given', async () => {
    await withAdvisoryLock(LOCK_RECONCILE_HOLDS, 240000, async () => undefined);

    expect(transaction.mock.calls[0][1]).toMatchObject({ timeout: 240000 });
  });
});
