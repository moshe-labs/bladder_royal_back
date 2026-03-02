import { dbService } from '../../services/db.service.js'
import { logger } from '../../services/logger.service.js'
import mongoDB from 'mongodb'
const { ObjectId } = mongoDB
import { FriendRequest, FriendRequestToAdd, FriendRequestToUpdate } from '../../types/friend-request.types.js'
import { userService } from '../user/user.service.js'
import { sendFcmToUser } from '../../services/fcm.service.js'
import { activityFeedService } from '../activity-feed/activity-feed.service.js'
import { ActivityFeedCreateInput, ActivityFeedEventType } from '../../types/activity-feed.types.js'

export const friendRequestService = {
  add,
  getById,
  update,
  remove,
  getPendingRequests,
  getSentRequests,
  getAllRequests,
  getRequestBetweenUsers,
  getFriendsList,
  removeFromFriendsList
}

const FRIEND_REQUEST_RECEIVED_EVENT_TYPE: ActivityFeedEventType = 'friend_request_received'
const FRIEND_REQUEST_ACCEPTED_EVENT_TYPE: ActivityFeedEventType = 'friend_request_accepted'
const FRIEND_REQUEST_DECLINED_EVENT_TYPE: ActivityFeedEventType = 'friend_request_declined'

// Helper function to transform friend request from DB to API format
function transformFriendRequest(request: any): FriendRequest {
  const requestObj = request as any
  const id = requestObj._id ? requestObj._id.toString() : undefined
  return {
    ...requestObj,
    _id: id,
    id: id,
    fromUserId: requestObj.fromUserId,
    toUserId: requestObj.toUserId,
    createdAt: requestObj._id ? new ObjectId(requestObj._id).getTimestamp() : undefined,
    updatedAt: requestObj.updatedAt || requestObj.createdAt
  } as FriendRequest
}

async function add(request: FriendRequestToAdd): Promise<FriendRequest> {
  try {
    // Check if users exist
    const fromUser = await userService.getById(request.fromUserId)
    const toUser = await userService.getById(request.toUserId)

    if (!fromUser || !toUser) {
      throw new Error('One or both users not found')
    }

    // Check if users are already friends
    const fromUserFriends = fromUser.friends || []
    if (fromUserFriends.includes(request.toUserId)) {
      throw new Error('Users are already friends')
    }

    // Check if there's already a pending request
    const existingRequest = await getRequestBetweenUsers(request.fromUserId, request.toUserId)
    if (existingRequest && existingRequest.status === 'pending') {
      throw new Error('Friend request already exists')
    }

    // Don't allow self-friend requests
    if (request.fromUserId === request.toUserId) {
      throw new Error('Cannot send friend request to yourself')
    }

    const requestToAdd: Partial<FriendRequest> = {
      fromUserId: request.fromUserId,
      toUserId: request.toUserId,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date()
    }

    const collection = await dbService.getCollection('friendRequest')
    const result = await collection.insertOne(requestToAdd as any)
    const createdRequest = transformFriendRequest({ ...requestToAdd, _id: result.insertedId })
    const requestId = createdRequest._id || createdRequest.id || ''
    const senderName = getDisplayName(fromUser)
    const senderActor = toActivityActorSnapshot(fromUser)

    // Write activity row for recipient (don't fail if feed write fails)
    try {
      await activityFeedService.createForUser(request.toUserId, {
        type: FRIEND_REQUEST_RECEIVED_EVENT_TYPE,
        actor: senderActor,
        targetId: requestId,
        targetType: 'friend_request',
        title: `${senderName} sent you a friend request`,
        metadata: {
          requestId,
          fromUserId: request.fromUserId,
          toUserId: request.toUserId
        },
        dedupeKey: `${FRIEND_REQUEST_RECEIVED_EVENT_TYPE}:${requestId}`
      })
    } catch (err) {
      logger.error('Failed to write activity feed item for friend request', err)
    }

    // Send FCM notification to recipient (don't fail if FCM fails)
    try {
      await sendFcmToUser({
        userId: request.toUserId,
        title: 'New friend request',
        body: `${senderName} sent you a friend request`,
        data: {
          type: FRIEND_REQUEST_RECEIVED_EVENT_TYPE,
          fromUserId: request.fromUserId,
          requestId
        }
      })
      logger.info('FCM notification sent to user', request.toUserId)
    } catch (err) {
      logger.error('Failed to send FCM notification for friend request', err)
      // Don't throw - FCM failure shouldn't break the request creation
    }

    return createdRequest
  } catch (err) {
    logger.error('cannot add friend request', err)
    throw err
  }
}

