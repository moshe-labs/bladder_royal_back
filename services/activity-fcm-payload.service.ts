import { ActivityFeedEventType, ActivityFeedTargetType } from '../types/activity-feed.types.js'
import { normalizeOptionalString } from '../utils/utils.js'

export interface BuildActivityFcmDataInput {
  type: ActivityFeedEventType
  targetType?: ActivityFeedTargetType
  targetId?: string
  feedItemId?: string
  extraData?: Record<string, string | undefined>
}

export function buildActivityFcmData(
  input: BuildActivityFcmDataInput
): Record<string, string> {
  const data: Record<string, string> = { type: input.type }

  const targetType = normalizeOptionalString(input.targetType)
  if (targetType) data.targetType = targetType

  const targetId = normalizeOptionalString(input.targetId)
  if (targetId) data.targetId = targetId

  const feedItemId = normalizeOptionalString(input.feedItemId)
  if (feedItemId) data.feedItemId = feedItemId

  if (input.extraData) {
    for (const [key, value] of Object.entries(input.extraData)) {
      const normalizedValue = normalizeOptionalString(value)
      if (normalizedValue) data[key] = normalizedValue
    }
  }

  return data
}
