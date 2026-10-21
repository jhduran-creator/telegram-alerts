/**
 * Ningún formato pasa el límite de Telegram (19/10/2026: un digest de KAssistant de más de 4096 caracteres fue
 * rechazado entero, «message is too long», y sus alertas no llegaron).
 * Run: node --test tests/limite.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { formatCritical, formatDigest, formatReport, LIMITE } from '../src/formatter.js'

// Texto con caracteres que MarkdownV2 escapa: el escape duplica el largo.
const largo = (n) => 'a.b_c(d)'.repeat(Math.ceil(n / 8)).slice(0, n)
// Un «\» al final, o uno que no escapa nada, también lo rechaza Telegram.
const escapeSano = (m) => !/(^|[^\\])(\\\\)*\\$/.test(m) && !/\\[^_*[\]()~`>#+\-=|{}.!\\]/.test(m)

test('digest: 50 alertas de 1000 caracteres quedan debajo del límite y cuenta las que no entraron', () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ category: 'internal', message: largo(1000), timestamp: i }))
  const m = formatDigest(items, 'KAssistant')
  assert.ok(m.length <= LIMITE, `${m.length} > ${LIMITE}`)
  assert.ok(escapeSano(m))
  const lineas = (m.match(/^\d+\\\. /gm) || []).length
  assert.ok(lineas >= 1 && lineas < 20)
  assert.match(m, new RegExp(`y ${50 - lineas} más_$`))
  assert.match(m, /\(50 alertas\\\)/)
})

test('digest: pocas alertas cortas salen todas, sin «más»', () => {
  const m = formatDigest([{ category: 'a', message: 'uno', timestamp: 0 }, { category: 'b', message: 'dos', timestamp: 0 }], 'K')
  assert.match(m, /1\\\. \\\[a\\\] uno/)
  assert.match(m, /2\\\. \\\[b\\\] dos/)
  assert.doesNotMatch(m, /más_/)
})

test('critical: un mensaje enorme se recorta', () => {
  const m = formatCritical({ source: 'K', category: 'db', message: largo(20000), stack: largo(5000) })
  assert.ok(m.length <= LIMITE, `${m.length} > ${LIMITE}`)
  assert.ok(escapeSano(m))
})

test('report: un reporte larguísimo entra por líneas enteras, avisa lo que falta y conserva la firma', () => {
  const lineas = Array.from({ length: 200 }, (_, i) => `Cliente: «pregunta ${i}» ${largo(80)}`)
  const m = formatReport({ source: 'KAssistant', message: ['🟡 Fidelidad · X', ...lineas].join('\n') })
  assert.ok(m.length <= LIMITE, `${m.length} > ${LIMITE}`)
  assert.ok(escapeSano(m))
  assert.match(m, /^\*🟡 Fidelidad · X\*\n/)
  assert.match(m, /línea\\\(s\\\) más_\n\n_— KAssistant_$/)
})

test('report: uno normal no cambia', () => {
  assert.equal(formatReport({ source: 'K', message: 'Todo (bien)\nok.' }), '*Todo \\(bien\\)*\nok\\.\n\n_— K_')
})
