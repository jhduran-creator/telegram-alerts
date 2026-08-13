# @kmessage/telegram-alerts

Alertas por Telegram para los sistemas de Kuanta Bridge. Un solo canal, varios sistemas, cada uno identificado por su nombre.

```bash
npm install git+https://github.com/jhduran-creator/telegram-alerts.git
```

ESM y CommonJS · sin dependencias en runtime · Node 18+

---

Cómo conectar un sistema Node al canal de alertas que ya usan KMessage, KAssistant y Avatar.

**Un solo chat para todo.** Cada sistema se identifica con su propio nombre, así que al leer una alerta se sabe de inmediato quién avisa y dónde mirar.

---

## Qué hace por vos

No es un `sendMessage` a Telegram. El paquete resuelve cuatro cosas que, hechas a mano, terminan mal:

- **Separa lo urgente de lo acumulable.** Un `CRITICAL` sale al instante; los `WARNING` se juntan y salen en un resumen cada 15 minutos, para no inundar el chat.
- **Evita la alerta repetida.** El mismo error no vuelve a mandarse durante 5 minutos. Sin esto, un fallo en un bucle publica cientos de mensajes y el canal se vuelve inútil justo cuando lo necesitás.
- **Formatea igual para todos**, con hora de Costa Rica y el host que la emitió.
- **Nunca rompe tu aplicación.** Si Telegram falla, o falta configuración, la llamada no lanza excepción: sigue de largo en silencio.

---

## 1. Instalar

El paquete no tiene dependencias externas — solo módulos nativos de Node. Funciona en Node 18 o superior, con ESM (`"type": "module"`).

```bash
npm install git+https://github.com/jhduran-creator/telegram-alerts.git
```

Funciona en **ESM y en CommonJS**. En un proyecto NestJS o en cualquier código que compile a CJS, el `require()` resuelve el build de `dist/` y los ejemplos de esta guía funcionan tal cual, sin import dinámico.

> **No copies la carpeta a mano.** En unos meses cada sistema tendría una versión distinta y las alertas dejarían de verse iguales.

---

## 2. Variables de entorno

Las cuatro primeras son las que importan. Las dos últimas solo si querés ajustar los tiempos.

| Variable | ¿Obligatoria? | Ejemplo | Para qué |
|---|---|---|---|
| `TELEGRAM_ALERTS_ENABLED` | **sí** | `true` | Interruptor general. Con cualquier otro valor, el paquete queda inerte |
| `TELEGRAM_BOT_TOKEN` | **sí** | `8123456789:AAF…` | Token del bot de alertas. **Se entrega por canal privado; no está en este repositorio** |
| `TELEGRAM_CHAT_ID` | **sí** | `-4012345678` | El chat de alertas. Si es un **grupo** normal su id NO empieza con `-100`: ese prefijo corresponde a supergrupos y canales. Verificalo con `getChat` si tenés dudas |
| `TELEGRAM_RATE_LIMIT_SECONDS` | no | `300` | Cuánto se silencia un error repetido. Default: 300 (5 min) |
| `TELEGRAM_DIGEST_INTERVAL_SECONDS` | no | `900` | Cada cuánto sale el resumen de WARNING. Default: 900 (15 min) |

Ejemplo de `.env`:

```env
TELEGRAM_ALERTS_ENABLED=true
TELEGRAM_BOT_TOKEN=<pedir por canal privado>
TELEGRAM_CHAT_ID=<pedir por canal privado>
# Opcionales
TELEGRAM_RATE_LIMIT_SECONDS=300
TELEGRAM_DIGEST_INTERVAL_SECONDS=900
```

> **El token es una credencial.** Va en el `.env` del servidor y ese `.env` no se versiona: no lo subas a un repositorio, ni lo pegues en un README, un ticket o un chat de equipo. Si se filtra hay que rotarlo, y rotarlo obliga a actualizar todos los sistemas conectados al canal.

---

## 3. Inicializar — una sola vez, al arrancar

```js
import { initTelegramAlerts } from '@kmessage/telegram-alerts'

initTelegramAlerts({ source: 'Payroll360' })
```

