/**
 * El cliente contra un doble del servicio. Lo que se prueba es lo que el
 * requisito exige: que una alerta no se pierda aunque el servicio no responda.
 */

const { test, describe, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const cliente = require('../src/index.cjs')

let servidor
let recibidas = []
let lotes = []
let caido = false
let base

const BUFFER_FILE = path.join(__dirname, '.tmp-buffer.json')

before(async () => {
  servidor = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (caido) { res.writeHead(503); return res.end('{}') }
      const payload = JSON.parse(body || '{}')
      if (req.url === '/v1/alerts/batch') {
        lotes.push(payload)
        recibidas.push(...payload.alerts)
        res.writeHead(202, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ recibidas: payload.alerts.length }))
      }
      recibidas.push(payload)
      res.writeHead(202, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: payload.id, accion: 'encolada' }))
    })
  })
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${servidor.address().port}`
})

after(async () => {
  await cliente.shutdown()
  await new Promise((r) => servidor.close(r))
  fs.rmSync(BUFFER_FILE, { force: true })
})

beforeEach(() => {
  recibidas = []
  lotes = []
  caido = false
  fs.rmSync(BUFFER_FILE, { force: true })
  process.env.ALERTS_ENABLED = 'true'
  cliente.initTelegramAlerts({ url: base, apiKey: 'llave-de-prueba', source: 'Prueba', bufferFile: BUFFER_FILE })
})

describe('envío normal', () => {
  test('manda la alerta y devuelve un id para verificarla', async () => {
    const r = await cliente.sendAlert({ severity: 'CRITICAL', category: 'db', message: 'no responde' })
    assert.equal(r.enviada, true)
    assert.ok(r.id, 'sin id no se puede confirmar la entrega después')
    assert.equal(recibidas.length, 1)
    assert.equal(recibidas[0].message, 'no responde')
    assert.ok(recibidas[0].host, 'el host viaja para que la alerta diga dónde pasó')
  })

  test('sin message no manda nada', async () => {
    assert.equal(await cliente.sendAlert({ severity: 'CRITICAL' }), false)
    assert.equal(recibidas.length, 0)
  })

  test('nunca lanza, ni con basura', async () => {
    await cliente.sendAlert(null)
    await cliente.sendAlert({ message: { objeto: 'raro' } })
    assert.ok(true, 'llegó hasta acá sin lanzar')
  })
})

describe('con el servicio caído', () => {
  test('la alerta va al buffer, no se pierde', async () => {
    caido = true
    const r = await cliente.sendAlert({ severity: 'CRITICAL', category: 'x', message: 'con el servicio caído' })
    assert.equal(r.enviada, false)
    assert.equal(r.enBuffer, true)
    assert.equal(cliente.getAlertStatus().enBuffer, 1)
  })

  test('el buffer queda en disco para sobrevivir a un reinicio', async () => {
    caido = true
    await cliente.sendAlert({ severity: 'CRITICAL', category: 'x', message: 'sobrevive al reinicio' })

    assert.ok(fs.existsSync(BUFFER_FILE), 'tiene que haberse escrito el archivo')
    const guardado = JSON.parse(fs.readFileSync(BUFFER_FILE, 'utf8'))
    assert.equal(guardado.length, 1)
    assert.equal(guardado[0].message, 'sobrevive al reinicio')

    // Se simula el reinicio del proceso: init vuelve a leer el disco.
    caido = false
    cliente.initTelegramAlerts({ url: base, apiKey: 'llave-de-prueba', source: 'Prueba', bufferFile: BUFFER_FILE })
    assert.equal(cliente.getAlertStatus().enBuffer, 1, 'tiene que recuperarla del disco')
  })

  test('al volver el servicio, lo pendiente sale en un lote', async () => {
    caido = true
    await cliente.sendAlert({ severity: 'CRITICAL', category: 'x', message: 'pendiente 1' })
    await cliente.sendAlert({ severity: 'WARNING', category: 'x', message: 'pendiente 2' })
    assert.equal(cliente.getAlertStatus().enBuffer, 2)

    caido = false
    await cliente._vaciarParaPruebas()

    assert.equal(cliente.getAlertStatus().enBuffer, 0, 'el buffer tiene que quedar vacío')
    assert.equal(lotes.length, 1, 'sale en un solo lote, no una petición por alerta')
    assert.deepEqual(recibidas.map((a) => a.message), ['pendiente 1', 'pendiente 2'])
  })

  test('el orden se conserva si el lote también falla', async () => {
    caido = true
    await cliente.sendAlert({ severity: 'WARNING', category: 'x', message: 'primera' })
    await cliente.sendAlert({ severity: 'WARNING', category: 'x', message: 'segunda' })
    await cliente._vaciarParaPruebas()
    assert.equal(cliente.getAlertStatus().enBuffer, 2, 'vuelven al buffer')

    caido = false
    await cliente._vaciarParaPruebas()
    assert.deepEqual(recibidas.map((a) => a.message), ['primera', 'segunda'])
  })
})

describe('idempotencia', () => {
  test('cada alerta lleva su id, y uno propio se respeta', async () => {
    await cliente.sendAlert({ severity: 'WARNING', category: 'x', message: 'a' })
    assert.ok(recibidas[0].id, 'el id es lo que evita duplicar en un reintento')

    await cliente.sendAlert({ id: 'mi-propio-id', severity: 'WARNING', category: 'x', message: 'b' })
    assert.equal(recibidas[1].id, 'mi-propio-id')
  })
})

describe('contador de fallos por run', () => {
  test('una alerta por run, con el denominador', async () => {
    const fallos = cliente.contador('SyncPlanillas')
    fallos.add(new Error('columna inexistente'))
    fallos.add(new Error('columna inexistente'))
    fallos.add(new Error('otro problema'))
    assert.equal(fallos.total, 3)

    await fallos.reportar(47)

    assert.equal(recibidas.length, 1, 'tres fallos, un solo mensaje')
    const m = recibidas[0].message
    assert.ok(m.includes('fallaron 3 de 47'), 'el denominador separa "datos raros" de "se rompió todo"')
    assert.ok(m.includes('+1 error'))
    assert.equal(recibidas[0].throttleKey, 'job:SyncPlanillas')
  })

  test('un run sin fallos no dice nada', async () => {
    await cliente.contador('SyncPlanillas').reportar(47)
    assert.equal(recibidas.length, 0, 'el canal es para lo que está roto')
  })
})

describe('notifyJobError', () => {
  test('categoría job, stack incluido y freno por nombre de job', async () => {
    await cliente.notifyJobError('TemplateSync', new Error('timeout de la API'), { context: 'segundo intento' })
    assert.equal(recibidas[0].category, 'job')
    assert.equal(recibidas[0].severity, 'CRITICAL')
    assert.ok(recibidas[0].message.includes('TemplateSync'))
    assert.ok(recibidas[0].message.includes('segundo intento'))
    assert.ok(recibidas[0].stack)
    assert.equal(recibidas[0].throttleKey, 'job:TemplateSync')
  })

  test('no lanza aunque le pasen cualquier cosa', async () => {
    await cliente.notifyJobError('Job', { error: 'objeto suelto' })
    assert.ok(recibidas[0].message.includes('objeto suelto'), 'no puede quedar en [object Object]')
  })
})

describe('desactivado', () => {
  test('sin API key no manda pero tampoco estorba', async () => {
    cliente.initTelegramAlerts({ url: base, apiKey: null, source: 'Prueba' })
    const r = await cliente.sendAlert({ severity: 'CRITICAL', message: 'x' })
    assert.equal(r, false)
    assert.equal(recibidas.length, 0)
    assert.equal(cliente.getAlertStatus().habilitado, false)
  })
})
