import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../utils/database';
import { generateToken } from '../utils/jwt';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { subscriptionService } from '../services/subscription.service';
import { asyncHandler } from '../utils/asyncHandler';
import { EmailService } from '../services/email.service';
import { disconnectDJSockets } from '../socket/socket';
import {
  generateResetToken,
  hashResetToken,
  isResetTokenExpired
} from '../utils/passwordReset';

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

export const forgotPasswordSchema = z.object({
  email: z.string().trim().email().max(254)
});

export const resetPasswordSchema = z.object({
  // 32 random bytes in hex. Checking the shape here keeps anything that is not
  // a token of ours from ever reaching the database lookup.
  token: z.string().regex(/^[a-f0-9]{64}$/),
  password: z.string().min(6).max(MAX_PASSWORD_LENGTH)
});

const generateEventCode = (): string => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};

export const register = asyncHandler(async (req: Request, res: Response) => {
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
});

export const login = asyncHandler(async (req: Request, res: Response) => {
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
});

// The one answer /forgot-password ever gives. It has to read as plausible for
// an address that is not registered, because that is half of what it is for.
const FORGOT_PASSWORD_MESSAGE =
  'Se esiste un account con questa email, ti abbiamo inviato le istruzioni per reimpostare la password.';

const INVALID_RESET_TOKEN =
  'Il link non è più valido. Richiedine uno nuovo dalla pagina di accesso.';

export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  const { email } = forgotPasswordSchema.parse(req.body);

  // Answer before doing any of the work. Saying the same thing either way is
  // pointless if a registered address takes a database write and a call to
  // Resend longer to answer than an unregistered one: the secret would just
  // move from the wording into the timing.
  res.json({ message: FORGOT_PASSWORD_MESSAGE });

  try {
    const dj = await prisma.dJ.findUnique({ where: { email } });

    // A PENDING or REJECTED DJ cannot log in even with the right password, so a
    // reset link would lead them nowhere. Admins are exempt from the status.
    if (!dj || (!dj.isAdmin && dj.status !== 'APPROVED')) return;

    const { token, tokenHash, expiresAt } = generateResetToken();

    await prisma.dJ.update({
      where: { id: dj.id },
      data: {
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: expiresAt
      }
    });

    await EmailService.sendPasswordResetEmail(
      dj.email,
      dj.name,
      `${process.env.FRONTEND_URL}/dj/reset-password/${token}`
    );
  } catch (error) {
    // The response is already out, so there is nobody left to tell.
    console.error('Error handling password reset request:', error);
  }
});

export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  const { token, password } = resetPasswordSchema.parse(req.body);

  // The column holds the hash, so the token from the link is hashed and looked
  // up. A stolen copy of the table contains no usable links.
  const dj = await prisma.dJ.findUnique({
    where: { passwordResetTokenHash: hashResetToken(token) }
  });

  if (!dj || isResetTokenExpired(dj.passwordResetExpiresAt)) {
    return res.status(400).json({ error: INVALID_RESET_TOKEN });
  }

  const hashedPassword = await bcrypt.hash(password, 12);

  await prisma.dJ.update({
    where: { id: dj.id },
    data: {
      password: hashedPassword,
      // Burnt: the link works once.
      passwordResetTokenHash: null,
      passwordResetExpiresAt: null,
      // Every JWT already handed out for this DJ stops being accepted here.
      passwordChangedAt: new Date()
    }
  });

  // The tokens are dead but the sockets opened with them are still connected,
  // and only the handshake ever checks anything.
  disconnectDJSockets(dj.id);

  res.json({ message: 'Password aggiornata. Ora puoi accedere con la nuova password.' });
});

export const me = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
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
    createdAt: dj.createdAt,
    updatedAt: dj.updatedAt
  });
});