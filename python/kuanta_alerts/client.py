"""Implementación del cliente. Ver el docstring del paquete."""

from __future__ import annotations

import atexit
import json
import logging
import os
import socket
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid
from typing import Any, Optional

log = logging.getLogger("kuanta_alerts")

URL_POR_DEFECTO = "https://msg.kuantabridge.com"
TIMEOUT_POR_DEFECTO = 3.0
BUFFER_MAX = 100
REINTENTO_SEGUNDOS = 30


class _Estado:
    def __init__(self) -> None:
        self.inicializado = False
        self.habilitado = False
        self.url = URL_POR_DEFECTO
        self.api_key: Optional[str] = None
        self.source: Optional[str] = None
        self.host = socket.gethostname()
        self.timeout = TIMEOUT_POR_DEFECTO
        self.buffer: list[dict] = []
        self.buffer_max = BUFFER_MAX
        self.buffer_file: Optional[str] = None
        self.perdidas_por_buffer = 0
        self.ultimo_error_red: Optional[str] = None
        self.lock = threading.Lock()
        self.hilo: Optional[threading.Thread] = None
        self.parar = threading.Event()


_e = _Estado()


# ── Inicialización ────────────────────────────────────────────────────────

def init_alerts(
    source: Optional[str] = None,
    url: Optional[str] = None,
    api_key: Optional[str] = None,
    buffer_file: Optional[str] = None,
) -> bool:
    """Arranca el cliente. Una sola vez, al iniciar el proceso.

    `source` es solo para el log local: **el nombre con el que se firman las
    alertas lo decide la API key**, del lado del servidor. Así no se puede
    olvidar ni firmar sin querer con el nombre de otro sistema.
    """
    _e.url = (url or os.getenv("ALERTS_URL") or URL_POR_DEFECTO).rstrip("/")
    _e.api_key = api_key or os.getenv("ALERTS_API_KEY")
    _e.source = source or os.getenv("ALERTS_SOURCE")
    _e.timeout = float(os.getenv("ALERTS_TIMEOUT_SECONDS", TIMEOUT_POR_DEFECTO))
    _e.buffer_max = int(os.getenv("ALERTS_BUFFER_MAX", BUFFER_MAX))
    # Sin esto, un proceso que muere con el servicio caído se lleva las alertas
    # pendientes — y ese es justo el momento en que más importan.
    _e.buffer_file = buffer_file or os.getenv("ALERTS_BUFFER_FILE")
    _e.buffer = []

    encendido = os.getenv("ALERTS_ENABLED", "").lower() == "true"
    _e.habilitado = encendido and bool(_e.api_key)
    _e.inicializado = True

    if _e.habilitado:
        log.info("Alertas activas — %s → %s", _e.source or "nombre según la API key", _e.url)
        _restaurar_buffer()
        _arrancar_reintento()
    else:
        log.info(
            "Alertas desactivadas (ALERTS_ENABLED=%s, api_key=%s). Todo queda en el log local.",
            os.getenv("ALERTS_ENABLED", "sin definir"),
            "ok" if _e.api_key else "FALTA",
        )
    return _e.habilitado


# ── Envío ─────────────────────────────────────────────────────────────────

def send_alert(
    message: Any,
    severity: str = "WARNING",
    category: str = "internal",
    tenant: Optional[str] = None,
    stack: Optional[str] = None,
    throttle_key: Optional[str] = None,
    throttle_minutes: Optional[int] = None,
    alert_id: Optional[str] = None,
) -> Any:
    """Manda una alerta. Nunca lanza.

    Devuelve ``{"id": …, "enviada": bool, "en_buffer": bool}``. El id sirve para
    confirmar después si llegó al chat; ver :func:`confirmar`.
    """
    texto = _texto_de(message)
    if not texto:
        return False

    # El log local sale SIEMPRE. Cuando alguien investiga un incidente, el log
    # del propio sistema es la fuente completa; el chat es solo el aviso.
    etiqueta = f"[{severity}][{category}]" + (f"[{tenant}]" if tenant else "")
    (log.error if severity == "CRITICAL" else log.warning)("%s %s", etiqueta, texto)

    if not _e.habilitado:
        return False

    payload = {
        # Identificador propio: si hay que reintentar, el servicio reconoce que
        # es la misma alerta y no la publica dos veces.
        "id": alert_id or str(uuid.uuid4()),
        "severity": severity,
        "category": category,
        "message": texto,
        "host": _e.host,
        "timestamp": int(time.time() * 1000),
    }
    if tenant:
        payload["tenant"] = tenant
    if stack:
        payload["stack"] = stack
    if throttle_key:
        payload["throttleKey"] = throttle_key
    if throttle_minutes is not None:
        payload["throttleMinutes"] = throttle_minutes

    ok = _post("/v1/alerts", payload)
    if not ok:
        _guardar_en_buffer(payload)
    return {"id": payload["id"], "enviada": ok, "en_buffer": not ok}


