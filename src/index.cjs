/**
 * @kuanta/alerts-client — cliente del servicio central de alertas.
 *
 * Reemplaza a `@kmessage/telegram-alerts`. **La misma firma**, para que migrar
 * sea cambiar la dependencia y el `.env`, y no tocar los ~35 lugares que
 * alertan en cada sistema.
 *
 * Lo que cambia por dentro:
 *   - No habla con Telegram. Manda un POST a msg.kuantabridge.com.
 *   - No lleva el token del bot. Lleva una API key propia, que además define
 *     con qué nombre aparece el sistema en el chat.
 *   - Si el servicio no responde, guarda en un buffer y reintenta. Antes, un
 *     fallo de red era una alerta perdida en silencio.
 *
 * Nunca lanza. Ni al inicializar mal, ni sin red, ni con el servicio caído.
 * Una alerta que tumba el proceso que intentaba reportar es peor que no tener
 * alerta.
 *
 * Escrito en CommonJS a propósito: `index.mjs` lo reexporta para ESM. Así hay
 * una sola implementación y funciona igual en KMessage (ESM) que en HelpDesk
 * (NestJS compilado a CJS), sin paso de build ni dos copias que se desincronicen.
 */

'use strict'

const os = require('os')
const fs = require('fs')
const crypto = require('crypto')

const DEFAULTS = {
  url: 'https://msg.kuantabridge.com',
  timeoutMs: 3000,
  bufferMax: 100,
  retryMs: 30000
}

const estado = {
  inicializado: false,
  habilitado: false,
  url: null,
  apiKey: null,
  source: null,
  host: os.hostname(),
  timeoutMs: DEFAULTS.timeoutMs,
  buffer: [],
  bufferMax: DEFAULTS.bufferMax,
  bufferFile: null,
  reintento: null,
  perdidasPorBuffer: 0,
  ultimoErrorRed: null
}

function log(nivel, msg) {
  const linea = `[Alertas] ${msg}`
  if (nivel === 'error') console.error(linea)
  else if (nivel === 'warn') console.warn(linea)
  else console.log(linea)
}

/**
 * Arranca el cliente. Una sola vez, al iniciar el proceso.
 *
 * @param {Object} [options]
 * @param {string} [options.source] - Solo para el log local. **El nombre real
 *   con el que se firman las alertas lo decide la API key**, en el servidor:
 *   así ya no se puede olvidar, ni firmar sin querer con el nombre de otro
 *   sistema, que fue exactamente lo que pasó antes.
 * @param {string} [options.url]    - default: ALERTS_URL o msg.kuantabridge.com
 * @param {string} [options.apiKey] - default: ALERTS_API_KEY
 */
function initTelegramAlerts(options) {
  const opts = options || {}
  estado.url = (opts.url || process.env.ALERTS_URL || DEFAULTS.url).replace(/\/+$/, '')
  estado.apiKey = opts.apiKey || process.env.ALERTS_API_KEY || null
  estado.source = opts.source || process.env.ALERTS_SOURCE || null
  estado.timeoutMs = Number(process.env.ALERTS_TIMEOUT_MS) || DEFAULTS.timeoutMs
  estado.bufferMax = Number(process.env.ALERTS_BUFFER_MAX) || DEFAULTS.bufferMax

  // Buffer en disco: sin esto, un proceso que muere con el servicio caído se
  // lleva las alertas pendientes — y el reinicio de un proceso que se está
  // cayendo es justo el momento en que más importan.
  estado.bufferFile = opts.bufferFile || process.env.ALERTS_BUFFER_FILE || null

  // Se parte de cero y se recupera del disco: reconfigurar no puede arrastrar
  // el buffer de la configuración anterior, que quizá apuntaba a otro servicio.
  estado.buffer = []

  const encendido = (process.env.ALERTS_ENABLED || process.env.TELEGRAM_ALERTS_ENABLED || '').toLowerCase() === 'true'
  estado.habilitado = encendido && !!estado.apiKey
  estado.inicializado = true

  if (estado.habilitado) {
    log('info', `Activas — ${estado.source || 'nombre según la API key'} → ${estado.url}`)
    restaurarBuffer()
    arrancarReintento()
  } else {
    log('info',
      `Desactivadas (ALERTS_ENABLED=${process.env.ALERTS_ENABLED || 'sin definir'}, ` +
      `apiKey=${estado.apiKey ? 'ok' : 'FALTA'}). Todo queda en el log local.`)
  }
  return estado.habilitado
}

