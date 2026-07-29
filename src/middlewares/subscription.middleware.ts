import { Response, NextFunction } from 'express';
import prisma from '../utils/database';
import { AuthenticatedRequest } from './auth.middleware';

export const subscriptionMiddleware = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const djId = req.dj?.djId;

    if (!djId) {
      return res.status(401).json({ error: 'Non autenticato' });
    }

    const dj = await prisma.dJ.findUnique({
      where: { id: djId },
      include: { subscription: true }
    });

    if (!dj) {
      return res.status(404).json({ error: 'DJ non trovato' });
    }

    // Admin users bypass subscription check
    if (dj.isAdmin) {
      return next();
    }

    // Check if DJ has an active subscription
    if (!dj.subscription) {
      return res.status(403).json({
        error: 'Abbonamento richiesto',
        code: 'SUBSCRIPTION_REQUIRED',
        requiresSubscription: true
      });
    }

    const activeStatuses = ['TRIALING', 'ACTIVE', 'PAST_DUE'];
    if (!activeStatuses.includes(dj.subscription.status)) {
      return res.status(403).json({
        error: 'Il tuo abbonamento non è attivo',
        code: 'SUBSCRIPTION_INACTIVE',
        status: dj.subscription.status,
        requiresSubscription: true
      });
    }

    next();
  } catch (error) {
    console.error('Subscription middleware error:', error);
    return res.status(500).json({ error: 'Errore interno del server' });
  }
};
