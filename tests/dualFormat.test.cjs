/**
 * Verifica que el paquete se pueda consumir en los DOS formatos.
 * Run: node tests/dualFormat.test.cjs
 *
 * Existe porque HelpDesk360 (NestJS) compila a CommonJS: un `import` estático se convierte en
 * `require()` y falla contra un paquete ESM puro. Tuvieron que resolverlo con un import dinámico
 * de su lado. Estos tests fijan que el build CJS se mantenga: si alguien agrega `import.meta` o
 * un top-level await al código fuente, el bundle deja de ser convertible y esto lo detecta.
 */

const assert = require('assert')

let passed = 0
let failed = 0
function test(desc, fn) {
  try { fn(); passed++; console.log(`  ✅ ${desc}`) }
  catch (e) { failed++; console.log(`  ❌ ${desc}\n     ${e.message}`) }
}

console.log('\n─── CommonJS (require) ───')

const cjs = require('../dist/index.cjs')

test('require() devuelve el módulo', () => {
  assert.ok(cjs, 'el require devolvió vacío')
})

const esperadas = ['initTelegramAlerts', 'sendAlert', 'sendTestAlert', 'getAlertStatus', 'shutdown', 'notifyJobError']
for (const fn of esperadas) {
  test(`expone ${fn}()`, () => {
    assert.strictEqual(typeof cjs[fn], 'function', `${fn} no es una función (es ${typeof cjs[fn]})`)
  })
}

test('source sigue siendo obligatorio en el build CJS', () => {
  assert.throws(() => cjs.initTelegramAlerts({}), /source/i,
    'el build CJS no exige source — quedó desincronizado del fuente')
})

test('initTelegramAlerts acepta un source válido', () => {
  cjs.initTelegramAlerts({ source: 'PruebaCJS' })
  assert.strictEqual(cjs.getAlertStatus().source, 'PruebaCJS')
})

test('sendAlert no lanza aunque no haya configuración', async () => {
  await cjs.sendAlert({ severity: 'CRITICAL', message: 'prueba' })
})

console.log('\n─── ESM (import dinámico) ───')

;(async () => {
  const esm = await import('../src/index.js')

  test('import() devuelve el módulo', () => assert.ok(esm))

  for (const fn of esperadas) {
    test(`expone ${fn}()`, () => {
      assert.strictEqual(typeof esm[fn], 'function', `${fn} falta en ESM`)
    })
  }

  test('ESM y CJS exponen exactamente la misma API', () => {
    const aCjs = Object.keys(cjs).filter(k => typeof cjs[k] === 'function').sort()
    const aEsm = Object.keys(esm).filter(k => typeof esm[k] === 'function').sort()
    assert.deepStrictEqual(aEsm, aCjs, `ESM: ${aEsm.join(',')} | CJS: ${aCjs.join(',')}`)
  })

  test('los dos builds se comportan igual ante un source ausente', () => {
    assert.throws(() => esm.initTelegramAlerts({}), /source/i)
  })

  console.log(`\n${'─'.repeat(46)}`)
  console.log(`  ${passed} pasaron, ${failed} fallaron`)
  process.exit(failed > 0 ? 1 : 0)
})()