def _post(ruta: str, payload: dict) -> bool:
    req = urllib.request.Request(
        f"{_e.url}{ruta}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {_e.api_key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=_e.timeout) as res:
            if _e.ultimo_error_red:
                log.info("El servicio de alertas responde de nuevo")
                _e.ultimo_error_red = None
            return 200 <= res.status < 300
    except urllib.error.HTTPError as err:
        # 4xx que no sea 429: el servicio rechazó la alerta por cómo viene.
        # Reintentar no la va a arreglar.
        if 400 <= err.code < 500 and err.code != 429:
            log.error("El servicio rechazó la alerta (%s): %s", err.code, _cuerpo(err))
            return True
        _registrar_fallo(f"HTTP {err.code}")
        return False
    except Exception as err:  # noqa: BLE001 — alertar no puede tumbar nada
        _registrar_fallo(str(err))
        return False


def _cuerpo(err: urllib.error.HTTPError) -> str:
    try:
        return err.read().decode("utf-8", "replace")[:200]
    except Exception:  # noqa: BLE001
        return ""


def _registrar_fallo(motivo: str) -> None:
    if not _e.ultimo_error_red:
        log.warning("Servicio de alertas inalcanzable (%s). Se guardan en buffer y se reintenta.", motivo)
    _e.ultimo_error_red = motivo


# ── Buffer ────────────────────────────────────────────────────────────────

def _guardar_en_buffer(payload: dict) -> None:
    with _e.lock:
        if len(_e.buffer) >= _e.buffer_max:
            # Se descarta lo más viejo: si lleva tanto rato caído, lo de hace
            # media hora ya no le sirve a nadie y lo reciente sí.
            _e.buffer.pop(0)
            _e.perdidas_por_buffer += 1
        _e.buffer.append(payload)
    _persistir_buffer()


def _persistir_buffer() -> None:
    if not _e.buffer_file:
        return
    try:
        tmp = f"{_e.buffer_file}.tmp"
        with _e.lock:
            datos = json.dumps(_e.buffer)
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(datos)
        # Reemplazo atómico: un corte a media escritura no puede dejar un
        # archivo roto que impida arrancar la próxima vez.
        os.replace(tmp, _e.buffer_file)
    except Exception as err:  # noqa: BLE001
        log.warning("No se pudo guardar el buffer en disco: %s", err)


def _restaurar_buffer() -> None:
    if not _e.buffer_file or not os.path.exists(_e.buffer_file):
        return
    try:
        with open(_e.buffer_file, encoding="utf-8") as f:
            guardadas = json.load(f)
        if not isinstance(guardadas, list):
            return
        corte = (time.time() - 24 * 3600) * 1000
        with _e.lock:
            _e.buffer = [a for a in guardadas if a.get("timestamp", 0) > corte]
        if _e.buffer:
            log.info("%d alertas pendientes recuperadas del disco", len(_e.buffer))
    except Exception as err:  # noqa: BLE001
        log.warning("No se pudo restaurar el buffer: %s", err)


def _vaciar_buffer() -> int:
    with _e.lock:
        if not _e.buffer or not _e.habilitado:
            return 0
        lote = _e.buffer[:200]
        del _e.buffer[: len(lote)]

    if not _post("/v1/alerts/batch", {"alerts": lote}):
        with _e.lock:
            # Vuelven al frente para no perder el orden en que ocurrieron.
            _e.buffer[0:0] = lote
        return 0

    if _e.perdidas_por_buffer:
        log.warning(
            "%d alertas se perdieron por buffer lleno mientras el servicio estuvo caído",
            _e.perdidas_por_buffer,
        )
        _e.perdidas_por_buffer = 0
    _persistir_buffer()
    return len(lote)


def _arrancar_reintento() -> None:
    if _e.hilo and _e.hilo.is_alive():
        return
    _e.parar.clear()

    def bucle() -> None:
        while not _e.parar.wait(REINTENTO_SEGUNDOS):
            try:
                _vaciar_buffer()
            except Exception as err:  # noqa: BLE001
                log.debug("Reintento falló: %s", err)

    # Demonio: no puede impedir que el proceso termine.
    _e.hilo = threading.Thread(target=bucle, name="kuanta-alerts", daemon=True)
    _e.hilo.start()


# ── Errores de jobs ───────────────────────────────────────────────────────

def notify_job_error(
    job_name: str,
    error: Any,
    severity: str = "CRITICAL",
    tenant: Optional[str] = None,
    context: Optional[str] = None,
) -> Any:
    """Atajo para el `except` de un cron. Nunca lanza."""
    try:
        sufijo = f" — {context}" if context else ""
        stack = None
        if isinstance(error, BaseException):
            stack = "".join(traceback.format_exception(type(error), error, error.__traceback__))
        return send_alert(
            message=f"❌ {job_name}: {_texto_de(error)}{sufijo}",
            severity=severity,
            category="job",
            tenant=tenant,
            stack=stack,
            # Si el job además muere, no salen dos alertas del mismo problema.
            throttle_key=f"job:{job_name}",
        )
    except Exception as err:  # noqa: BLE001
        log.error("El propio alertador falló: %s", err)
        return False


class JobFailures:
    """Junta los fallos por ítem de un run y manda **una** alerta al final.

    Un cron que recorre tenants y falla en todos por un problema sistémico
    mandaría cientos de mensajes. Esto manda uno, con el denominador — que es
    el dato que separa «uno con datos raros» de «se rompió todo».

        fallos = contador("SyncTenants")
        for t in tenants:
            try:
                ...
            except Exception as err:
                fallos.add(err)
        fallos.reportar(len(tenants))
    """

    def __init__(self, job: str) -> None:
        self.job = job
        self.errores: list[str] = []

    def add(self, err: Any) -> None:
        self.errores.append(_texto_de(err))

    @property
    def total(self) -> int:
        return len(self.errores)

    def reportar(self, procesados: Optional[int] = None, severity: str = "WARNING") -> Any:
        if not self.errores:
            return False  # un run que corre bien no dice nada
        distintos = list(dict.fromkeys(self.errores))
        de_cuantos = "" if procesados is None else f" de {procesados}"
        otros = f" (+{len(distintos) - 1} error(es) distinto(s))" if len(distintos) > 1 else ""
        r = send_alert(
            message=f"{self.job}: fallaron {len(self.errores)}{de_cuantos} — {distintos[0]}{otros}",
            severity=severity,
            category="job",
            throttle_key=f"job:{self.job}",
        )
        self.errores.clear()
        return r


def contador(job: str) -> JobFailures:
    return JobFailures(job)


# ── Verificación ──────────────────────────────────────────────────────────

def confirmar(alert_id: str) -> dict:
    """Consulta si una alerta llegó al chat, con su comprobante de Telegram."""
    return _get(f"/v1/alerts/{alert_id}")


def resumen_entregas() -> dict:
    """Resumen de entregas de este sistema. `sinEntregar` sostenido = algo no sale."""
    return _get("/v1/verify")


def get_alert_status() -> dict:
    """Estado del cliente, sin salir a la red."""
    return {
        "inicializado": _e.inicializado,
        "habilitado": _e.habilitado,
        "url": _e.url,
        "source": _e.source,
        "api_key_configurada": bool(_e.api_key),
        "en_buffer": len(_e.buffer),
        "perdidas_por_buffer": _e.perdidas_por_buffer,
        "ultimo_error_red": _e.ultimo_error_red,
    }


def send_test_alert() -> bool:
    """Alerta de prueba. Avisar antes de correrla: el chat es compartido."""
    if not _e.habilitado:
        return False
    return _post("/v1/alerts/test", {"host": _e.host})


def _get(ruta: str) -> dict:
    if not _e.habilitado:
        return {"ok": False, "error": "alertas desactivadas"}
    req = urllib.request.Request(
        f"{_e.url}{ruta}",
        headers={"Authorization": f"Bearer {_e.api_key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=_e.timeout) as res:
            return {"ok": True, **json.loads(res.read().decode("utf-8"))}
    except Exception as err:  # noqa: BLE001
        return {"ok": False, "error": str(err)}


# ── Cierre ────────────────────────────────────────────────────────────────

def shutdown() -> None:
    """Intenta vaciar el buffer antes de que el proceso muera."""
    _e.parar.set()
    if _e.buffer:
        _vaciar_buffer()
        if _e.buffer:
            _persistir_buffer()
            log.warning(
                "%d alertas quedan pendientes al cerrar.%s",
                len(_e.buffer),
                " Salen en el próximo arranque." if _e.buffer_file
                else " SE PIERDEN: configurá ALERTS_BUFFER_FILE.",
            )
    _e.habilitado = False


atexit.register(shutdown)


def _texto_de(err: Any) -> str:
    """Nunca devuelve '[object Object]' ni 'None'.

    El 2026-08-13 llegó un CRITICAL que decía `Broker send falló: [object Object]`
    y el error real se perdió para siempre. En Python el equivalente es un dict
    interpolado o un `str(None)`: se serializa antes de que sea tarde.
    """
    if err is None:
        return ""
    if isinstance(err, str):
        return err
    if isinstance(err, BaseException):
        return str(err) or err.__class__.__name__
    try:
        return json.dumps(err, ensure_ascii=False, default=str)[:500]
    except Exception:  # noqa: BLE001
        return str(err)
