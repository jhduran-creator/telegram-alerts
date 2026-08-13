/**
 * Message formatter for Telegram MarkdownV2
 */

import os from 'os'

// MarkdownV2 requires escaping these characters
const ESCAPE_CHARS = /([_*\[\]()~`>#+\-=|{}.!])/g

function esc(text) {
  if (!text) return ''
  return String(text).replace(ESCAPE_CHARS, '\\$1')
}

/**
 * Format a CRITICAL alert message
 */
export function formatCritical({ source, category, message, tenant, stack, timestamp }) {
  const time = timestamp || new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' })
  const host = os.hostname()

  let msg = `🔴 *CRITICAL* \\| ${esc(source)}\n`
  msg += `━━━━━━━━━━━━━━━━━━\n`
  msg += `*Error:* ${esc(message)}\n`
  msg += `*Tipo:* ${esc(category)}\n`
  if (tenant) msg += `*Tenant:* ${esc(tenant)}\n`
  msg += `*Hora:* ${esc(time)}\n`
  msg += `*Host:* ${esc(host)}\n`
  if (stack) {
    const shortStack = stack.substring(0, 200).split('\n').slice(0, 3).join('\n')
    msg += `━━━━━━━━━━━━━━━━━━\n`
    msg += `_${esc(shortStack)}_`
  }

  return msg
}

/**
 * Format a WARNING digest message
 */
export function formatDigest(items, source) {
  if (!items || items.length === 0) return null

  let msg = `🟡 *WARNING DIGEST* \\(${items.length} alerta${items.length > 1 ? 's' : ''}\\)\n`
  msg += `━━━━━━━━━━━━━━━━━━\n`

  for (let i = 0; i < Math.min(items.length, 20); i++) {
    const item = items[i]
    const time = new Date(item.timestamp || Date.now()).toLocaleTimeString('es-CR', {
      timeZone: 'America/Costa_Rica',
      hour: '2-digit',
      minute: '2-digit'
    })
    msg += `${i + 1}\\. \\[${esc(item.category)}\\] ${esc(item.message)}`
    if (item.tenant) msg += ` \\| ${esc(item.tenant)}`
    msg += ` — _${esc(time)}_\n`
  }

  if (items.length > 20) {
    msg += `\n_\\.\\.\\.y ${items.length - 20} más_`
  }

  return msg
}

/**
 * Format a test message
 */
export function formatTest(source) {
  const time = new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' })
  return `✅ *Test* \\| ${esc(source)}\n━━━━━━━━━━━━━━━━━━\nAlerta de prueba enviada correctamente\n*Hora:* ${esc(time)}\n*Host:* ${esc(os.hostname())}`
}
