/**
 * Fachada ESM. La implementación vive en `index.cjs`, una sola, para que
 * KMessage (ESM) y HelpDesk (CJS) no puedan quedar con versiones distintas.
 */

import cliente from './index.cjs'

export const initTelegramAlerts = cliente.initTelegramAlerts
export const sendAlert = cliente.sendAlert
export const confirmar = cliente.confirmar
export const resumenEntregas = cliente.resumenEntregas
export const notifyJobError = cliente.notifyJobError
export const contador = cliente.contador
export const JobFailures = cliente.JobFailures
export const sendTestAlert = cliente.sendTestAlert
export const getAlertStatus = cliente.getAlertStatus
export const verificar = cliente.verificar
export const shutdown = cliente.shutdown

export default cliente
