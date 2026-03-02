import express, { Router } from 'express'
import { requireAuth } from '../../middlewares/requireAuth.middleware.js'
import {
  getActivityFeed,
  getActivityFeedUnreadCount,
  markActivityFeedItemRead,
  markAllActivityFeedRead
} from './activity-feed.controller.js'

const router: Router = express.Router()

router.use(requireAuth)

router.get('/', getActivityFeed)
router.get('/unread-count', getActivityFeedUnreadCount)
router.put('/:id/read', markActivityFeedItemRead)
router.post('/read-all', markAllActivityFeedRead)

export const activityFeedRoutes = router
