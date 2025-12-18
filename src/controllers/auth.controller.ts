import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../utils/database';
import { generateToken } from '../utils/jwt';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(2)
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string()
});

const generateEventCode = (): string => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};

export const register = async (req: Request, res: Response) => {
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
        eventCode: eventCode!
      }
    });

    const token = generateToken({
      djId: dj.id,
      email: dj.email
    });

    res.status(201).json({
      message: 'DJ registered successfully',
      token,
      dj: {
        id: dj.id,
        email: dj.email,
        name: dj.name,
        eventCode: dj.eventCode,
        minDonation: dj.minDonation
      }
    });
  } catch (error) {
    throw error;
  }
};

export const login = async (req: Request, res: Response) => {
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

    const token = generateToken({
      djId: dj.id,
      email: dj.email
    });

    res.json({
      message: 'Login successful',
      token,
      dj: {
        id: dj.id,
        email: dj.email,
        name: dj.name,
        eventCode: dj.eventCode,
        minDonation: dj.minDonation
      }
    });
  } catch (error) {
    throw error;
  }
};

export const me = async (req: AuthenticatedRequest, res: Response) => {
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
};