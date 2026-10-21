/**
 * El reporte programado (REPORT, 20/10/2026): sale como se escribió, sin envoltorio.
 * Run: node --test tests/formatReport.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { formatReport, formatDigest } from '../src/formatter.js'

test('formatReport: título en negrita, el resto tal cual (escapado) y la firma al pie', () => {
  const m = formatReport({ source: 'KAssistant', message: '🟡 Fidelidad · Los Nacientes · 19/10\n9 de 10 están en su material. 1 no.\n  https://kmessage.net/ai/x' })
  assert.equal(m, '*🟡 Fidelidad · Los Nacientes · 19/10*\n9 de 10 están en su material\\. 1 no\\.\n  https://kmessage\\.net/ai/x\n\n_— KAssistant_')
  assert.doesNotMatch(m, /WARNING|CRITICAL|Tipo:|Host:|\[internal\]/)
})

test('formatReport: un mensaje de una sola línea', () => {
  assert.equal(formatReport({ source: 'K', message: 'Todo (bien)' }), '*Todo \\(bien\\)*\n\n_— K_')
})

test('el digest de WARNING no cambia', () => {
  assert.match(formatDigest([{ category: 'internal', message: 'x', timestamp: 0 }], 'K'), /^🟡 \*WARNING DIGEST\* \\\| K \\\(1 alerta\\\)/)
})
