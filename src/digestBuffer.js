/**
 * Buffer for WARNING-level alerts
 * Accumulates warnings and flushes as a digest at regular intervals
 */

const MAX_BUFFER_SIZE = 50
let buffer = []
let flushInterval = null
let flushCallback = null

/**
 * Add a warning to the buffer
 */
export function addWarning(item) {
  if (buffer.length >= MAX_BUFFER_SIZE) return
  buffer.push({ ...item, timestamp: Date.now() })
}

/**
 * Start the digest flush interval
 * @param {number} intervalMs - Flush interval in ms
 * @param {Function} callback - Called with array of buffered items on flush
 */
export function startDigest(intervalMs, callback) {
  flushCallback = callback
  if (flushInterval) return

  flushInterval = setInterval(() => {
    if (buffer.length > 0 && flushCallback) {
      const items = [...buffer]
      buffer = []
      flushCallback(items)
    }
  }, intervalMs)
  flushInterval.unref?.()
}

export function stopDigest() {
  if (flushInterval) {
    clearInterval(flushInterval)
    flushInterval = null
  }
}

/**
 * Flush immediately (for shutdown)
 */
export function flushNow() {
  if (buffer.length > 0 && flushCallback) {
    const items = [...buffer]
    buffer = []
    flushCallback(items)
  }
}
