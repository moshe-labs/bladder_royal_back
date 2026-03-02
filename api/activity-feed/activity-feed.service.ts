import mongoDB, { Collection } from 'mongodb'
import { dbService } from '../../services/db.service.js'
import { logger } from '../../services/logger.service.js'
import {
  ACTIVITY_FEED_COLLECTION,
  ACTIVITY_FEED_EVENT_TYPES,
  ACTIVITY_FEED_TARGET_TYPES,
  ActivityFeedCreateInput,
  ActivityFeedEventType,
  ActivityFeedItem,
  ActivityFeedPage,
  GetActivityFeedPageOptions
} from '../../types/activity-feed.types.js'
import { normalizeOptionalString } from '../../utils/utils.js'

const { ObjectId } = mongoDB
const DEFAULT_FEED_LIMIT = 20
const MAX_FEED_LIMIT = 50

export const activityFeedService = {
  getCollection,
  ensureCollectionAndIndexes,
  getFeedPage,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  createForUser,
  createForUsers
}

let didEnsureActivityFeedIndexes = false

interface FeedCursorPayload {
  createdAt: string
  id: string
}

interface DecodedFeedCursor {
  createdAt: Date
  objectId: mongoDB.ObjectId
}

async function getCollection(): Promise<Collection> {
  return dbService.getCollection(ACTIVITY_FEED_COLLECTION)
}

async function ensureCollectionAndIndexes(): Promise<void> {
  if (didEnsureActivityFeedIndexes) return

  try {
    const collection = await getCollection()

    await Promise.all([
      collection.createIndex(
        { recipientUserId: 1, createdAt: -1, _id: -1 },
        { name: 'recipient_createdAt__id_desc' }
      ),
      collection.createIndex(
        { recipientUserId: 1, isRead: 1, createdAt: -1 },
        { name: 'recipient_isRead_createdAt_desc' }
      ),
      collection.createIndex(
        { recipientUserId: 1, dedupeKey: 1 },
        {
          name: 'recipient_dedupeKey_unique',
          unique: true,
          partialFilterExpression: {
            dedupeKey: { $exists: true, $type: 'string' }
          }
        }
      )
    ])

    didEnsureActivityFeedIndexes = true
    logger.info('Activity feed collection and indexes are ready')
  } catch (err) {
    logger.error('Failed to initialize activity feed collection/indexes', err)
    throw err
  }
}

async function getFeedPage(
  recipientUserId: string,
  options: GetActivityFeedPageOptions = {}
): Promise<ActivityFeedPage> {
  try {
    const normalizedRecipientUserId = normalizeRecipientUserId(recipientUserId)
    const limit = normalizeLimit(options.limit)
    const decodedCursor = decodeCursor(options.cursor)

    const query: any = { recipientUserId: normalizedRecipientUserId }
    if (decodedCursor) {
      query.$or = [
        { createdAt: { $lt: decodedCursor.createdAt } },
        { createdAt: decodedCursor.createdAt, _id: { $lt: decodedCursor.objectId } }
      ]
    }

    const collection = await getCollection()
    const docs = await collection
      .find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .toArray()

    const hasMore = docs.length > limit
    const pageDocs = hasMore ? docs.slice(0, limit) : docs
    const items = pageDocs.map(toActivityFeedItem)
    const nextCursor = hasMore ? buildNextCursor(pageDocs) : null

    return {
      items,
      hasMore,
      nextCursor
    }
  } catch (err) {
    logger.error('Failed to get activity feed page', err)
    throw err
  }
}

async function getUnreadCount(recipientUserId: string): Promise<number> {
  try {
    const normalizedRecipientUserId = normalizeRecipientUserId(recipientUserId)
    const collection = await getCollection()
    return collection.countDocuments({
      recipientUserId: normalizedRecipientUserId,
      isRead: false
    })
  } catch (err) {
    logger.error('Failed to get activity feed unread count', err)
    throw err
  }
}

async function markAsRead(
  recipientUserId: string,
  itemId: string
): Promise<void> {
  try {
    const normalizedRecipientUserId = normalizeRecipientUserId(recipientUserId)
    const normalizedItemId = normalizeFeedItemId(itemId)
    const collection = await getCollection()
    const objectId = new ObjectId(normalizedItemId)

    const result = await collection.updateOne(
      {
        _id: objectId,
        recipientUserId: normalizedRecipientUserId,
        isRead: false
      },
      {
        $set: {
          isRead: true,
          readAt: new Date()
        }
      }
    )

    if (result.matchedCount > 0) return

    const existing = await collection.findOne({
      _id: objectId,
      recipientUserId: normalizedRecipientUserId
    })
    if (existing) return

    throw new Error('Activity feed item not found')
  } catch (err) {
    logger.error('Failed to mark activity feed item as read', err)
    throw err
  }
}

