import express from 'express';
import { getSettings, updateSettings, generateNewEventCode, endCurrentEvent, getEventStats, getEventSummaries, deleteEventSummary } from '../controllers/settings.controller';
import { authMiddleware } from '../middlewares/auth.middleware';

const router = express.Router();

router.get('/settings', authMiddleware, getSettings);
router.patch('/settings', authMiddleware, updateSettings);
router.post('/event/new', authMiddleware, generateNewEventCode);
router.post('/event/end', authMiddleware, endCurrentEvent);
router.get('/event/summaries', authMiddleware, getEventSummaries);
router.delete('/event/summaries/:id', authMiddleware, deleteEventSummary);
router.get('/stats', authMiddleware, getEventStats);

export default router;