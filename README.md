# Cliente de alertas — Kuanta Bridge

Manda alertas al servicio central **`msg.kuantabridge.com`**, que las publica en
el canal de Telegram del equipo.

> **Este repo cambió de contenido en la v2.**
> Hasta la v1.1.0 contenía `@kmessage/telegram-alerts`, un paquete que hablaba
> directo con Telegram y del que cada proyecto llevaba su copia. Ahora contiene
> el **cliente** del servicio central.
>
> Si todavía no migraste, anclá la versión vieja y seguí trabajando:
>
> ```json
> "@kmessage/telegram-alerts": "git+https://github.com/jhduran-creator/telegram-alerts.git#v1.1.0"
> ```

---

## Por qué el cambio

Había tres copias del paquete en tres proyectos y ya habían divergido entre sí.
Con un servicio central:

- **El token del bot desaparece de tu `.env`.** Vive en un solo servidor.
- **Ninguna alerta se pierde si Telegram falla.** El servicio reintenta hasta
  24 horas, y el cliente guarda en un buffer local mientras tanto. Antes, un
  fallo de red era una alerta perdida en silencio.
- **Se puede demostrar que una alerta llegó**, con el `message_id` de Telegram.
- **Un solo resumen de WARNING** para todos los sistemas, en vez de uno por
  proceso con su propio reloj.
- **La sanitización aplica a todos**: correos, teléfonos, UUIDs y credenciales
  se enmascaran antes de salir al chat.

---

## Node

```bash
npm install git+https://github.com/jhduran-creator/telegram-alerts.git
```

```env
ALERTS_ENABLED=true
ALERTS_URL=https://msg.kuantabridge.com
ALERTS_API_KEY=ka_tusistema_...     # pedísela a Julio
ALERTS_BUFFER_FILE=/var/lib/tusistema/alertas-pendientes.json
```

`ALERTS_BUFFER_FILE` es opcional pero conviene: sin él, un proceso que muere
mientras el servicio está caído se lleva las alertas pendientes — y ese es
justo el momento en que más importan.

```js
import { initTelegramAlerts, sendAlert, notifyJobError, contador, shutdown } from '@kuanta/alerts-client'

initTelegramAlerts()
process.on('SIGTERM', async () => { await shutdown(); process.exit(0) })

// Algo roto que exige actuar ahora
await sendAlert({
  severity: 'CRITICAL',
  category: 'payments',
  message: `La pasarela devolvió ${res.status}`,
  tenant: empresa.slug
})

// El catch que se traga el run entero de un cron
try {
  await sincronizar()
} catch (err) {
  await notifyJobError('Sincronizar', err, { context: 'segundo intento' })
}

// El catch de adentro de un BUCLE — acá no va notifyJobError
const fallos = contador('RenovarContratos')
for (const c of candidatos) {
  try { await renovar(c) } catch (err) { fallos.add(err) }
}
await fallos.reportar(candidatos.length)
// → "RenovarContratos: fallaron 3 de 47 — columna inexistente"
```

Ese denominador es lo que separa «un contrato con datos raros» de «se rompió
todo». Sin el contador, un fallo sistémico manda una alerta por ítem.

Funciona igual con `require()` (NestJS, CommonJS) que con `import`.

### Comprobar que llegó

```js
const { id } = await sendAlert({ severity: 'CRITICAL', message: 'algo grave' })
const prueba = await confirmar(id)
// { entregada: true, telegramMessageId: 4821, estado: 'entregada' }
```

Un `WARNING` recién mandado responde `en_digest`: no se perdió, espera el
resumen.

---

## Python

```bash
pip install "git+https://github.com/jhduran-creator/telegram-alerts.git#subdirectory=python"
```

Mismas variables de entorno.

```python
from kuanta_alerts import init_alerts, send_alert, notify_job_error, contador

init_alerts()

send_alert("La alarma de CloudWatch entró en ALARM", severity="CRITICAL", category="aws")

try:
    sincronizar()
except Exception as err:
    notify_job_error("Sincronizar", err)
```

Solo biblioteca estándar: no agrega dependencias a nada.

---

## Sin instalar nada — `curl`

Para un script de backup, una unidad de systemd o un servicio en otro lenguaje:

```bash
curl -sS -X POST https://msg.kuantabridge.com/v1/alerts \
  -H "Authorization: Bearer $ALERTS_API_KEY" \
  -H "Content-Type: application/json" \
  --max-time 5 \
  -d '{"severity":"CRITICAL","category":"backup","message":"El respaldo falló","throttleKey":"backup:postgres"}' || true
```

El `|| true` importa: que el aviso falle no puede tumbar el script que
intentaba avisar.

---

## Severidades

| Valor | Qué hace | Cuándo |
|---|---|---|
| `CRITICAL` | Sale al instante | Algo está roto y alguien tiene que actuar ahora |
| `WARNING` | Se acumula en el resumen de 15 min | Anda mal pero puede esperar |
| `INFO` | Nunca sale al chat | Para no borrar la llamada del código |
| `HEARTBEAT` | Sale al instante, formato propio | El latido de "sigo vivo" |

La pregunta para elegir: *¿justifica interrumpir a alguien ahora mismo?* Si no,
es `WARNING`. Un canal donde todo es crítico se termina silenciando.

---

## El error que más se comete

**Nunca pases un objeto donde va texto.**

```js
sendAlert({ message: `Falló: ${err}` })          // ✗ "[object Object]"
sendAlert({ message: `Falló: ${err.message}` })  // ✓
```

No es teórico: el 2026-08-13 llegó un CRITICAL que decía exactamente
`Broker send falló: [object Object]`, y el error real se perdió para siempre.

---

## Migrar desde `@kmessage/telegram-alerts`

La firma es la misma; cambia la dependencia, el import y el `.env`.

```diff
- "@kmessage/telegram-alerts": "git+https://github.com/jhduran-creator/telegram-alerts.git",
+ "@kuanta/alerts-client": "git+https://github.com/jhduran-creator/telegram-alerts.git",
```

```diff
- from '@kmessage/telegram-alerts'
+ from '@kuanta/alerts-client'
```

```diff
- TELEGRAM_ALERTS_ENABLED=true
- TELEGRAM_BOT_TOKEN=8123456789:AAF...
- TELEGRAM_CHAT_ID=-1001234567890
+ ALERTS_ENABLED=true
+ ALERTS_URL=https://msg.kuantabridge.com
+ ALERTS_API_KEY=ka_tusistema_...
```

`initTelegramAlerts({ source: 'MiSistema' })` puede quedarse igual: el `source`
pasa a ser solo para el log local. **El nombre real con el que se firman las
alertas lo decide la API key**, del lado del servidor — así ya no se puede
olvidar ni firmar con el nombre de otro sistema.

Los tiempos de deduplicación y digest ya no se configuran por sistema: son del
servicio.

---

## Pruebas

```bash
npm test                                        # 13
cd python && python3 -m unittest discover -s tests   # 12
```

---

**Dudas:** Julio Hidalgo — Kuanta Bridge Group.
