import express from 'express';
import { getSettings, updateSettings, generateNewEventCode, endCurrentEvent, getEventStats, getEventSummaries, deleteEventSummary, changePassword, generateQRCode } from '../controllers/settings.controller';
import { authMiddleware } from '../middlewares/auth.middleware';

const router = express.Router();

router.get('/settings', authMiddleware, getSettings);
router.patch('/settings', authMiddleware, updateSettings);
router.post('/change-password', authMiddleware, changePassword);
router.post('/event/new', authMiddleware, generateNewEventCode);
router.post('/event/end', authMiddleware, endCurrentEvent);
router.get('/event/summaries', authMiddleware, getEventSummaries);
router.delete('/event/summaries/:id', authMiddleware, deleteEventSummary);
router.get('/stats', authMiddleware, getEventStats);
router.get('/qr-code', authMiddleware, generateQRCode);

export default router;