/**
 * Manda una alerta. Nunca lanza y no bloquea al que la llama más que el
 * timeout: si el servicio tarda, la alerta pasa al buffer y sigue.
 *
 * @param {Object} alerta
 * @param {'CRITICAL'|'WARNING'|'INFO'|'HEARTBEAT'} [alerta.severity='WARNING']
 * @param {string} [alerta.category='internal']
 * @param {string} alerta.message
 * @param {string} [alerta.tenant]  - slug, nunca el nombre comercial ni el id
 * @param {string} [alerta.stack]
 * @param {string} [alerta.throttleKey]     - agrupa mensajes distintos del mismo problema
 * @param {number} [alerta.throttleMinutes] - ventana del freno; 0 lo apaga
 */
async function sendAlert(alerta) {
  const a = alerta || {}
  if (!a.message) return false

  // El log local sale SIEMPRE, haya o no servicio, freno o red. Cuando alguien
  // investiga un incidente, el log del propio sistema es la fuente completa;
  // el chat es solo el aviso.
  const etiqueta = `[${a.severity || 'WARNING'}][${a.category || 'internal'}]${a.tenant ? `[${a.tenant}]` : ''}`
  const texto = typeof a.message === 'string' ? a.message : textoDeError(a.message)
  if ((a.severity || '') === 'CRITICAL') log('error', `${etiqueta} ${texto}`)
  else log('warn', `${etiqueta} ${texto}`)

  if (!estado.habilitado) return false

  const payload = {
    // Identificador propio para que un reintento no publique el mensaje dos
    // veces: el servicio lo reconoce y devuelve el resultado de la primera.
    id: a.id || crypto.randomUUID(),
    severity: a.severity || 'WARNING',
    category: a.category || 'internal',
    message: texto,
    tenant: a.tenant || undefined,
    stack: a.stack || undefined,
    throttleKey: a.throttleKey || undefined,
    throttleMinutes: a.throttleMinutes,
    host: estado.host,
    timestamp: Date.now()
  }

  const ok = await enviar('/v1/alerts', payload)
  if (!ok) guardarEnBuffer(payload)
  // Se devuelve el id, no un booleano: con él se consulta después si la alerta
  // llegó de verdad al chat. Ver confirmar().
  return { id: payload.id, enviada: ok, enBuffer: !ok }
}

async function enviar(ruta, payload) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), estado.timeoutMs)
  try {
    const res = await fetch(`${estado.url}${ruta}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${estado.apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    })
    if (res.ok) {
      if (estado.ultimoErrorRed) {
        log('info', 'El servicio de alertas responde de nuevo')
        estado.ultimoErrorRed = null
      }
      return true
    }
    // 4xx que no sea 429: el servicio rechazó la alerta por cómo viene. Guardar
    // y reintentar no la va a arreglar; se avisa y se descarta.
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      const cuerpo = await res.text().catch(() => '')
      log('error', `El servicio rechazó la alerta (${res.status}): ${cuerpo.slice(0, 200)}`)
      return true
    }
    registrarFalloRed(`HTTP ${res.status}`)
    return false
  } catch (err) {
    registrarFalloRed(err.name === 'AbortError' ? `timeout (${estado.timeoutMs}ms)` : err.message)
    return false
  } finally {
    clearTimeout(timeout)
  }
}

function registrarFalloRed(motivo) {
  if (!estado.ultimoErrorRed) {
    log('warn', `Servicio de alertas inalcanzable (${motivo}). Se guardan en buffer y se reintenta.`)
  }
  estado.ultimoErrorRed = motivo
}

/**
 * Buffer local. Al llenarse se descarta lo más viejo: si lleva tanto rato
 * caído, lo de hace media hora ya no le sirve a nadie y lo reciente sí.
 */
function guardarEnBuffer(payload) {
  if (estado.buffer.length >= estado.bufferMax) {
    estado.buffer.shift()
    estado.perdidasPorBuffer++
  }
  estado.buffer.push(payload)
  persistirBuffer()
}

/**
 * Vuelca el buffer al archivo configurado. Escritura atómica: un corte a media
 * escritura no puede dejar un archivo que impida arrancar la próxima vez.
 */
function persistirBuffer() {
  if (!estado.bufferFile) return
  try {
    const tmp = `${estado.bufferFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(estado.buffer), 'utf8')
    fs.renameSync(tmp, estado.bufferFile)
  } catch (err) {
    log('warn', `No se pudo guardar el buffer en disco: ${err.message}`)
  }
}

