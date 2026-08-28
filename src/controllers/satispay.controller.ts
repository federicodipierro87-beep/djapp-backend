import { Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/database';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import {
  generateKeyPair,
  satispayCredentialsFor,
  satispayHost,
  satispayService
} from '../services/satispay.service';
import { encryptSecret, encryptionAvailable } from '../utils/secrets';

// Satispay has no marketplace: there is no way for the platform to take a
// payment and pass it on. A donation reaches the DJ only if it was created
// against the DJ's own business account, which is why this connects one rather
// than onboarding into ours the way Stripe Connect does.

const connectSchema = z.object({
  // The single-use activation code from the DJ's Satispay Business dashboard.
  // Format is Satispay's business, so it is only bounded, not parsed.
  activationCode: z.string().trim().min(6).max(100)
});

export const getSatispayStatus = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const dj = await prisma.dJ.findUnique({
    where: { id: req.dj!.djId },
    select: { satispayKeyId: true, satispayPrivateKey: true }
  });

  if (!dj) {
    return res.status(404).json({ error: 'DJ not found' });
  }

  res.json({
    connected: Boolean(dj.satispayKeyId && dj.satispayPrivateKey),
    // Not a secret, and the only thing a DJ can quote back to Satispay support.
    keyId: dj.satispayKeyId,
    environment: satispayHost()
  });
});

export const connectSatispay = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { activationCode } = connectSchema.parse(req.body);

  // Checked before the key is generated: activation codes are single use, so
  // spending one and then finding we cannot store the key it produced would
  // cost the DJ a trip back to their dashboard for another.
  if (!encryptionAvailable()) {
    console.error('CREDENTIALS_ENCRYPTION_KEY is missing or malformed');
    return res.status(503).json({
      error: 'Il collegamento a Satispay non è disponibile al momento'
    });
  }

  // The private key is made here and never leaves this server. The DJ sends an
  // activation code, which is worthless without a key to bind it to.
  const { publicKey, privateKey } = generateKeyPair();

  let keyId: string;
  try {
    ({ key_id: keyId } = await satispayService.activateKey(publicKey, activationCode));
  } catch (error) {
    console.error('Satispay key activation failed:', error);
    return res.status(400).json({
      error: 'Codice di attivazione non valido o già utilizzato'
    });
  }

  // Proves the pair actually signs before it is stored, so a DJ finds out here
  // rather than when a guest is standing in front of them with a phone.
  const works = await satispayService.verifyCredentials({ keyId, privateKey });

  if (!works) {
    return res.status(400).json({
      error: 'Satispay ha rifiutato la chiave appena attivata'
    });
  }

  await prisma.dJ.update({
    where: { id: req.dj!.djId },
    data: { satispayKeyId: keyId, satispayPrivateKey: encryptSecret(privateKey) }
  });

  res.json({ connected: true, keyId });
});

export const disconnectSatispay = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const dj = await prisma.dJ.findUnique({
      where: { id: req.dj!.djId },
      select: { satispayKeyId: true, satispayPrivateKey: true }
    });

    if (!dj) {
      return res.status(404).json({ error: 'DJ not found' });
    }

    // Payments already on hold can no longer be captured or released once the
    // key is gone, and a lock nobody can release sits on a guest's balance
    // until it lapses. Better to refuse than to strand somebody's money.
    const outstanding = await prisma.request.count({
      where: {
        djId: req.dj!.djId,
        paymentProvider: 'SATISPAY',
        paymentStatus: { in: ['PENDING', 'AUTHORIZED'] }
      }
    });

    if (outstanding > 0) {
      return res.status(409).json({
        error: 'Ci sono ancora pagamenti Satispay in sospeso. Riprova quando la serata è finita.'
      });
    }

    await prisma.dJ.update({
      where: { id: req.dj!.djId },
      data: { satispayKeyId: null, satispayPrivateKey: null }
    });

    res.json({ connected: false });
  }
);

// Whether a DJ can be paid with Satispay right now. Used by the public event
// endpoint to decide whether to offer the method at all, and deliberately quiet
// about why not: it is answering an unauthenticated caller.
export function canReceiveSatispay(dj: {
  satispayKeyId: string | null;
  satispayPrivateKey: string | null;
}): boolean {
  try {
    return satispayCredentialsFor(dj) !== null;
  } catch {
    return false;
  }
}
