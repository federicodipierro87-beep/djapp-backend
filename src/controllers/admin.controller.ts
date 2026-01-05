import { Request, Response } from 'express';
import prisma from '../utils/database';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';

export const getPendingDJs = async (req: AuthenticatedRequest, res: Response) => {
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
};

export const getAllDJs = async (req: AuthenticatedRequest, res: Response) => {
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
};

export const approveDJ = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { djId } = req.params;

    const updatedDJ = await prisma.dJ.update({
      where: { id: djId },
      data: { status: 'APPROVED' },
      select: {
        id: true,
        email: true,
        name: true,
        status: true
      }
    });

    res.json({ 
      message: 'DJ approvato con successo',
      dj: updatedDJ
    });
  } catch (error) {
    console.error('Error approving DJ:', error);
    res.status(500).json({ error: 'Errore nell\'approvazione del DJ' });
  }
};

export const rejectDJ = async (req: AuthenticatedRequest, res: Response) => {
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

    res.json({ 
      message: 'DJ respinto',
      dj: updatedDJ
    });
  } catch (error) {
    console.error('Error rejecting DJ:', error);
    res.status(500).json({ error: 'Errore nel respingere il DJ' });
  }
};