async function markAllAsRead(recipientUserId: string): Promise<number> {
  try {
    const normalizedRecipientUserId = normalizeRecipientUserId(recipientUserId)
    const collection = await getCollection()

    const result = await collection.updateMany(
      {
        recipientUserId: normalizedRecipientUserId,
        isRead: false
      },
      {
        $set: {
          isRead: true,
          readAt: new Date()
        }
      }
    )

    return result.modifiedCount || 0
  } catch (err) {
    logger.error('Failed to mark all activity feed items as read', err)
    throw err
  }
}

async function createForUser(
  recipientUserId: string,
  input: ActivityFeedCreateInput
): Promise<ActivityFeedItem | null> {
  try {
    const normalizedRecipientUserId = normalizeRecipientUserId(recipientUserId)
    if (!isKnownEventType(input.type)) {
      throw new Error(`Unknown activity event type: ${input.type}`)
    }
    if (typeof input.targetType !== 'undefined' && !isKnownTargetType(input.targetType)) {
      throw new Error(`Unknown activity target type: ${input.targetType}`)
    }

    const itemToInsert = buildActivityFeedItemForInsert(
      normalizedRecipientUserId,
      input
    )
    const collection = await getCollection()

    try {
      const result = await collection.insertOne(itemToInsert as any)
      return toActivityFeedItem({
        ...itemToInsert,
        _id: result.insertedId
      })
    } catch (err: any) {
      if (isDuplicateKeyError(err) && itemToInsert.dedupeKey) {
        logger.info('Activity feed dedupe hit', {
          recipientUserId: normalizedRecipientUserId,
          dedupeKey: itemToInsert.dedupeKey,
          type: itemToInsert.type
        })

        const existing = await collection.findOne({
          recipientUserId: normalizedRecipientUserId,
          dedupeKey: itemToInsert.dedupeKey
        })
        return existing ? toActivityFeedItem(existing) : null
      }
      throw err
    }
  } catch (err) {
    logger.error('Failed to create activity feed item', err)
    throw err
  }
}

async function createForUsers(
  recipientUserIds: string[],
  input: ActivityFeedCreateInput
): Promise<ActivityFeedItem[]> {
  try {
    const uniqueRecipientIds = Array.from(
      new Set(
        recipientUserIds
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
      )
    )

    if (uniqueRecipientIds.length === 0) return []

    const items = await Promise.all(
      uniqueRecipientIds.map((recipientUserId) =>
        createForUser(recipientUserId, input)
      )
    )

    return items.filter((item): item is ActivityFeedItem => item !== null)
  } catch (err) {
    logger.error('Failed to create activity feed items for users', err)
    throw err
  }
}

function buildNextCursor(docs: any[]): string | null {
  if (docs.length === 0) return null

  const lastDoc = docs[docs.length - 1]
  const id = toObjectIdString(lastDoc._id)
  const createdAt = normalizeDate(lastDoc.createdAt, id)

  return encodeCursor({
    id,
    createdAt: createdAt.toISOString()
  })
}

function toActivityFeedItem(doc: any): ActivityFeedItem {
  const id = toObjectIdString(doc._id)

  return {
    ...(doc as ActivityFeedItem),
    _id: id,
    id,
    createdAt: normalizeDate(doc.createdAt, id),
    metadata: isPlainObject(doc.metadata) ? doc.metadata : {},
    isRead: typeof doc.isRead === 'boolean' ? doc.isRead : false,
    readAt: normalizeOptionalDate(doc.readAt)
  }
}

function normalizeRecipientUserId(recipientUserId: string): string {
  const normalized = recipientUserId?.trim()
  if (!normalized) {
    throw new Error('recipientUserId is required')
  }
  return normalized
}

function normalizeFeedItemId(itemId: string): string {
  const normalized = itemId?.trim()
  if (!normalized) {
    throw new Error('itemId is required')
  }
  if (!ObjectId.isValid(normalized)) {
    throw new Error('Invalid activity feed item id')
  }
  return normalized
}

function normalizeLimit(limit?: number): number {
  if (typeof limit !== 'number' || Number.isNaN(limit)) return DEFAULT_FEED_LIMIT
  const parsed = Math.floor(limit)
  if (parsed <= 0) return DEFAULT_FEED_LIMIT
  return Math.min(parsed, MAX_FEED_LIMIT)
}

