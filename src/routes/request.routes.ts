import express from 'express';
import { createRequest, getRequestsByEvent, getDJRequests, acceptRequest, rejectRequest } from '../controllers/request.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { subscriptionMiddleware } from '../middlewares/subscription.middleware';

const router = express.Router();

router.post('/', createRequest);
router.get('/:eventCode', getRequestsByEvent);

router.get('/dj/all', authMiddleware, subscriptionMiddleware, getDJRequests);
router.patch('/dj/:id/accept', authMiddleware, subscriptionMiddleware, acceptRequest);
router.patch('/dj/:id/reject', authMiddleware, subscriptionMiddleware, rejectRequest);

export default router;