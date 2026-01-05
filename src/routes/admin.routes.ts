import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import { adminRequired } from '../middlewares/admin.middleware';
import { getPendingDJs, getAllDJs, approveDJ, rejectDJ, deleteDJ } from '../controllers/admin.controller';

const router = Router();

// All admin routes require authentication and admin privileges
router.use(authMiddleware);
router.use(adminRequired);

// Get pending DJ registrations
router.get('/djs/pending', getPendingDJs);

// Get all DJs
router.get('/djs', getAllDJs);

// Approve a DJ
router.patch('/djs/:djId/approve', approveDJ);

// Reject a DJ
router.patch('/djs/:djId/reject', rejectDJ);

// Delete a DJ
router.delete('/djs/:djId', deleteDJ);

export default router;