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

  // El `source` va en el encabezado. Antes se recibía como parámetro y NO se usaba: en un canal
  // compartido por varios sistemas, un digest sin origen es inatribuible — el 2026-08-15 llegó
  // uno con un error de PostgreSQL que ni siquiera era de KMessage (usamos MySQL) y no había
  // forma de saber de qué sistema venía. El CRITICAL sí mostraba el origen; el digest no.
  let msg = `🟡 *WARNING DIGEST* \\| ${esc(source)} \\(${items.length} alerta${items.length > 1 ? 's' : ''}\\)\n`
  msg += `━━━━━━━━━━━━━━━━━━\n`

  for (let i = 0; i < Math.min(items.length, 20); i++) {
    const item = items[i]
    const time = new Date(item.timestamp || Date.now()).toLocaleTimeString('es-CR', {
      timeZone: 'America/Costa_Rica',
      hour: '2-digit',
      minute: '2-digit'
    })
    msg += `${i + 1}\\. \\[${esc(item.category)}\\] ${esc(item.message)}`
    // Solo si difiere del encabezado: un buffer es por proceso, así que normalmente coinciden.
    if (item.source && item.source !== source) msg += ` \\| _${esc(item.source)}_`
    if (item.tenant) msg += ` \\| ${esc(item.tenant)}`
    msg += ` — _${esc(time)}_\n`
  }

  if (items.length > 20) {
    msg += `\n_\\.\\.\\.y ${items.length - 20} más_`
  }

  return msg
}

/**
 * Latido diario — señal de que el sistema y el canal de alertas siguen vivos.
 *
 * Tiene formato propio porque antes se mandaba como CRITICAL: era la única severidad que sale
 * al instante (los WARNING esperan al digest y los INFO no se envían nunca), así que se usó ese
 * canal para garantizar la entrega. El efecto era un mensaje verde de "todo bien" con el círculo
 * rojo de CRITICAL, que entrena a la gente a ignorar los rojos — justo lo contrario de lo que
 * se busca. Sigue saliendo al instante, pero ahora se ve como lo que es.
 *
 * Si dejan de llegar dos días seguidos, algo se rompió: el proceso, el token o el chat.
 */
export function formatHeartbeat({ source, message, timestamp }) {
  const time = timestamp || new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' })
  let msg = `💚 *Latido diario* \\| ${esc(source)}\n`
  msg += `━━━━━━━━━━━━━━━━━━\n`
  msg += `${esc(message)}\n`
  msg += `*Hora:* ${esc(time)}\n`
  msg += `*Host:* ${esc(os.hostname())}`
  return msg
}

/**
 * Reporte programado (20/10/2026) — un resumen que un job arma en palabras (p. ej. la fidelidad nocturna).
 *
 * Tiene formato propio por lo mismo que el latido: como WARNING caía en el digest («WARNING DIGEST | … 1.
 * [internal] …») y como CRITICAL dentro de «Error: … Tipo: … Host: …»; ninguno de los dos se entiende. El
 * reporte trae su propio título y su propio color (🟢/🟡/🔴) en la primera línea: va en negrita, el resto tal
 * cual y el sistema firma al pie.
 */
export function formatReport({ source, message }) {
  const [titulo, ...resto] = String(message).split('\n')
  let msg = `*${esc(titulo)}*`
  if (resto.length) msg += `\n${esc(resto.join('\n'))}`
  msg += `\n\n_— ${esc(source)}_`
  return msg
}

/**
 * Format a test message
 */
export function formatTest(source) {
  const time = new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' })
  return `✅ *Test* \\| ${esc(source)}\n━━━━━━━━━━━━━━━━━━\nAlerta de prueba enviada correctamente\n*Hora:* ${esc(time)}\n*Host:* ${esc(os.hostname())}`
}
