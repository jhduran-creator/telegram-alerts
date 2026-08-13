/**
 * Low-level Telegram Bot API client using native fetch
 */

const TELEGRAM_API = 'https://api.telegram.org'
const TIMEOUT_MS = 5000

/**
 * Send a message via Telegram Bot API
 * @param {string} token - Bot token
 * @param {string} chatId - Chat/group ID
 * @param {string} text - Message text (MarkdownV2)
 * @returns {Promise<boolean>} true if sent successfully
 */
export async function sendTelegramMessage(token, chatId, text) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true
      }),
      signal: controller.signal
    })

    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      console.error(`[TelegramAlerts] API error ${response.status}:`, data.description || 'Unknown error')
      return false
    }

    return true
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('[TelegramAlerts] Request timeout (5s)')
    } else {
      console.error('[TelegramAlerts] Send failed:', err.message)
    }
    return false
  } finally {
    clearTimeout(timeout)
  }
}
