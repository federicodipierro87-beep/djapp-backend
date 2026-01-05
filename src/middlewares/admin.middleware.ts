import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth.middleware';
import prisma from '../utils/database';

export const adminRequired = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.dj) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const dj = await prisma.dJ.findUnique({
      where: { id: req.dj.djId },
      select: { isAdmin: true }
    });

    if (!dj || !dj.isAdmin) {
      return res.status(403).json({ error: 'Access denied. Admin privileges required.' });
    }

    next();
  } catch (error) {
    console.error('Admin middleware error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};