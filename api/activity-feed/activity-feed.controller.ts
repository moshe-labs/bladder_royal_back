import { Request, Response } from 'express'
import { activityFeedService } from './activity-feed.service.js'
import { logger } from '../../services/logger.service.js'

export async function getActivityFeed(req: Request, res: Response): Promise<void> {
  try {
    const loggedinUser = req.loggedinUser
    if (!loggedinUser || !loggedinUser._id) {
      logger.warn('Get activity feed rejected: not authenticated')
      res.status(401).send({ err: 'Not authenticated' })
      return
    }

    const cursorParam = Array.isArray(req.query.cursor)
      ? req.query.cursor[0]
      : req.query.cursor
    const cursor = typeof cursorParam === 'string' && cursorParam.trim()
      ? cursorParam.trim()
      : undefined

    const limitParam = Array.isArray(req.query.limit)
      ? req.query.limit[0]
      : req.query.limit
    const limit = typeof limitParam === 'string' ? Number(limitParam) : undefined

    const [page, unreadCount] = await Promise.all([
      activityFeedService.getFeedPage(loggedinUser._id, {
        cursor,
        limit
      }),
      activityFeedService.getUnreadCount(loggedinUser._id)
    ])

    res.status(200).send({
      items: page.items,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      unreadCount
    })
  } catch (err: any) {
    logger.error('Failed to get activity feed', err)
    res.status(400).send({ err: err?.message || 'Failed to get activity feed' })
  }
}

export async function getActivityFeedUnreadCount(req: Request, res: Response): Promise<void> {
  try {
    const loggedinUser = req.loggedinUser
    if (!loggedinUser || !loggedinUser._id) {
      logger.warn('Get activity feed unread count rejected: not authenticated')
      res.status(401).send({ err: 'Not authenticated' })
      return
    }

    const unreadCount = await activityFeedService.getUnreadCount(loggedinUser._id)
    res.status(200).send({ unreadCount })
  } catch (err: any) {
    logger.error('Failed to get activity feed unread count', err)
    res.status(400).send({
      err: err?.message || 'Failed to get activity feed unread count'
    })
  }
}

export async function markActivityFeedItemRead(req: Request, res: Response): Promise<void> {
  try {
    const loggedinUser = req.loggedinUser
    if (!loggedinUser || !loggedinUser._id) {
      logger.warn('Mark activity feed item as read rejected: not authenticated')
      res.status(401).send({ err: 'Not authenticated' })
      return
    }

    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
    await activityFeedService.markAsRead(loggedinUser._id, idParam)
    const unreadCount = await activityFeedService.getUnreadCount(loggedinUser._id)

    res.status(200).send({
      ok: true,
      unreadCount
    })
  } catch (err: any) {
    logger.error('Failed to mark activity feed item as read', err)
    res.status(400).send({
      err: err?.message || 'Failed to mark activity feed item as read'
    })
  }
}

export async function markAllActivityFeedRead(req: Request, res: Response): Promise<void> {
  try {
    const loggedinUser = req.loggedinUser
    if (!loggedinUser || !loggedinUser._id) {
      logger.warn('Mark all activity feed items as read rejected: not authenticated')
      res.status(401).send({ err: 'Not authenticated' })
      return
    }

    const updatedCount = await activityFeedService.markAllAsRead(loggedinUser._id)
    const unreadCount = await activityFeedService.getUnreadCount(loggedinUser._id)

    res.status(200).send({
      ok: true,
      updatedCount,
      unreadCount
    })
  } catch (err: any) {
    logger.error('Failed to mark all activity feed items as read', err)
    res.status(400).send({
      err: err?.message || 'Failed to mark all activity feed items as read'
    })
  }
}