**`source` es obligatorio.** Si falta, la inicialización lanza un error y tu aplicación no arranca:

```
[TelegramAlerts] Falta `source`. Usá initTelegramAlerts({ source: "NombreDeTuSistema" }).
```

Es a propósito, y falla al arrancar en vez de en producción. Es el nombre que aparece en cada alerta y **lo único que dice de qué sistema vino**: en un chat compartido, una alerta sin origen —o peor, con el origen equivocado— manda a buscar el problema al lugar equivocado.

Poné el nombre real del sistema — `Payroll360`, `Finance360`, `HelpDesk360` — tal como lo llamarías al hablar con alguien.

Al arrancar vas a ver en el log:

```
[TelegramAlerts] Initialized for Payroll360 (rate limit: 300s, digest: 900s)
```

Si no aparece esa línea, falta alguna de las tres variables obligatorias y **no se va a enviar nada**.

Al terminar el proceso, conviene vaciar lo que quedó pendiente:

```js
process.on('SIGTERM', () => { shutdown(); process.exit(0) })
```

---

## 4. Mandar una alerta

```js
import { sendAlert } from '@kmessage/telegram-alerts'

await sendAlert({
  severity: 'CRITICAL',
  category: 'payments',
  message: 'La pasarela rechazó 12 cobros seguidos con error 502',
  tenant: 'Cliente ACME',           // opcional
  stack: error.stack                 // opcional, solo para CRITICAL
})
```

### Severidad

| Valor | Qué hace | Cuándo usarlo |
|---|---|---|
| `CRITICAL` | Sale **al instante** | Algo está roto y alguien tiene que actuar ahora |
| `WARNING` | Se acumula y sale en el resumen | Algo anda mal pero puede esperar 15 minutos |
| `INFO` | **No se envía nunca** | Existe para no tener que sacar la llamada del código |

La pregunta para elegir: *¿justifica interrumpir a alguien ahora mismo?* Si la respuesta es no, es `WARNING`. Un canal donde todo es crítico se termina silenciando, y ese es el peor resultado posible.

### Categoría

Texto libre y corto, aparece como "Tipo" en la alerta. Los que ya se usan: `payments`, `meta`, `broker`, `job`, `internal`, `database`. Si ninguno encaja, poné el tuyo — mejor uno propio que forzar el ajeno.

---

## 5. Errores dentro de un cron o un job

Hay un atajo pensado para eso, que además guarda el stack:

```js
import { notifyJobError } from '@kmessage/telegram-alerts'

try {
  await sincronizarPlanillas()
} catch (error) {
  await notifyJobError('SincronizarPlanillas', error, {
    severity: 'WARNING',
    context: 'segundo intento del día'
  })
}
```

Nunca lanza excepción, así que podés llamarlo dentro del `catch` de un cron sin miedo a tumbar el job.

---

## 6. El error que más se comete

**Nunca pases un objeto donde va texto.**

```js
// ✗ MAL — la alerta va a decir "[object Object]" y no vas a saber qué pasó
sendAlert({ message: `Falló el envío: ${err}` })
sendAlert({ message: respuestaDeLaApi.error })

// ✓ BIEN
sendAlert({ message: `Falló el envío: ${err.message}` })
sendAlert({ message: typeof e === 'string' ? e : JSON.stringify(e) })
```

Esto no es teórico: el 2026-08-13 llegó una alerta CRITICAL que decía exactamente `Broker send falló: [object Object]`, y **el error real se perdió para siempre** — no estaba en el log, ni en la base, ni en ningún lado. Hubo que reconstruir el problema a partir de datos sueltos y aun así quedó sin causa determinada.

El caso típico: una API externa que devuelve el error como objeto y alguien hace `new Error(data.error)`. Si el valor viene de afuera, **normalizalo antes**.

El paquete intenta defenderse y serializa lo que puede, pero si el objeto se convirtió en texto antes de llegar, ya no hay nada que recuperar.

---

## 7. Verificar que quedó bien

