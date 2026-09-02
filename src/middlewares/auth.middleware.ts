import { Request, Response, NextFunction } from 'express';
import { DJStatus } from '@prisma/client';
import { verifyToken } from '../utils/jwt';
import { isTokenStale } from '../utils/passwordReset';
import prisma from '../utils/database';

export interface AuthenticatedRequest extends Request {
  dj?: {
    djId: string;
    email: string;
  };
}

export const authMiddleware = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Access token required' });
  }

  const token = authHeader.substring(7);

  try {
    const payload = verifyToken(token);

    // A JWT lasts seven days and cannot be withdrawn, so a valid signature is
    // not enough: a password reset has to be able to end the sessions that were
    // open when it happened, which is the whole point of resetting it.
    const dj = await prisma.dJ.findUnique({
      where: { id: payload.djId },
      select: { passwordChangedAt: true, status: true, isAdmin: true }
    });

    if (!dj || isTokenStale(dj.passwordChangedAt, payload.iat)) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Login already refuses a DJ who is not approved, but the token it issued
    // outlives that decision by a week. Without this, an admin rejecting a DJ
    // mid-week changes nothing until the token expires on its own.
    if (!dj.isAdmin && dj.status !== DJStatus.APPROVED) {
      return res.status(403).json({
        error:
          dj.status === DJStatus.PENDING
            ? 'Il tuo account è in attesa di approvazione dall\'amministratore.'
            : 'Il tuo account è stato respinto dall\'amministratore.',
        code: 'ACCOUNT_NOT_APPROVED'
      });
    }

    req.dj = payload;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};