async function getById(requestId: string): Promise<FriendRequest | null> {
  try {
    const collection = await dbService.getCollection('friendRequest')
    const request = await collection.findOne({ _id: new ObjectId(requestId) })
    if (!request) return null
    return transformFriendRequest(request)
  } catch (err) {
    logger.error(`while finding friend request by id: ${requestId}`, err)
    throw err
  }
}

async function update(request: FriendRequestToUpdate): Promise<FriendRequest> {
  try {
    const collection = await dbService.getCollection('friendRequest')
    const existingRequest = await collection.findOne({ _id: new ObjectId(request._id) })

    if (!existingRequest) {
      throw new Error('Friend request not found')
    }

    if (existingRequest.status !== 'pending') {
      throw new Error('Can only update pending requests')
    }

    const updateData: any = {
      status: request.status,
      updatedAt: new Date()
    }

    // If accepted, add to both users' friends arrays first
    if (request.status === 'accepted') {
      await addToFriendsList(existingRequest.fromUserId, existingRequest.toUserId)

      // After successfully accepting the request, write feed row and notify sender
      try {
        const toUser = await userService.getById(existingRequest.toUserId)
        const accepterName = getDisplayName(toUser)
        const accepterActor = toActivityActorSnapshot(toUser)

        await activityFeedService.createForUser(existingRequest.fromUserId, {
          type: FRIEND_REQUEST_ACCEPTED_EVENT_TYPE,
          actor: accepterActor,
          targetId: request._id,
          targetType: 'friend_request',
          title: `${accepterName} accepted your friend request`,
          metadata: {
            requestId: request._id,
            fromUserId: existingRequest.fromUserId,
            toUserId: existingRequest.toUserId
          },
          dedupeKey: `${FRIEND_REQUEST_ACCEPTED_EVENT_TYPE}:${request._id}`
        })

        await sendFcmToUser({
          userId: existingRequest.fromUserId,
          title: 'Friend Request Accepted',
          body: `${accepterName} accepted your friend request`,
          data: {
            type: FRIEND_REQUEST_ACCEPTED_EVENT_TYPE,
            requestId: request._id,
            friendId: existingRequest.toUserId
          }
        })
      } catch (err) {
        logger.error('Failed to process accepted friend request notifications', err)
      }
    }

    if (request.status === 'declined') {
      try {
        const toUser = await userService.getById(existingRequest.toUserId)
        const declinerName = getDisplayName(toUser)
        await sendFcmToUser({
          userId: existingRequest.fromUserId,
          title: 'Friend Request Declined',
          body: `${declinerName} declined your friend request`,
          data: {
            type: FRIEND_REQUEST_DECLINED_EVENT_TYPE,
            requestId: request._id,
            friendId: existingRequest.toUserId
          }
        })
      } catch (err) {
        logger.error('Failed to send FCM notification for declined friend request', err)
      }
    }

    // Delete the request after processing (accepted/declined/cancelled)
    // Friendship start date will be stored in friends list, so no need to keep requests
    await collection.deleteOne({ _id: new ObjectId(request._id) })

    // Return the request data before deletion for the response
    return transformFriendRequest({ ...existingRequest, ...updateData })
  } catch (err) {
    logger.error(`cannot update friend request ${request._id}`, err)
    throw err
  }
}

async function remove(requestId: string): Promise<void> {
  try {
    const collection = await dbService.getCollection('friendRequest')
    await collection.deleteOne({ _id: new ObjectId(requestId) })
  } catch (err) {
    logger.error(`cannot remove friend request ${requestId}`, err)
    throw err
  }
}

async function getPendingRequests(userId: string): Promise<FriendRequest[]> {
  try {
    const collection = await dbService.getCollection('friendRequest')
    const requests = await collection.find({
      toUserId: userId,
      status: 'pending'
    }).sort({ createdAt: -1 }).toArray()
    return requests.map(transformFriendRequest)
  } catch (err) {
    logger.error(`cannot get pending requests for user ${userId}`, err)
    throw err
  }
}

async function getSentRequests(userId: string): Promise<FriendRequest[]> {
  try {
    const collection = await dbService.getCollection('friendRequest')
    const requests = await collection.find({
      fromUserId: userId,
      status: 'pending'
    }).sort({ createdAt: -1 }).toArray()
    return requests.map(transformFriendRequest)
  } catch (err) {
    logger.error(`cannot get sent requests for user ${userId}`, err)
    throw err
  }
}

