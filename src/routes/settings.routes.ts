import express from 'express';
import { getSettings, updateSettings, generateNewEventCode, endCurrentEvent, getEventStats, getEventSummaries, deleteEventSummary, changePassword, generateQRCode } from '../controllers/settings.controller';
import { getConnectStatus, startConnectOnboarding } from '../controllers/connect.controller';
import {
  connectSatispay,
  disconnectSatispay,
  getSatispayStatus
} from '../controllers/satispay.controller';
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

// Available whether or not STRIPE_CONNECT_ENABLED is on: DJs have to be able to
// finish onboarding before it is switched on, not after.
router.get('/connect/status', authMiddleware, subscriptionMiddleware, getConnectStatus);
router.post('/connect/onboard', authMiddleware, subscriptionMiddleware, startConnectOnboarding);

// Satispay is per-DJ rather than per-platform: these connect the DJ's own
// business account, and without one their guests are not offered the method.
router.get('/satispay/status', authMiddleware, subscriptionMiddleware, getSatispayStatus);
router.post('/satispay/connect', authMiddleware, subscriptionMiddleware, connectSatispay);
router.delete('/satispay/connect', authMiddleware, subscriptionMiddleware, disconnectSatispay);

export default router;