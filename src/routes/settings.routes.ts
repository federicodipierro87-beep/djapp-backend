import express from 'express';
import { getSettings, updateSettings, generateNewEventCode, endCurrentEvent, getEventStats, getEventSummaries, deleteEventSummary, changePassword, generateQRCode } from '../controllers/settings.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { subscriptionMiddleware } from '../middlewares/subscription.middleware';

const router = express.Router();

router.get('/settings', authMiddleware, subscriptionMiddleware, getSettings);
router.patch('/settings', authMiddleware, subscriptionMiddleware, updateSettings);
router.post('/change-password', authMiddleware, subscriptionMiddleware, changePassword);
router.post('/event/new', authMiddleware, subscriptionMiddleware, generateNewEventCode);
router.post('/event/end', authMiddleware, subscriptionMiddleware, endCurrentEvent);
router.get('/event/summaries', authMiddleware, subscriptionMiddleware, getEventSummaries);
router.delete('/event/summaries/:id', authMiddleware, subscriptionMiddleware, deleteEventSummary);
router.get('/stats', authMiddleware, subscriptionMiddleware, getEventStats);
router.get('/qr-code', authMiddleware, subscriptionMiddleware, generateQRCode);

export default router;