function restaurarBuffer() {
  if (!estado.bufferFile) return
  try {
    if (!fs.existsSync(estado.bufferFile)) return
    const guardadas = JSON.parse(fs.readFileSync(estado.bufferFile, 'utf8'))
    if (!Array.isArray(guardadas) || guardadas.length === 0) return
    // Lo de hace más de un día ya no le sirve a nadie, y el id evita que se
    // dupliquen las que sí habían llegado antes del reinicio.
    const corte = Date.now() - 24 * 3600 * 1000
    estado.buffer = guardadas.filter((a) => (a.timestamp || 0) > corte)
    log('info', `${estado.buffer.length} alertas pendientes recuperadas del disco`)
    setTimeout(vaciarBuffer, 1000).unref?.()
  } catch (err) {
    log('warn', `No se pudo restaurar el buffer: ${err.message}`)
  }
}

function arrancarReintento() {
  if (estado.reintento) return
  estado.reintento = setInterval(vaciarBuffer, DEFAULTS.retryMs)
  if (estado.reintento.unref) estado.reintento.unref()
}

/** Vacía el buffer contra el endpoint de lotes. */
async function vaciarBuffer() {
  if (estado.buffer.length === 0 || !estado.habilitado) return 0
  const lote = estado.buffer.splice(0, 200)
  const ok = await enviar('/v1/alerts/batch', { alerts: lote })
  if (!ok) {
    // Vuelven al frente para no perder el orden en que ocurrieron.
    estado.buffer.unshift(...lote)
    return 0
  }
  persistirBuffer()
  if (estado.perdidasPorBuffer > 0) {
    log('warn', `${estado.perdidasPorBuffer} alertas se perdieron por buffer lleno mientras el servicio estuvo caído`)
    estado.perdidasPorBuffer = 0
  }
  return lote.length
}

/**
 * Atajo para errores de cron. Categoría fija `job` y stack incluido.
 * Nunca lanza: se puede llamar dentro del `catch` sin miedo a tumbar el job.
 */
async function notifyJobError(jobName, error, opts) {
  try {
    const o = opts || {}
    const sufijo = o.context ? ` — ${o.context}` : ''
    return await sendAlert({
      severity: o.severity || 'CRITICAL',
      category: 'job',
      message: `❌ ${jobName}: ${textoDeError(error)}${sufijo}`,
      tenant: o.tenant,
      stack: error && error.stack,
      // Si el job además muere, no salen dos alertas del mismo problema.
      throttleKey: o.throttleKey || `job:${jobName}`,
      throttleMinutes: o.throttleMinutes
    })
  } catch (err) {
    log('error', `El propio alertador falló: ${err.message}`)
    return false
  }
}

function textoDeError(err) {
  if (err instanceof Error) return err.message || String(err)
  if (typeof err === 'string') return err
  if (err === null || err === undefined) return 'error desconocido'
  try { return JSON.stringify(err) } catch { return String(err) }
}

/**
 * Cuenta los fallos por ítem de un run de cron y manda **una** alerta al final.
 *
 * Viene de HelpDesk360, donde se ganó el puesto: estos crons recorren
 * contratos, tickets o tenants, y un fallo sistémico —una columna que cambió,
 * una migración a medias— hace fallar *todos* los ítems. Una alerta por ítem
 * son cientos de mensajes por un solo problema.
 *
 * Vive en el cliente y no en el servicio porque el denominador —cuántos ítems
 * se recorrieron— solo lo sabe el job. Y ese denominador es justo el dato que
 * separa «un contrato con datos raros» de «se rompió todo».
 *
 *   const fallos = contador('ContractRenewalCron')
 *   for (const c of candidatos) {
 *     try { ... } catch (err) { fallos.add(err) }
 *   }
 *   await fallos.reportar(candidatos.length)
 */
class JobFailures {
  constructor(job) {
    this.job = job
    this.errores = []
  }

  add(err) {
    this.errores.push(textoDeError(err))
  }

  get total() {
    return this.errores.length
  }

