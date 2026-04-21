import 'dotenv/config'
import http from 'http'
import path from 'path'
import cors from 'cors'
import express, { Express, ErrorRequestHandler } from 'express'
import cookieParser from 'cookie-parser'

import { authRoutes } from './api/auth/auth.routes.js'
import { userRoutes } from './api/user/user.routes.js'
import { areaMarkerRoutes } from './api/area marker/area-marker.routes.js'
import { friendRequestRoutes } from './api/friend-request/friend-request.routes.js'
import { activityFeedRoutes } from './api/activity-feed/activity-feed.routes.js'
import { activityFeedService } from './api/activity-feed/activity-feed.service.js'
import { setupSocketAPI } from './services/socket.service.js'
import { initFcm } from './services/fcm.service.js'
import { logger } from './services/logger.service.js'
import { setupAsyncLocalStorage } from './middlewares/setupAls.middleware.js'

initFcm()
const ACTIVITY_FEED_BOOTSTRAP_INITIAL_RETRY_MS = 3000
const ACTIVITY_FEED_BOOTSTRAP_MAX_RETRY_MS = 60000

void bootstrapActivityFeedIndexesWithRetry()

async function bootstrapActivityFeedIndexesWithRetry(
  attempt: number = 1
): Promise<void> {
  try {
    await activityFeedService.ensureCollectionAndIndexes()
  } catch (err) {
    const retryDelayMs = Math.min(
      ACTIVITY_FEED_BOOTSTRAP_INITIAL_RETRY_MS * Math.pow(2, attempt - 1),
      ACTIVITY_FEED_BOOTSTRAP_MAX_RETRY_MS
    )

    logger.error('Activity feed bootstrap failed; retry scheduled', {
      attempt,
      retryDelayMs
    }, err)

    setTimeout(() => {
      void bootstrapActivityFeedIndexesWithRetry(attempt + 1)
    }, retryDelayMs)
  }
}

const app: Express = express()
const server = http.createServer(app)

// Express App Config
app.use(cookieParser())
app.use(express.json())
app.use(setupAsyncLocalStorage)

// Log all incoming requests and completion status
app.use((req, res, next) => {
  const startedAt = Date.now()
  logger.info(`Incoming request ${req.method} ${req.originalUrl}`, {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip || req.socket.remoteAddress,
    userAgent: req.get('user-agent'),
    cookies: Object.keys(req.cookies ?? {}),
    hasAuthHeader: !!req.headers.authorization
  })

  let logged = false
  const logCompletion = (event: 'finish' | 'close'): void => {
    if (logged) return
    logged = true

    const durationMs = Date.now() - startedAt
    const msg = `Request ${event}: ${req.method} ${req.originalUrl} -> ${res.statusCode} (${durationMs}ms)`
    if (res.statusCode >= 500) logger.error(msg)
    else if (res.statusCode >= 400) logger.warn(msg)
    else logger.info(msg)
  }

  res.once('finish', () => logCompletion('finish'))
  res.once('close', () => {
    if (!res.writableEnded) logCompletion('close')
  })

  next()
})

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.resolve('public')))
  const corsOptions = {
    origin: '*',
    credentials: false
  }
  app.use(cors(corsOptions))
  logger.info('Production mode: CORS enabled for all origins (mobile APK)')
  logger.info('Serving static files from ./public')
} else {
  const corsOptions = {
    origin: [
      'http://94.75.193.184:3033',
      'http://127.0.0.1:3000',
      'http://localhost:3000',
      'http://127.0.0.1:5173',
      'http://localhost:5173',
      'http://splash.gleeze.com:3033'
    ],
    credentials: true
  }
  logger.info('Development mode CORS config', corsOptions)
  app.use(cors(corsOptions))
}

// routes
app.use('/api/auth', authRoutes)
app.use('/api/user', userRoutes)
app.use('/api/friend-request', friendRequestRoutes)
app.use('/api/area-marker', areaMarkerRoutes)
app.use('/api/activity-feed', activityFeedRoutes)
setupSocketAPI(server)

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, service: 'bladder-royal-back' })
})

app.get('/**', (_req, res) => {
  res.sendFile(path.resolve('public/index.html'))
})

const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  logger.error(`Unhandled Express error at ${req.method} ${req.originalUrl}`, err)
  if (res.headersSent) {
    next(err)
    return
  }
  res.status(500).send({ err: 'Internal server error' })
}
app.use(errorHandler)

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', reason)
})

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', err)
})

const port = process.env.PORT || 3030
server.listen(port, () => {
  logger.info('Server is running on port: ' + port)
})
