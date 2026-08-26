import express from 'express';
import {
  createEvent,
  getMyEvents,
  getNearbyEvents,
  getEventByCode,
  getPublicEventInfo,
  updateEvent,
  activateEvent,
  endEvent,
  cancelEvent,
  deleteEvent
} from '../controllers/event.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { subscriptionMiddleware } from '../middlewares/subscription.middleware';

const router = express.Router();

// Public routes
router.get('/nearby', getNearbyEvents);
router.get('/code/:eventCode', getEventByCode);
router.get('/public/:eventCode', getPublicEventInfo);

// Authenticated DJ routes
router.post('/', authMiddleware, subscriptionMiddleware, createEvent);
router.get('/my', authMiddleware, subscriptionMiddleware, getMyEvents);
router.patch('/:id', authMiddleware, subscriptionMiddleware, updateEvent);
router.patch('/:id/activate', authMiddleware, subscriptionMiddleware, activateEvent);
router.patch('/:id/end', authMiddleware, subscriptionMiddleware, endEvent);
router.patch('/:id/cancel', authMiddleware, subscriptionMiddleware, cancelEvent);
router.delete('/:id', authMiddleware, subscriptionMiddleware, deleteEvent);

export default router;
