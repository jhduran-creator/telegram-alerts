"""Pruebas del cliente Python contra un doble del servicio.

    python3 -m unittest discover -s tests -v
"""

import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from kuanta_alerts import client as kc  # noqa: E402

recibidas = []
lotes = []
caido = False


class Doble(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        largo = int(self.headers.get("Content-Length", 0))
        cuerpo = json.loads(self.rfile.read(largo) or b"{}")
        if caido:
            self.send_response(503)
            self.end_headers()
            self.wfile.write(b"{}")
            return
        if self.path == "/v1/alerts/batch":
            lotes.append(cuerpo)
            recibidas.extend(cuerpo["alerts"])
        else:
            recibidas.append(cuerpo)
        self.send_response(202)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"id": cuerpo.get("id"), "accion": "encolada"}).encode())

    def log_message(self, *args):  # silencio
        pass


class PruebaCliente(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.servidor = HTTPServer(("127.0.0.1", 0), Doble)
        cls.hilo = threading.Thread(target=cls.servidor.serve_forever, daemon=True)
        cls.hilo.start()
        cls.base = f"http://127.0.0.1:{cls.servidor.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.servidor.shutdown()

    def setUp(self):
        global caido
        recibidas.clear()
        lotes.clear()
        caido = False
        os.environ["ALERTS_ENABLED"] = "true"
        self.buffer_file = tempfile.mktemp(suffix=".json")
        kc.init_alerts(source="Prueba", url=self.base, api_key="llave", buffer_file=self.buffer_file)

    def tearDown(self):
        if os.path.exists(self.buffer_file):
            os.unlink(self.buffer_file)

    def test_envia_y_devuelve_id(self):
        r = kc.send_alert("la base no responde", severity="CRITICAL", category="db")
        self.assertTrue(r["enviada"])
        self.assertTrue(r["id"], "sin id no se puede confirmar la entrega después")
        self.assertEqual(len(recibidas), 1)
        self.assertEqual(recibidas[0]["message"], "la base no responde")
        self.assertTrue(recibidas[0]["host"])

    def test_un_dict_no_se_vuelve_ilegible(self):
        # El equivalente en Python del "[object Object]" que costó un incidente.
        kc.send_alert({"error": "algo pasó", "code": 502}, severity="CRITICAL")
        self.assertIn("algo pasó", recibidas[0]["message"])

    def test_none_no_manda_nada(self):
        self.assertFalse(kc.send_alert(None))
        self.assertEqual(len(recibidas), 0)

    def test_con_servicio_caido_va_al_buffer(self):
        global caido
        caido = True
        r = kc.send_alert("con el servicio caído", severity="CRITICAL")
        self.assertFalse(r["enviada"])
        self.assertTrue(r["en_buffer"])
        self.assertEqual(kc.get_alert_status()["en_buffer"], 1)

    def test_el_buffer_sobrevive_al_reinicio(self):
        global caido
        caido = True
        kc.send_alert("sobrevive al reinicio", severity="CRITICAL")
        self.assertTrue(os.path.exists(self.buffer_file))

        caido = False
        kc.init_alerts(source="Prueba", url=self.base, api_key="llave", buffer_file=self.buffer_file)
        self.assertEqual(kc.get_alert_status()["en_buffer"], 1, "tiene que recuperarla del disco")

    def test_al_volver_el_servicio_sale_en_lote(self):
        global caido
        caido = True
        kc.send_alert("pendiente 1", severity="CRITICAL")
        kc.send_alert("pendiente 2", severity="WARNING")

        caido = False
        enviadas = kc._vaciar_buffer()
        self.assertEqual(enviadas, 2)
        self.assertEqual(len(lotes), 1, "un solo lote, no una petición por alerta")
        self.assertEqual([a["message"] for a in recibidas], ["pendiente 1", "pendiente 2"])
        self.assertEqual(kc.get_alert_status()["en_buffer"], 0)

    def test_el_orden_se_conserva_si_el_lote_falla(self):
        global caido
        caido = True
        kc.send_alert("primera", severity="WARNING")
        kc.send_alert("segunda", severity="WARNING")
        kc._vaciar_buffer()
        self.assertEqual(kc.get_alert_status()["en_buffer"], 2)

        caido = False
        kc._vaciar_buffer()
        self.assertEqual([a["message"] for a in recibidas], ["primera", "segunda"])

    def test_cada_alerta_lleva_id(self):
        kc.send_alert("a")
        self.assertTrue(recibidas[0]["id"], "el id evita duplicar en un reintento")
        kc.send_alert("b", alert_id="mi-propio-id")
        self.assertEqual(recibidas[1]["id"], "mi-propio-id")

    def test_contador_manda_una_sola_alerta_con_denominador(self):
        fallos = kc.contador("SyncTenants")
        fallos.add(ValueError("columna inexistente"))
        fallos.add(ValueError("columna inexistente"))
        fallos.add(KeyError("otra cosa"))
        fallos.reportar(47)

        self.assertEqual(len(recibidas), 1, "tres fallos, un solo mensaje")
        self.assertIn("fallaron 3 de 47", recibidas[0]["message"])
        self.assertEqual(recibidas[0]["throttleKey"], "job:SyncTenants")

    def test_run_sin_fallos_no_dice_nada(self):
        kc.contador("SyncTenants").reportar(47)
        self.assertEqual(len(recibidas), 0, "el canal es para lo que está roto")

    def test_notify_job_error_incluye_stack(self):
        try:
            raise RuntimeError("timeout de la API")
        except RuntimeError as err:
            kc.notify_job_error("TemplateSync", err, context="segundo intento")

        self.assertEqual(recibidas[0]["category"], "job")
        self.assertEqual(recibidas[0]["severity"], "CRITICAL")
        self.assertIn("timeout de la API", recibidas[0]["message"])
        self.assertIn("segundo intento", recibidas[0]["message"])
        self.assertIn("RuntimeError", recibidas[0]["stack"])

    def test_sin_api_key_no_manda_pero_no_estorba(self):
        kc.init_alerts(source="Prueba", url=self.base, api_key=None)
        self.assertFalse(kc.send_alert("x", severity="CRITICAL"))
        self.assertEqual(len(recibidas), 0)
        self.assertFalse(kc.get_alert_status()["habilitado"])


if __name__ == "__main__":
    unittest.main()
