/**
 * In-memory rate limiter for alert deduplication
 * Prevents sending the same alert type more than once per window
 */

const sent = new Map()
let cleanupInterval = null

/**
 * Check if an alert should be sent (not rate-limited)
 * @param {string} key - Unique key (e.g. "CRITICAL:database:MySQL connection refused")
 * @param {number} windowMs - Rate limit window in ms
 * @returns {boolean}
 */
export function shouldSend(key, windowMs) {
  const now = Date.now()
  const lastSent = sent.get(key)
  if (lastSent && (now - lastSent) < windowMs) {
    return false
  }
  sent.set(key, now)
  return true
}

/**
 * Start periodic cleanup of expired entries (every 30 min)
 */
export function startCleanup(windowMs) {
  if (cleanupInterval) return
  cleanupInterval = setInterval(() => {
    const now = Date.now()
    for (const [key, timestamp] of sent) {
      if (now - timestamp > windowMs * 2) {
        sent.delete(key)
      }
    }
  }, 30 * 60 * 1000)
  cleanupInterval.unref?.()
}

export function stopCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval)
    cleanupInterval = null
  }
}
