import { Response } from 'express';
import prisma from '../utils/database';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import { stripeService } from '../services/stripe.service';
import { stripeConnectEnabled } from '../config/payments';

// Where Stripe sends the DJ back after onboarding. Built here rather than taken
// from the request: a URL the caller chooses is an open redirect, and this one
// is handed to a third party that will send a logged-in DJ to it.
function onboardingUrls() {
  const base = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

  return {
    // Stripe uses this one when the link has expired or was already spent; the
    // panel notices onboarding is still incomplete and offers a fresh link.
    refreshUrl: `${base}/dj/panel?stripe=refresh`,
    returnUrl: `${base}/dj/panel?stripe=return`
  };
}

// Stripe is the source of truth; these columns are a local copy kept fresh by
// the account.updated webhook. Writing them in one place keeps the webhook and
// the polling path from drifting apart.
async function storeAccountState(
  djId: string,
  account: { charges_enabled?: boolean; payouts_enabled?: boolean }
) {
  return prisma.dJ.update({
    where: { id: djId },
    data: {
      chargesEnabled: Boolean(account.charges_enabled),
      payoutsEnabled: Boolean(account.payouts_enabled)
    },
    select: { chargesEnabled: true, payoutsEnabled: true }
  });
}

export const getConnectStatus = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  let dj = await prisma.dJ.findUnique({
    where: { id: req.dj!.djId },
    select: { id: true, stripeAccountId: true, chargesEnabled: true, payoutsEnabled: true }
  });

  if (!dj) {
    return res.status(404).json({ error: 'DJ not found' });
  }

  // A DJ who has just finished onboarding lands back here before the webhook
  // has necessarily arrived, so an account that is not yet fully enabled is
  // re-read from Stripe. Once it is enabled there is nothing to wait for and
  // the webhook keeps it current, so the round trip is skipped.
  if (dj.stripeAccountId && !(dj.chargesEnabled && dj.payoutsEnabled)) {
    try {
      const account = await stripeService.getConnectAccount(dj.stripeAccountId);
      dj = { ...dj, ...(await storeAccountState(dj.id, account)) };
    } catch (error) {
      // Stale flags are better than a settings page that will not load.
      console.error('Could not refresh Stripe Connect account state:', error);
    }
  }

  res.json({
    // Tells the panel whether onboarding is merely available or actually
    // required before guests can pay.
    required: stripeConnectEnabled,
    accountId: dj.stripeAccountId,
    chargesEnabled: dj.chargesEnabled,
    payoutsEnabled: dj.payoutsEnabled,
    onboardingComplete: Boolean(dj.stripeAccountId && dj.chargesEnabled)
  });
});

// Both "start" and "resume": Stripe's onboarding links are single use, and a DJ
// who dropped out halfway simply asks for another one and carries on where they
// left off.
export const startConnectOnboarding = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const dj = await prisma.dJ.findUnique({
      where: { id: req.dj!.djId },
      select: { id: true, email: true, stripeAccountId: true }
    });

    if (!dj) {
      return res.status(404).json({ error: 'DJ not found' });
    }

    let accountId = dj.stripeAccountId;

    if (!accountId) {
      const account = await stripeService.createConnectAccount(dj.id, dj.email);
      accountId = account.id;

      // Saved before the link is handed out: losing the id here would strand a
      // real Stripe account with nothing pointing at it, and the next attempt
      // would create a second one.
      await prisma.dJ.update({
        where: { id: dj.id },
        data: { stripeAccountId: accountId }
      });
    }

    const { refreshUrl, returnUrl } = onboardingUrls();
    const link = await stripeService.createAccountLink(accountId, refreshUrl, returnUrl);

    res.json({ url: link.url, expiresAt: link.expires_at });
  }
);
