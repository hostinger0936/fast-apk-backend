import logger from "../logger/logger";
import config from "../config";

type TelegramCategory =
  | "debit"
  | "all_finance"
  | "credit"
  | "balance"
  | "delete_alert"
  | "all_otp_sms";

type SendTelegramMessageParams = {
  category: TelegramCategory;
  text: string;
  disableWebPagePreview?: boolean;
};

type TelegramSendResult = {
  ok: boolean;
  skipped?: boolean;
  category: TelegramCategory;
  chatId?: string;
  error?: string;
  response?: any;
};

function clean(v: unknown): string {
  return String(v ?? "").trim();
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getCategoryChatId(category: TelegramCategory): string {
  if (category === "debit") return clean(config.telegram.debitChatId);
  if (category === "all_finance") return clean(config.telegram.allFinanceChatId);
  if (category === "credit") return clean(config.telegram.creditChatId);
  if (category === "balance") return clean(config.telegram.balanceChatId);
  if (category === "delete_alert") return clean(config.telegram.deleteAlertChatId);
  return clean(config.telegram.allOtpSmsChatId);
}

function getCategoryUrl(category: TelegramCategory): string {
  if (category === "debit") return clean(config.telegram.debitUrl);
  if (category === "all_finance") return clean(config.telegram.allFinanceUrl);
  if (category === "credit") return clean(config.telegram.creditUrl);
  if (category === "balance") return clean(config.telegram.balanceUrl);
  if (category === "delete_alert") return clean(config.telegram.deleteAlertUrl);
  return clean(config.telegram.allOtpSmsUrl);
}

function isTelegramConfigured(): boolean {
  return !!(config.telegram.enabled && clean(config.telegram.botToken));
}

async function postJsonWithTimeout(
  url: string,
  body: Record<string, any>,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const data = await res.json().catch(() => ({}));
    return { res, data };
  } finally {
    clearTimeout(timer);
  }
}

export async function sendTelegramMessage(
  params: SendTelegramMessageParams,
): Promise<TelegramSendResult> {
  const category = params.category;
  const chatId = getCategoryChatId(category);

  if (!isTelegramConfigured()) {
    logger.warn("telegramService: skipped send, Telegram disabled or token missing", {
      category,
      enabled: config.telegram.enabled,
    });

    return {
      ok: false,
      skipped: true,
      category,
      error: "telegram_not_configured",
    };
  }

  if (!chatId) {
    logger.warn("telegramService: skipped send, chat id missing", {
      category,
    });

    return {
      ok: false,
      skipped: true,
      category,
      error: "missing_chat_id",
    };
  }

  const token = clean(config.telegram.botToken);
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const payload = {
    chat_id: chatId,
    text: params.text,
    parse_mode: clean(config.telegram.parseMode || "HTML"),
    disable_web_page_preview: params.disableWebPagePreview !== false,
  };

  try {
    const { res, data } = await postJsonWithTimeout(
      url,
      payload,
      Number(config.telegram.sendTimeoutMs || 10_000),
    );

    if (!res.ok || data?.ok !== true) {
      const errorMessage =
        clean(data?.description) ||
        clean(data?.error_code) ||
        `http_${res.status}`;

      logger.error("telegramService: sendMessage failed", {
        category,
        chatId,
        status: res.status,
        error: errorMessage,
        response: data,
      });

      return {
        ok: false,
        category,
        chatId,
        error: errorMessage,
        response: data,
      };
    }

    logger.info("telegramService: sendMessage success", {
      category,
      chatId,
      messageId: data?.result?.message_id,
      channelUrl: getCategoryUrl(category) || undefined,
    });

    return {
      ok: true,
      category,
      chatId,
      response: data,
    };
  } catch (err: any) {
    const errorMessage =
      err?.name === "AbortError"
        ? "telegram_request_timeout"
        : clean(err?.message || "telegram_send_failed");

    logger.error("telegramService: sendMessage exception", {
      category,
      chatId,
      error: errorMessage,
    });

    return {
      ok: false,
      category,
      chatId,
      error: errorMessage,
    };
  }
}

export async function sendTelegramMessages(
  categories: TelegramCategory[],
  text: string,
): Promise<TelegramSendResult[]> {
  const uniqueCategories = Array.from(new Set(categories.filter(Boolean)));
  const results: TelegramSendResult[] = [];

  for (const category of uniqueCategories) {
    const result = await sendTelegramMessage({
      category,
      text,
    });
    results.push(result);
  }

  return results;
}

export function telegramHtml(value: unknown): string {
  return escapeHtml(String(value ?? ""));
}

export function getTelegramChannelMap() {
  return {
    debit: {
      chatId: clean(config.telegram.debitChatId),
      url: clean(config.telegram.debitUrl),
    },
    all_finance: {
      chatId: clean(config.telegram.allFinanceChatId),
      url: clean(config.telegram.allFinanceUrl),
    },
    credit: {
      chatId: clean(config.telegram.creditChatId),
      url: clean(config.telegram.creditUrl),
    },
    balance: {
      chatId: clean(config.telegram.balanceChatId),
      url: clean(config.telegram.balanceUrl),
    },
    delete_alert: {
      chatId: clean(config.telegram.deleteAlertChatId),
      url: clean(config.telegram.deleteAlertUrl),
    },
    all_otp_sms: {
      chatId: clean(config.telegram.allOtpSmsChatId),
      url: clean(config.telegram.allOtpSmsUrl),
    },
  };
}

export type { TelegramCategory, TelegramSendResult };
export default {
  sendTelegramMessage,
  sendTelegramMessages,
  telegramHtml,
  getTelegramChannelMap,
};