```js
import { getAlertStatus, sendTestAlert } from '@kmessage/telegram-alerts'

console.log(getAlertStatus())
// { enabled: true, source: 'Payroll360', rateLimitSeconds: 300,
//   digestIntervalSeconds: 900, tokenConfigured: true, chatIdConfigured: true }

await sendTestAlert()   // manda un mensaje de prueba al chat
```

**Avisá antes de correr la prueba**, para que nadie confunda tu mensaje con un incidente real.

---

## 8. Cuando algo no llega

| Síntoma | Causa más probable |
|---|---|
| No aparece la línea `[TelegramAlerts] Initialized` | Falta alguna de las tres variables obligatorias |
| `enabled: false` en `getAlertStatus()` | `TELEGRAM_ALERTS_ENABLED` no es exactamente `true` |
| Un `WARNING` no llegó | Es normal: está esperando el resumen, hasta 15 minutos |
| Un `CRITICAL` repetido no llega | Rate limiting: el mismo mensaje se silencia 5 minutos |
| Un `INFO` no llega | Por diseño: los `INFO` no se envían nunca |
| La app no arranca: *"Falta `source`"* | Es esperado — pasá `source` a `initTelegramAlerts()` |
| La alerta dice `[object Object]` | Ver la sección 6 |

---

## 9. Qué vas a ver en el chat

Un CRITICAL:

```
🔴 CRITICAL | Payroll360
━━━━━━━━━━━━━━━━━━
Error: La pasarela rechazó 12 cobros seguidos con error 502
Tipo: payments
Tenant: Cliente ACME
Hora: 13/8/2026, 11:03:24 a. m.
Host: payroll-prod-01
```

Y el resumen de WARNING:

```
🟡 WARNING DIGEST (2 alertas)
━━━━━━━━━━━━━━━━━━
1. [payments] Reintento de cobro nº3 | Cliente ACME — 11:03 a. m.
2. [internal] Caché de tipos de cambio vencida — 11:07 a. m.
```

---

## 10. Dos cosas que conviene saber de antemano

**Cada sistema lleva su propio contador.** El rate limiting y el resumen son por proceso, no compartidos. Si un incidente afecta a varios sistemas a la vez, vas a recibir una alerta de cada uno — y hasta un resumen por sistema cada 15 minutos. No es un error: es el precio de que cada uno sea autónomo. Si el chat se vuelve ruidoso, se escalonan los intervalos con `TELEGRAM_DIGEST_INTERVAL_SECONDS`.

**Cada sistema habla directo con Telegram**, sin pasar por KMessage. Es a propósito: si las alertas viajaran por KMessage, el día que KMessage se caiga te quedarías sin alertas justo cuando más las necesitás.

---

## Resumen para copiar y pegar

```js
// 1. al arrancar
import { initTelegramAlerts, shutdown } from '@kmessage/telegram-alerts'
initTelegramAlerts({ source: 'NombreDeTuSistema' })
process.on('SIGTERM', () => { shutdown(); process.exit(0) })

// 2. donde falle algo
import { sendAlert, notifyJobError } from '@kmessage/telegram-alerts'

await sendAlert({
  severity: 'CRITICAL',
  category: 'payments',
  message: `Descripción concreta: ${error.message}`,
  tenant: nombreDelCliente
})

await notifyJobError('NombreDelJob', error)
```

```env
TELEGRAM_ALERTS_ENABLED=true
TELEGRAM_BOT_TOKEN=<pedir por canal privado>
TELEGRAM_CHAT_ID=<pedir por canal privado>
```

**Mantiene:** Kuanta Bridge Group.


---

## Desarrollo

El código fuente es ESM (`src/`). El build de CommonJS (`dist/index.cjs`) **se versiona a propósito**: quien instala desde git no ejecuta ningún build, así que si el `dist` no viaja en el repositorio, un `require()` no encuentra nada.

```bash
npm install     # instala esbuild (solo para desarrollo)
npm run build   # regenera dist/index.cjs  ← obligatorio tras tocar src/
npm test        # verifica que ESM y CJS expongan la misma API
```

Los tests comprueban que ambos formatos carguen y se comporten igual. Si alguien modifica `src/` y olvida reconstruir, el test lo detecta.
