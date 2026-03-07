/**
 * Telegram Notifier — singleton service for sending messages via Telegraf.
 *
 * - Initializes from env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 * - No-op if env vars are not set
 * - All errors are handled internally (never throws to caller)
 */
import { Telegraf } from "telegraf";
import { logger } from "@opentrader/logger";

class TelegramNotifier {
  private bot: Telegraf | null = null;
  private chatId: string | null = null;
  private enabled = false;
  private initialized = false;

  /**
   * Lazily initialize on first use.
   * Reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from env.
   */
  private init(): void {
    if (this.initialized) return;
    this.initialized = true;

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      logger.info(
        "[Telegram] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — notifications disabled",
      );
      return;
    }

    try {
      this.bot = new Telegraf(token);
      this.chatId = chatId;
      this.enabled = true;
      logger.info(`[Telegram] Notifications enabled (chatId: ${chatId})`);
    } catch (err) {
      logger.warn(`[Telegram] Failed to initialize Telegraf: ${(err as Error).message}`);
    }
  }

  /**
   * Send a MarkdownV2 formatted message to the configured chat.
   * Returns a resolved promise (never rejects).
   */
  async notify(message: string): Promise<void> {
    this.init();

    if (!this.enabled || !this.bot || !this.chatId) {
      return;
    }

    try {
      await this.bot.telegram.sendMessage(this.chatId, message, {
        parse_mode: "MarkdownV2",
      });
    } catch (err) {
      logger.warn(`[Telegram] Failed to send message: ${(err as Error).message}`);
    }
  }

  /**
   * Send a plain text message (no markdown parsing).
   * Useful for messages that may contain special characters.
   * Returns a resolved promise (never rejects).
   */
  async notifyPlain(message: string): Promise<void> {
    this.init();

    if (!this.enabled || !this.bot || !this.chatId) {
      return;
    }

    try {
      await this.bot.telegram.sendMessage(this.chatId, message);
    } catch (err) {
      logger.warn(`[Telegram] Failed to send message: ${(err as Error).message}`);
    }
  }

  /**
   * Check if notifications are currently enabled.
   */
  isEnabled(): boolean {
    this.init();
    return this.enabled;
  }
}

/** Singleton instance */
export const telegram = new TelegramNotifier();
