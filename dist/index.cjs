var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.js
var src_exports = {};
__export(src_exports, {
  default: () => src_default,
  getAlertStatus: () => getAlertStatus,
  initTelegramAlerts: () => initTelegramAlerts,
  notifyJobError: () => notifyJobError,
  sendAlert: () => sendAlert,
  sendTestAlert: () => sendTestAlert,
  shutdown: () => shutdown
});
module.exports = __toCommonJS(src_exports);

// src/telegramClient.js
var TELEGRAM_API = "https://api.telegram.org";
var TIMEOUT_MS = 5e3;
async function sendTelegramMessage(token, chatId, text) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      console.error(`[TelegramAlerts] API error ${response.status}:`, data.description || "Unknown error");
      return false;
    }
    return true;
  } catch (err) {
    if (err.name === "AbortError") {
      console.error("[TelegramAlerts] Request timeout (5s)");
    } else {
      console.error("[TelegramAlerts] Send failed:", err.message);
    }
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// src/rateLimiter.js
var sent = /* @__PURE__ */ new Map();
var cleanupInterval = null;
function shouldSend(key, windowMs) {
  const now = Date.now();
  const lastSent = sent.get(key);
  if (lastSent && now - lastSent < windowMs) {
    return false;
  }
  sent.set(key, now);
  return true;
}
function startCleanup(windowMs) {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamp] of sent) {
      if (now - timestamp > windowMs * 2) {
        sent.delete(key);
      }
    }
  }, 30 * 60 * 1e3);
  cleanupInterval.unref?.();
}
function stopCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

