/**
 * Job error notifier — wrapper sobre sendAlert para errores en cron jobs.
 *
 * Uso:
 *   import { notifyJobError } from '@kmessage/telegram-alerts'
 *
 *   try {
 *     await doJobWork()
 *   } catch (err) {
 *     console.error('[MyJob] failed:', err.message)
 *     await notifyJobError('MyJob', err, { tenant: 'acme' })
 *   }
 *
 * Características:
 *   - Categoría fija 'job' (concentra alertas de jobs en un canal lógico)
 *   - Severidad default CRITICAL para fallos de jobs (raros pero importantes)
 *   - Acepta override de severidad si el caller quiere WARNING para fallos
 *     transitorios (1 retry fallido vs. 3 fallos consecutivos).
 *   - Stack trace incluido automáticamente cuando el error es un Error.
 *   - Tragará cualquier error propio de Telegram para no propagar al job
 *     (el alerter ya lo hace, pero por defensa lo envolvemos también).
 *   - Rate-limited por el alerter (300s dedup key) → no spam.
 */

import { sendAlert } from './index.js'

/**
 * @param {string} jobName        - Identificador legible (ej: 'TemplateSync', 'AutoClose')
 * @param {Error|string} error    - El error capturado. Si es Error, extrae stack.
 * @param {object} [opts]
 * @param {string} [opts.severity='CRITICAL']  - 'CRITICAL' | 'WARNING'
 * @param {string} [opts.tenant]               - Slug del tenant si el job es per-tenant
 * @param {object} [opts.metadata]             - Contexto extra (source_id, retry_count, etc.)
 * @param {string} [opts.context]              - Texto corto adicional para el mensaje
 */
export async function notifyJobError(jobName, error, opts = {}) {
  try {
    const { severity = 'CRITICAL', tenant, metadata, context } = opts
    const errMsg = error?.message || String(error || 'unknown error')
    const stack = error?.stack || undefined

    const contextSuffix = context ? ` — ${context}` : ''
    const message = `❌ ${jobName}: ${errMsg}${contextSuffix}`

    await sendAlert({
      severity,
      category: 'job',
      message,
      tenant,
      stack,
      metadata: { ...metadata, job: jobName }
    })
  } catch {
    // Alerter falló — silencio. NUNCA propagar a un cron job.
  }
}

export default { notifyJobError }