async function getAllRequests(userId: string): Promise<FriendRequest[]> {
  try {
    const collection = await dbService.getCollection('friendRequest')
    // Only get pending requests (accepted/declined/cancelled are deleted after processing)
    const requests = await collection.find({
      $or: [
        { fromUserId: userId },
        { toUserId: userId }
      ],
      status: 'pending'
    }).sort({ createdAt: -1 }).toArray()
    return requests.map(transformFriendRequest)
  } catch (err) {
    logger.error(`cannot get all requests for user ${userId}`, err)
    throw err
  }
}

async function getRequestBetweenUsers(userId1: string, userId2: string): Promise<FriendRequest | null> {
  try {
    const collection = await dbService.getCollection('friendRequest')
    const request = await collection.findOne({
      $or: [
        { fromUserId: userId1, toUserId: userId2 },
        { fromUserId: userId2, toUserId: userId1 }
      ]
    })
    if (!request) return null
    return transformFriendRequest(request)
  } catch (err) {
    logger.error(`cannot get request between users ${userId1} and ${userId2}`, err)
    throw err
  }
}

async function getFriendsList(userId: string): Promise<string[]> {
  try {
    const user = await userService.getById(userId)
    if (!user) return []
    return user.friends || []
  } catch (err) {
    logger.error(`cannot get friends list for user ${userId}`, err)
    throw err
  }
}

async function addToFriendsList(userId1: string, userId2: string): Promise<void> {
  try {
    // Verify both users exist first
    const [user1, user2] = await Promise.all([
      userService.getById(userId1),
      userService.getById(userId2)
    ])

    if (!user1 || !user2) {
      throw new Error('One or both users not found')
    }

    // Use atomic $addToSet operations 
    const collection = await dbService.getCollection('user')
    const id1 = new ObjectId(userId1)
    const id2 = new ObjectId(userId2)

    const [result1, result2] = await Promise.all([
      collection.updateOne(
        { _id: id1 },
        { $addToSet: { friends: userId2 } }
      ),
      collection.updateOne(
        { _id: id2 },
        { $addToSet: { friends: userId1 } }
      )
    ])

    // Verify both updates succeeded
    if (result1.matchedCount === 0 || result2.matchedCount === 0) {
      throw new Error('Failed to update one or both users')
    }
  } catch (err) {
    logger.error(`cannot add to friends list: ${userId1} and ${userId2}`, err)
    throw err
  }
}

async function removeFromFriendsList(userId1: string, userId2: string): Promise<void> {
  try {
    const collection = await dbService.getCollection('user')
    const id1 = new ObjectId(userId1)
    const id2 = new ObjectId(userId2)

    const [result1, result2] = await Promise.all([
      collection.updateOne(
        { _id: id1 },
        { $pull: { friends: userId2 } } as any
      ),
      collection.updateOne(
        { _id: id2 },
        { $pull: { friends: userId1 } } as any
      )
    ])

    if (result1.matchedCount === 0 || result2.matchedCount === 0) {
      throw new Error('Failed to remove friend from one or both users')
    }
  } catch (err) {
    logger.error(`cannot remove from friends list: ${userId1} and ${userId2}`, err)
    throw err
  }
}

function getDisplayName(user: {
  fullName?: string
  username?: string
} | null | undefined): string {
  return user?.fullName || user?.username || 'Unknown'
}

function toActivityActorSnapshot(user: {
  _id?: string
  id?: string
  username?: string
  fullName?: string
  imgUrl?: string | null
  userColor?: string
} | null | undefined): ActivityFeedCreateInput['actor'] {
  const actorId = user?._id || user?.id
  if (!actorId) return null

  const username = normalizeActorUsername(user?.username, user?.fullName)
  return {
    _id: actorId,
    id: actorId,
    username,
    fullName: user?.fullName || null,
    imgUrl: user?.imgUrl || null,
    userColor: user?.userColor || null,
    markerCount: null
  }
}

function normalizeActorUsername(username?: string, fullName?: string): string {
  const normalizedUsername = username?.trim()
  if (normalizedUsername) return normalizedUsername

  const normalizedFullName = fullName?.trim()
  if (normalizedFullName) return normalizedFullName

  return 'unknown'
}
