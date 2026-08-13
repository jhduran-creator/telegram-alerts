/**
 * @kmessage/telegram-alerts
 * Telegram-based monitoring and alerting for KMessage platform
 *
 * Usage:
 *   import { initTelegramAlerts, sendAlert, sendTestAlert } from '@kmessage/telegram-alerts'
 *   initTelegramAlerts({ source: 'KMessage' })
 *   sendAlert({ severity: 'CRITICAL', category: 'database', message: '...' }).catch(() => {})
 */

import { sendTelegramMessage } from './telegramClient.js'
import { shouldSend, startCleanup, stopCleanup } from './rateLimiter.js'
import { formatCritical, formatDigest, formatTest } from './formatter.js'
import { addWarning, startDigest, stopDigest, flushNow } from './digestBuffer.js'

let config = {
  enabled: false,
  token: null,
  chatId: null,
  // Sin default a propósito: `source` lo exige initTelegramAlerts(). Un default silencioso
  // haría que un sistema mal configurado firme sus alertas con el nombre de otro.
  source: null,
  rateLimitMs: 300000,    // 5 minutes
  digestIntervalMs: 900000 // 15 minutes
}

let initialized = false

/**
 * Initialize the Telegram alert service.
 *
 * @param {Object} options
 * @param {string} options.source - **OBLIGATORIO.** Nombre del sistema que emite las alertas
 *   ('KMessage', 'KAssistant', 'Avatar', 'Payroll360'…). Es lo único que identifica el origen
 *   en un chat compartido por varios sistemas.
 * @throws {Error} si falta `source`.
 */
export function initTelegramAlerts(options = {}) {
  // `source` es obligatorio y falla al arrancar, no en producción.
  // Antes caía por defecto en 'KMessage', lo que con sistemas ajenos es peor que no tener
  // etiqueta: una alerta de Payroll360 firmada "KMessage" manda a buscar el problema en el
  // sistema equivocado. Fallar acá es ruidoso pero inofensivo — es configuración, no tráfico.
  const source = typeof options.source === 'string' ? options.source.trim() : ''
  if (!source) {
    throw new Error(
      '[TelegramAlerts] Falta `source`. Usá initTelegramAlerts({ source: "NombreDeTuSistema" }). ' +
      'Es lo único que identifica de qué sistema viene cada alerta en el chat compartido.'
    )
  }

  config.token = process.env.TELEGRAM_BOT_TOKEN || null
  config.chatId = process.env.TELEGRAM_CHAT_ID || null
  config.enabled = process.env.TELEGRAM_ALERTS_ENABLED === 'true' && !!config.token && !!config.chatId
  config.source = source

  const rateLimitSec = parseInt(process.env.TELEGRAM_RATE_LIMIT_SECONDS) || 300
  config.rateLimitMs = rateLimitSec * 1000

  const digestSec = parseInt(process.env.TELEGRAM_DIGEST_INTERVAL_SECONDS) || 900
  config.digestIntervalMs = digestSec * 1000

  if (config.enabled) {
    startCleanup(config.rateLimitMs)
    startDigest(config.digestIntervalMs, async (items) => {
      try {
        const msg = formatDigest(items, config.source)
        if (msg) {
          await sendTelegramMessage(config.token, config.chatId, msg)
        }
      } catch (err) {
        // Silent fail — digest is best-effort
      }
    })
    console.log(`[TelegramAlerts] Initialized for ${config.source} (rate limit: ${rateLimitSec}s, digest: ${digestSec}s)`)
  } else {
    console.log(`[TelegramAlerts] Disabled (TELEGRAM_ALERTS_ENABLED=${process.env.TELEGRAM_ALERTS_ENABLED}, token=${config.token ? 'set' : 'missing'}, chatId=${config.chatId ? 'set' : 'missing'})`)
  }

  initialized = true
}

/**
 * Send an alert
 * @param {Object} alert
 * @param {string} alert.severity - 'CRITICAL' | 'WARNING' | 'INFO'
 * @param {string} alert.category - 'database' | 'llm' | 'meta' | 'payment' | 'email' | 'job' | 'websocket' | 'internal'
 * @param {string} alert.message - Error description
 * @param {string} [alert.tenant] - Tenant name (optional)
 * @param {string} [alert.stack] - Stack trace (optional)
 * @param {Object} [alert.metadata] - Additional context (optional)
 */
/**
 * Normaliza el mensaje de una alerta.
 *
 * Un objeto interpolado en un template literal —o pasado a `new Error()` aguas arriba— llega
 * acá como la cadena "[object Object]", y la alerta queda sin ninguna información. Pasó el
 * 2026-08-13: un CRITICAL y dos WARNING que no decían nada, y el log guardaba lo mismo.
 *
 * La causa se corrige en el origen (quien construye el error), pero este es el punto único
 * por donde pasan TODAS las alertas, así que conviene que acá tampoco se pierda nada.
 */
function normalizarMensaje(message) {
  if (typeof message === 'string') {
    if (!message.includes('[object Object]')) return message
    return `${message}  ⚠️ (un objeto se convirtió en texto en el origen; revisar quién construye este error)`
  }
  if (message instanceof Error) return message.message || String(message)
  if (message && typeof message === 'object') {
    try { return JSON.stringify(message).slice(0, 500) } catch { /* sigue abajo */ }
  }
  return String(message)
}

export async function sendAlert({ severity = 'WARNING', category = 'internal', message, tenant, stack, metadata } = {}) {
  if (!config.enabled || !initialized) return
  if (!message) return
  message = normalizarMensaje(message)

  // INFO level: never sent to Telegram
  if (severity === 'INFO') return

  // WARNING level: buffer for digest
  if (severity === 'WARNING') {
    addWarning({ category, message, tenant, source: config.source })
    return
  }

  // CRITICAL level: send immediately (with rate limiting)
  const rateKey = `${severity}:${category}:${message.substring(0, 80)}`
  if (!shouldSend(rateKey, config.rateLimitMs)) return

  try {
    const text = formatCritical({
      source: config.source,
      category,
      message,
      tenant,
      stack
    })
    await sendTelegramMessage(config.token, config.chatId, text)
  } catch (err) {
    // Silent fail — alerting should never break the app
  }
}

/**
 * Send a test alert to verify configuration
 * @returns {Promise<boolean>} true if sent successfully
 */
export async function sendTestAlert() {
  if (!config.token || !config.chatId) {
    return false
  }
  const text = formatTest(config.source)
  return await sendTelegramMessage(config.token, config.chatId, text)
}

/**
 * Get current configuration status
 */
export function getAlertStatus() {
  return {
    enabled: config.enabled,
    source: config.source,
    rateLimitSeconds: config.rateLimitMs / 1000,
    digestIntervalSeconds: config.digestIntervalMs / 1000,
    tokenConfigured: !!config.token,
    chatIdConfigured: !!config.chatId
  }
}

/**
 * Shutdown gracefully (flush pending digests)
 */
export function shutdown() {
  flushNow()
  stopDigest()
  stopCleanup()
}

export { notifyJobError } from './jobNotifier.js'

export default { initTelegramAlerts, sendAlert, sendTestAlert, getAlertStatus, shutdown }