  /** Manda la alerta si hubo fallos, y vuelve a cero. Sin fallos, no dice nada. */
  async reportar(procesados, severity) {
    if (this.errores.length === 0) return false
    const distintos = Array.from(new Set(this.errores))
    const deCuantos = procesados === undefined ? '' : ` de ${procesados}`
    const otros = distintos.length > 1 ? ` (+${distintos.length - 1} error(es) distinto(s))` : ''
    const r = await sendAlert({
      severity: severity || 'WARNING',
      category: 'job',
      message: `${this.job}: fallaron ${this.errores.length}${deCuantos} — ${distintos[0]}${otros}`,
      throttleKey: `job:${this.job}`
    })
    this.errores.length = 0
    return r
  }
}

function contador(job) {
  return new JobFailures(job)
}

/**
 * Confirma contra el servicio si una alerta llegó al chat.
 *
 * `sendAlert()` devuelve un id; con ese id se consulta acá. Devuelve el estado
 * y, si se entregó, el `message_id` de Telegram — el comprobante.
 *
 *   const { id } = await sendAlert({ severity: 'CRITICAL', message: '…' })
 *   const prueba = await confirmar(id)
 *   // { entregada: true, telegramMessageId: 4821, estado: 'entregada' }
 *
 * Un WARNING recién mandado responde `en_digest`: no se perdió, está esperando
 * el resumen.
 */
async function confirmar(id) {
  if (!estado.habilitado) return { ok: false, error: 'alertas desactivadas' }
  try {
    const res = await fetch(`${estado.url}/v1/alerts/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${estado.apiKey}` }
    })
    if (res.status === 404) return { ok: false, error: 'no encontrada' }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, ...(await res.json()) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/**
 * Resumen de entregas de este sistema. `sinEntregar` sostenido en el tiempo
 * significa que algo no está saliendo al chat.
 */
async function resumenEntregas() {
  if (!estado.habilitado) return { ok: false, error: 'alertas desactivadas' }
  try {
    const res = await fetch(`${estado.url}/v1/verify`, {
      headers: { Authorization: `Bearer ${estado.apiKey}` }
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, ...(await res.json()) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/** Alerta de prueba. Avisar antes de correrla: el chat es compartido. */
async function sendTestAlert() {
  if (!estado.habilitado) return false
  return await enviar('/v1/alerts/test', { host: estado.host })
}

/** Estado del cliente, sin salir a la red. Para endpoints de diagnóstico. */
function getAlertStatus() {
  return {
    inicializado: estado.inicializado,
    habilitado: estado.habilitado,
    url: estado.url,
    source: estado.source,
    apiKeyConfigurada: !!estado.apiKey,
    enBuffer: estado.buffer.length,
    perdidasPorBuffer: estado.perdidasPorBuffer,
    ultimoErrorRed: estado.ultimoErrorRed
  }
}

/** Confirma contra el servicio que la key sirve. Sale a la red. */
async function verificar() {
  if (!estado.apiKey) return { ok: false, error: 'sin ALERTS_API_KEY' }
  try {
    const res = await fetch(`${estado.url}/v1/status`, {
      headers: { Authorization: `Bearer ${estado.apiKey}` }
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, ...(await res.json()) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/**
 * Apagado ordenado: intenta vaciar el buffer antes de que el proceso muera.
 *
 *   process.on('SIGTERM', async () => { await shutdown(); process.exit(0) })
 */
async function shutdown() {
  if (estado.reintento) { clearInterval(estado.reintento); estado.reintento = null }
  if (estado.buffer.length > 0) {
    const n = await vaciarBuffer()
    if (estado.buffer.length > 0) {
      persistirBuffer()
      log('warn',
        `${estado.buffer.length} alertas quedan pendientes al cerrar (se enviaron ${n})` +
        (estado.bufferFile ? '. Salen en el próximo arranque.' : '. SE PIERDEN: configurá ALERTS_BUFFER_FILE.'))
    }
  }
  estado.habilitado = false
}

module.exports = {
  initTelegramAlerts,
  // Expuesto solo para las pruebas: forzar el vaciado sin esperar los 30s.
  _vaciarParaPruebas: vaciarBuffer,
  sendAlert,
  confirmar,
  resumenEntregas,
  notifyJobError,
  contador,
  JobFailures,
  sendTestAlert,
  getAlertStatus,
  verificar,
  shutdown
}
