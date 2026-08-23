"""Cliente del servicio central de alertas de Kuanta Bridge.

Mismas garantías que el cliente de Node, para que un sistema en Python no sea
ciudadano de segunda: identificador por alerta para que un reintento no duplique,
buffer con reintento cuando el servicio no responde, respaldo opcional en disco,
y consulta del comprobante de entrega.

Solo biblioteca estándar: `urllib`. Un servicio que existe para avisar cuando
algo se rompe no puede depender de que sus propias dependencias estén sanas.

Nunca lanza. Ni sin configuración, ni sin red, ni con el servicio caído.

    from kuanta_alerts import init_alerts, send_alert, notify_job_error

    init_alerts()  # lee ALERTS_URL y ALERTS_API_KEY del entorno

    send_alert("La alarma X entró en ALARM", severity="CRITICAL", category="aws")
"""

from .client import (  # noqa: F401
    init_alerts,
    send_alert,
    notify_job_error,
    contador,
    JobFailures,
    confirmar,
    resumen_entregas,
    send_test_alert,
    get_alert_status,
    shutdown,
)

__version__ = "2.0.0"
__all__ = [
    "init_alerts",
    "send_alert",
    "notify_job_error",
    "contador",
    "JobFailures",
    "confirmar",
    "resumen_entregas",
    "send_test_alert",
    "get_alert_status",
    "shutdown",
]