// src/formatter.js
var import_os = __toESM(require("os"), 1);
var ESCAPE_CHARS = /([_*\[\]()~`>#+\-=|{}.!])/g;
function esc(text) {
  if (!text) return "";
  return String(text).replace(ESCAPE_CHARS, "\\$1");
}
function formatCritical({ source, category, message, tenant, stack, timestamp }) {
  const time = timestamp || (/* @__PURE__ */ new Date()).toLocaleString("es-CR", { timeZone: "America/Costa_Rica" });
  const host = import_os.default.hostname();
  let msg = `\u{1F534} *CRITICAL* \\| ${esc(source)}
`;
  msg += `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
`;
  msg += `*Error:* ${esc(message)}
`;
  msg += `*Tipo:* ${esc(category)}
`;
  if (tenant) msg += `*Tenant:* ${esc(tenant)}
`;
  msg += `*Hora:* ${esc(time)}
`;
  msg += `*Host:* ${esc(host)}
`;
  if (stack) {
    const shortStack = stack.substring(0, 200).split("\n").slice(0, 3).join("\n");
    msg += `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
`;
    msg += `_${esc(shortStack)}_`;
  }
  return msg;
}
function formatDigest(items, source) {
  if (!items || items.length === 0) return null;
  let msg = `\u{1F7E1} *WARNING DIGEST* \\(${items.length} alerta${items.length > 1 ? "s" : ""}\\)
`;
  msg += `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
`;
  for (let i = 0; i < Math.min(items.length, 20); i++) {
    const item = items[i];
    const time = new Date(item.timestamp || Date.now()).toLocaleTimeString("es-CR", {
      timeZone: "America/Costa_Rica",
      hour: "2-digit",
      minute: "2-digit"
    });
    msg += `${i + 1}\\. \\[${esc(item.category)}\\] ${esc(item.message)}`;
    if (item.tenant) msg += ` \\| ${esc(item.tenant)}`;
    msg += ` \u2014 _${esc(time)}_
`;
  }
  if (items.length > 20) {
    msg += `
_\\.\\.\\.y ${items.length - 20} m\xE1s_`;
  }
  return msg;
}
function formatTest(source) {
  const time = (/* @__PURE__ */ new Date()).toLocaleString("es-CR", { timeZone: "America/Costa_Rica" });
  return `\u2705 *Test* \\| ${esc(source)}
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
Alerta de prueba enviada correctamente
*Hora:* ${esc(time)}
*Host:* ${esc(import_os.default.hostname())}`;
}

// src/digestBuffer.js
var MAX_BUFFER_SIZE = 50;
var buffer = [];
var flushInterval = null;
var flushCallback = null;
function addWarning(item) {
  if (buffer.length >= MAX_BUFFER_SIZE) return;
  buffer.push({ ...item, timestamp: Date.now() });
}
function startDigest(intervalMs, callback) {
  flushCallback = callback;
  if (flushInterval) return;
  flushInterval = setInterval(() => {
    if (buffer.length > 0 && flushCallback) {
      const items = [...buffer];
      buffer = [];
      flushCallback(items);
    }
  }, intervalMs);
  flushInterval.unref?.();
}
function stopDigest() {
  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
  }
}
function flushNow() {
  if (buffer.length > 0 && flushCallback) {
    const items = [...buffer];
    buffer = [];
    flushCallback(items);
  }
}

// src/jobNotifier.js
async function notifyJobError(jobName, error, opts = {}) {
  try {
    const { severity = "CRITICAL", tenant, metadata, context } = opts;
    const errMsg = error?.message || String(error || "unknown error");
    const stack = error?.stack || void 0;
    const contextSuffix = context ? ` \u2014 ${context}` : "";
    const message = `\u274C ${jobName}: ${errMsg}${contextSuffix}`;
    await sendAlert({
      severity,
      category: "job",
      message,
      tenant,
      stack,
      metadata: { ...metadata, job: jobName }
    });
  } catch {
  }
}

// src/index.js
var config = {
  enabled: false,
  token: null,
  chatId: null,
  // Sin default a propósito: `source` lo exige initTelegramAlerts(). Un default silencioso
  // haría que un sistema mal configurado firme sus alertas con el nombre de otro.
  source: null,
  rateLimitMs: 3e5,
  // 5 minutes
  digestIntervalMs: 9e5
  // 15 minutes
};
var initialized = false;
function initTelegramAlerts(options = {}) {
  const source = typeof options.source === "string" ? options.source.trim() : "";
  if (!source) {
    throw new Error(
      '[TelegramAlerts] Falta `source`. Us\xE1 initTelegramAlerts({ source: "NombreDeTuSistema" }). Es lo \xFAnico que identifica de qu\xE9 sistema viene cada alerta en el chat compartido.'
    );
  }
  config.token = process.env.TELEGRAM_BOT_TOKEN || null;
  config.chatId = process.env.TELEGRAM_CHAT_ID || null;
  config.enabled = process.env.TELEGRAM_ALERTS_ENABLED === "true" && !!config.token && !!config.chatId;
  config.source = source;
  const rateLimitSec = parseInt(process.env.TELEGRAM_RATE_LIMIT_SECONDS) || 300;
  config.rateLimitMs = rateLimitSec * 1e3;
  const digestSec = parseInt(process.env.TELEGRAM_DIGEST_INTERVAL_SECONDS) || 900;
  config.digestIntervalMs = digestSec * 1e3;
  if (config.enabled) {
    startCleanup(config.rateLimitMs);
    startDigest(config.digestIntervalMs, async (items) => {
      try {
        const msg = formatDigest(items, config.source);
        if (msg) {
          await sendTelegramMessage(config.token, config.chatId, msg);
        }
      } catch (err) {
      }
    });
    console.log(`[TelegramAlerts] Initialized for ${config.source} (rate limit: ${rateLimitSec}s, digest: ${digestSec}s)`);
  } else {
    console.log(`[TelegramAlerts] Disabled (TELEGRAM_ALERTS_ENABLED=${process.env.TELEGRAM_ALERTS_ENABLED}, token=${config.token ? "set" : "missing"}, chatId=${config.chatId ? "set" : "missing"})`);
  }
  initialized = true;
}
function normalizarMensaje(message) {
  if (typeof message === "string") {
    if (!message.includes("[object Object]")) return message;
    return `${message}  \u26A0\uFE0F (un objeto se convirti\xF3 en texto en el origen; revisar qui\xE9n construye este error)`;
  }
  if (message instanceof Error) return message.message || String(message);
  if (message && typeof message === "object") {
    try {
      return JSON.stringify(message).slice(0, 500);
    } catch {
    }
  }
  return String(message);
}
async function sendAlert({ severity = "WARNING", category = "internal", message, tenant, stack, metadata } = {}) {
  if (!config.enabled || !initialized) return;
  if (!message) return;
  message = normalizarMensaje(message);
  if (severity === "INFO") return;
  if (severity === "WARNING") {
    addWarning({ category, message, tenant, source: config.source });
    return;
  }
  const rateKey = `${severity}:${category}:${message.substring(0, 80)}`;
  if (!shouldSend(rateKey, config.rateLimitMs)) return;
  try {
    const text = formatCritical({
      source: config.source,
      category,
      message,
      tenant,
      stack
    });
    await sendTelegramMessage(config.token, config.chatId, text);
  } catch (err) {
  }
}
async function sendTestAlert() {
  if (!config.token || !config.chatId) {
    return false;
  }
  const text = formatTest(config.source);
  return await sendTelegramMessage(config.token, config.chatId, text);
}
function getAlertStatus() {
  return {
    enabled: config.enabled,
    source: config.source,
    rateLimitSeconds: config.rateLimitMs / 1e3,
    digestIntervalSeconds: config.digestIntervalMs / 1e3,
    tokenConfigured: !!config.token,
    chatIdConfigured: !!config.chatId
  };
}
function shutdown() {
  flushNow();
  stopDigest();
  stopCleanup();
}
var src_default = { initTelegramAlerts, sendAlert, sendTestAlert, getAlertStatus, shutdown };
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  getAlertStatus,
  initTelegramAlerts,
  notifyJobError,
  sendAlert,
  sendTestAlert,
  shutdown
});