function encodeCursor(payload: FeedCursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

function decodeCursor(cursor?: string | null): DecodedFeedCursor | null {
  if (!cursor) return null

  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64').toString('utf8')
    ) as Partial<FeedCursorPayload>

    if (typeof parsed.id !== 'string' || !ObjectId.isValid(parsed.id)) {
      throw new Error('Invalid cursor id')
    }

    if (typeof parsed.createdAt !== 'string') {
      throw new Error('Invalid cursor createdAt')
    }

    const createdAt = new Date(parsed.createdAt)
    if (Number.isNaN(createdAt.getTime())) {
      throw new Error('Invalid cursor createdAt')
    }

    return {
      createdAt,
      objectId: new ObjectId(parsed.id)
    }
  } catch (err) {
    logger.warn('Invalid activity feed cursor provided', err)
    throw new Error('Invalid cursor')
  }
}

function normalizeDate(value: unknown, idFallback: string): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value

  if (typeof value === 'string') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }

  if (ObjectId.isValid(idFallback)) {
    return new ObjectId(idFallback).getTimestamp()
  }

  return new Date(0)
}

function normalizeOptionalDate(value: unknown): Date | null | undefined {
  if (typeof value === 'undefined') return undefined
  if (value === null) return null

  if (value instanceof Date && !Number.isNaN(value.getTime())) return value

  if (typeof value === 'string') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }

  return null
}

function toObjectIdString(idValue: unknown): string {
  if (typeof idValue === 'string' && ObjectId.isValid(idValue)) return idValue
  if (idValue instanceof ObjectId) return idValue.toString()
  throw new Error('Invalid activity feed item _id')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isKnownEventType(type: string): boolean {
  return (ACTIVITY_FEED_EVENT_TYPES as readonly string[]).includes(type)
}

function isKnownTargetType(type: string): boolean {
  return (ACTIVITY_FEED_TARGET_TYPES as readonly string[]).includes(type)
}

function isDuplicateKeyError(err: any): boolean {
  return err?.code === 11000 || String(err?.message || '').includes('E11000')
}

function buildActivityFeedItemForInsert(
  recipientUserId: string,
  input: ActivityFeedCreateInput
): Omit<ActivityFeedItem, '_id' | 'id'> {
  const actor = normalizeActorSnapshot(input.actor)
  const renderedText = renderTitleAndBody({
    type: input.type,
    actor,
    title: input.title,
    body: input.body
  })
  const dedupeKey = normalizeOptionalString(input.dedupeKey)
  const targetId = normalizeOptionalString(input.targetId)

  return {
    recipientUserId,
    type: input.type,
    createdAt:
      input.createdAt instanceof Date && !Number.isNaN(input.createdAt.getTime())
        ? input.createdAt
        : new Date(),
    actor,
    targetId: targetId || null,
    targetType: input.targetType,
    title: renderedText.title,
    body: renderedText.body,
    metadata: isPlainObject(input.metadata) ? input.metadata : {},
    isRead: typeof input.isRead === 'boolean' ? input.isRead : false,
    readAt: normalizeOptionalDate(input.readAt),
    dedupeKey
  }
}

function normalizeActorSnapshot(actor: ActivityFeedCreateInput['actor']) {
  if (!actor) return null

  const actorId = normalizeOptionalString(actor.id || actor._id)
  const username = normalizeOptionalString(actor.username)

  if (!actorId || !username) {
    throw new Error('actor must include id/_id and username when provided')
  }

  return {
    _id: actorId,
    id: actorId,
    username,
    fullName: normalizeOptionalString(actor.fullName) || null,
    imgUrl: normalizeOptionalString(actor.imgUrl) || null,
    userColor: normalizeOptionalString(actor.userColor) || null,
    markerCount:
      typeof actor.markerCount === 'number' && Number.isFinite(actor.markerCount)
        ? actor.markerCount
        : null
  }
}

function renderTitleAndBody(input: {
  type: ActivityFeedEventType
  actor: ActivityFeedItem['actor']
  title?: string
  body?: string | null
}): { title: string, body: string | null } {
  const explicitTitle = normalizeOptionalString(input.title)
  const explicitBody = normalizeOptionalString(input.body)

  if (explicitTitle) {
    return { title: explicitTitle, body: explicitBody || null }
  }

  const actorName = input.actor?.fullName || input.actor?.username || 'Someone'

  switch (input.type) {
    case 'friend_request_received':
      return { title: `${actorName} sent you a friend request`, body: null }
    case 'friend_request_accepted':
      return { title: `${actorName} accepted your friend request`, body: null }
    case 'friend_request_declined':
      return { title: `${actorName} declined your friend request`, body: null }
    case 'friend_removed':
      return { title: `${actorName} removed you from friends`, body: null }
    case 'new_conquest':
      return { title: `${actorName} conquered a new territory`, body: null }
    case 'territory_taken':
      return { title: `${actorName} took one of your territories`, body: null }
    case 'activity_feed_update':
      return { title: 'You have new activity', body: null }
    case 'test':
      return { title: 'Test activity event', body: null }
    default:
      return { title: 'You have new activity', body: null }
  }
}
