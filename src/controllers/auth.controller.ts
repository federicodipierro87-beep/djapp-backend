import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../utils/database';
import { generateToken } from '../utils/jwt';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { subscriptionService } from '../services/subscription.service';
import { asyncHandler } from '../utils/asyncHandler';

// bcrypt only hashes the first 72 bytes, so anything past that is not a
// stronger password, just a bigger payload to move around.
const MAX_PASSWORD_LENGTH = 72;

const registerSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(6).max(MAX_PASSWORD_LENGTH),
  name: z.string().trim().min(2).max(100)
});

const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().max(MAX_PASSWORD_LENGTH)
});

const generateEventCode = (): string => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};

export const register = asyncHandler(async (req: Request, res: Response) => {
  try {
    const { email, password, name } = registerSchema.parse(req.body);
    
    const hashedPassword = await bcrypt.hash(password, 12);
    
    let eventCode: string;
    let isUnique = false;
    
    while (!isUnique) {
      eventCode = generateEventCode();
      const existing = await prisma.dJ.findUnique({
        where: { eventCode }
      });
      if (!existing) isUnique = true;
    }
    
    const dj = await prisma.dJ.create({
      data: {
        email,
        password: hashedPassword,
        name,
        eventCode: eventCode!,
        status: 'PENDING'
      }
    });

    res.status(201).json({
      message: 'Registrazione completata! In attesa di approvazione da parte dell\'amministratore.',
      dj: {
        id: dj.id,
        email: dj.email,
        name: dj.name,
        status: dj.status
      }
    });
  } catch (error) {
    throw error;
  }
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  try {
    const { email, password } = loginSchema.parse(req.body);

    const dj = await prisma.dJ.findUnique({
      where: { email }
    });

    if (!dj) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const isPasswordValid = await bcrypt.compare(password, dj.password);

    if (!isPasswordValid) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    // Check if this is an admin login
    if (dj.isAdmin) {
      const token = generateToken({
        djId: dj.id,
        email: dj.email,
        isAdmin: true
      });

      return res.json({
        message: 'Admin login successful',
        token,
        isAdmin: true,
        dj: {
          id: dj.id,
          email: dj.email,
          name: dj.name
        }
      });
    }

    // Check DJ status for regular users
    if (dj.status === 'PENDING') {
      return res.status(403).json({ error: 'Il tuo account è in attesa di approvazione dall\'amministratore.' });
    }

    if (dj.status === 'REJECTED') {
      return res.status(403).json({ error: 'Il tuo account è stato respinto dall\'amministratore.' });
    }

    const token = generateToken({
      djId: dj.id,
      email: dj.email
    });

    // Get subscription status for the DJ
    const subscriptionStatus = await subscriptionService.getSubscriptionStatus(dj.id);

    res.json({
      message: 'Login successful',
      token,
      dj: {
        id: dj.id,
        email: dj.email,
        name: dj.name,
        eventCode: dj.eventCode,
        minDonation: dj.minDonation
      },
      subscription: subscriptionStatus
    });
  } catch (error) {
    throw error;
  }
});

export const me = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    const dj = await prisma.dJ.findUnique({
      where: { id: req.dj!.djId }
    });

    if (!dj) {
      return res.status(404).json({ error: 'DJ not found' });
    }

    res.json({
      id: dj.id,
      email: dj.email,
      name: dj.name,
      eventCode: dj.eventCode,
      minDonation: dj.minDonation,
      stripeAccountId: dj.stripeAccountId,
      paypalEmail: dj.paypalEmail,
      satispayId: dj.satispayId,
      createdAt: dj.createdAt,
      updatedAt: dj.updatedAt
    });
  } catch (error) {
    throw error;
  }
});