import { Request, Response } from 'express';
import prisma from '../utils/database';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { EmailService } from '../services/email.service';
import { subscriptionService } from '../services/subscription.service';
import { asyncHandler } from '../utils/asyncHandler';

export const getPendingDJs = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    const pendingDJs = await prisma.dJ.findMany({
      where: {
        status: 'PENDING',
        isAdmin: false
      },
      select: {
        id: true,
        email: true,
        name: true,
        status: true,
        createdAt: true
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    res.json(pendingDJs);
  } catch (error) {
    console.error('Error fetching pending DJs:', error);
    res.status(500).json({ error: 'Errore nel recupero delle richieste' });
  }
});

export const getAllDJs = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    const allDJs = await prisma.dJ.findMany({
      where: {
        isAdmin: false
      },
      select: {
        id: true,
        email: true,
        name: true,
        status: true,
        eventCode: true,
        createdAt: true
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    res.json(allDJs);
  } catch (error) {
    console.error('Error fetching all DJs:', error);
    res.status(500).json({ error: 'Errore nel recupero dei DJ' });
  }
});

export const approveDJ = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { djId } = req.params;

    const updatedDJ = await prisma.dJ.update({
      where: { id: djId },
      data: { status: 'APPROVED' },
      select: {
        id: true,
        email: true,
        name: true,
        status: true,
        stripeCustomerId: true
      }
    });

    // Create Stripe customer for the DJ if not already created
    if (!updatedDJ.stripeCustomerId) {
      try {
        await subscriptionService.createCustomer(updatedDJ.id, updatedDJ.email, updatedDJ.name);
      } catch (stripeError) {
        console.error('Error creating Stripe customer:', stripeError);
        // Don't fail the approval if Stripe customer creation fails
      }
    }

    // Send approval email
    try {
      await EmailService.sendDJApprovalEmail(updatedDJ.email, updatedDJ.name);
    } catch (emailError) {
      console.error('Error sending approval email:', emailError);
      // Don't fail the approval if email fails
    }

    res.json({
      message: 'DJ approvato con successo',
      dj: updatedDJ
    });
  } catch (error) {
    console.error('Error approving DJ:', error);
    res.status(500).json({ error: 'Errore nell\'approvazione del DJ' });
  }
});

export const rejectDJ = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { djId } = req.params;

    const updatedDJ = await prisma.dJ.update({
      where: { id: djId },
      data: { status: 'REJECTED' },
      select: {
        id: true,
        email: true,
        name: true,
        status: true
      }
    });

    // Send rejection email
    try {
      await EmailService.sendDJRejectionEmail(updatedDJ.email, updatedDJ.name);
    } catch (emailError) {
      console.error('Error sending rejection email:', emailError);
      // Don't fail the rejection if email fails
    }

    res.json({ 
      message: 'DJ respinto',
      dj: updatedDJ
    });
  } catch (error) {
    console.error('Error rejecting DJ:', error);
    res.status(500).json({ error: 'Errore nel respingere il DJ' });
  }
});

export const deleteDJ = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { djId } = req.params;

    // First, get DJ info for the response
    const djToDelete = await prisma.dJ.findUnique({
      where: { id: djId },
      select: {
        id: true,
        email: true,
        name: true,
        isAdmin: true
      }
    });

    if (!djToDelete) {
      return res.status(404).json({ error: 'DJ non trovato' });
    }

    // Prevent deletion of admin users
    if (djToDelete.isAdmin) {
      return res.status(400).json({ error: 'Non puoi cancellare un account admin' });
    }

    // Delete all related data in correct order (due to foreign key constraints)
    await prisma.$transaction(async (tx) => {
      // Delete queue items first
      await tx.queueItem.deleteMany({
        where: { djId }
      });

      // Delete event summaries
      await tx.eventSummary.deleteMany({
        where: { djId }
      });

      // Delete requests
      await tx.request.deleteMany({
        where: { djId }
      });

      // Finally delete the DJ
      await tx.dJ.delete({
        where: { id: djId }
      });
    });

    res.json({ 
      message: 'DJ cancellato con successo',
      deletedDJ: {
        id: djToDelete.id,
        email: djToDelete.email,
        name: djToDelete.name
      }
    });
  } catch (error) {
    console.error('Error deleting DJ:', error);
    res.status(500).json({ error: 'Errore nella cancellazione del DJ' });
  }
});