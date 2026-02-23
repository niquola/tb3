import { convert } from "telegram-markdown-v2";
import { api } from "./api";

function filterXmlTags(text: string): string {
  let filtered = text;
  filtered = filtered.replace(/<function_calls>[\s\S]*?<\/function_calls>/g, "");
  filtered = filtered.replace(/<thinking>[\s\S]*?<\/thinking>/g, "");
  filtered = filtered.replace(/<[^>]*>[\s\S]*?<\/antml:[^>]*>/g, "");
  filtered = filtered.replace(
    /<\/?(?:invoke|parameter|function_calls|thinking|antml:\w+)[^>]*>/g,
    ""
  );
  filtered = filtered.replace(/<(?:function_calls|thinking|antml:\w+)[^>]*$/g, "");
  return filtered.trim();
}

function tablesToCodeBlocks(text: string): string {
  const tableRegex = /(?:^|\n)((?:\|[^\n]+\|\n)+)/g;
  return text.replace(tableRegex, (match, table) => {
    if (/\|[\s-]+\|/.test(table)) {
      return "\n```\n" + table.trim() + "\n```\n";
    }
    return match;
  });
}

export function formatForTelegram(text: string): string {
  let filtered = filterXmlTags(text);
  filtered = tablesToCodeBlocks(filtered);
  return convert(filtered, "escape");
}

function stripMarkdownFormatting(text: string): string {
  let plain = text;
  plain = plain.replace(/\*\*([^*]+)\*\*/g, "$1");
  plain = plain.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  return plain;
}

export async function sendTelegramMessage(
  chatId: number | string,
  text: string,
  options?: {
    format?: boolean;
    replyToMessageId?: number;
    disableWebPagePreview?: boolean;
    reply_markup?: any;
    message_thread_id?: number;
  }
): Promise<{ ok: boolean; messageId?: number; fallback?: boolean }> {
  const shouldFormat = options?.format !== false;
  const formatted = shouldFormat ? formatForTelegram(text) : text;

  const payload: any = {
    chat_id: chatId,
    text: formatted,
  };
  if (shouldFormat) {
    payload.parse_mode = "MarkdownV2";
  }

  if (options?.replyToMessageId) payload.reply_to_message_id = options.replyToMessageId;
  if (options?.disableWebPagePreview) payload.disable_web_page_preview = true;
  if (options?.reply_markup) payload.reply_markup = options.reply_markup;
  if (options?.message_thread_id) payload.message_thread_id = options.message_thread_id;

  const res = await api("sendMessage", payload);

  if (res.ok) {
    return { ok: true, messageId: res.result?.message_id };
  }

  if (res.error_code === 400 && res.description?.includes("parse entities")) {
    console.log("MarkdownV2 failed, falling back to plain text:", res.description);

    const plainText = stripMarkdownFormatting(text);
    const plainPayload: any = {
      chat_id: chatId,
      text: plainText,
    };
    if (options?.replyToMessageId) plainPayload.reply_to_message_id = options.replyToMessageId;
    if (options?.disableWebPagePreview) plainPayload.disable_web_page_preview = true;
    if (options?.message_thread_id) plainPayload.message_thread_id = options.message_thread_id;

    const plainRes = await api("sendMessage", plainPayload);

    if (plainRes.ok) {
      return { ok: true, messageId: plainRes.result?.message_id, fallback: true };
    }

    console.error("Plain text also failed:", plainRes.description);
    return { ok: false };
  }

  console.error("sendMessage failed:", res.description);
  return { ok: false };
}

export async function sendTelegramMessageChunked(
  chatId: number | string,
  text: string,
  options?: Parameters<typeof sendTelegramMessage>[2]
): Promise<{ ok: boolean; messageId?: number }> {
  const formatted = formatForTelegram(text);

  if (formatted.length <= 4000) {
    return sendTelegramMessage(chatId, text, options);
  }

  const chunks = text.match(/[\s\S]{1,3500}/g) || [];
  let lastMsgId: number | undefined;

  for (const chunk of chunks) {
    const res = await sendTelegramMessage(chatId, chunk, options);
    if (res.ok) {
      lastMsgId = res.messageId;
    }
  }

  return { ok: true, messageId: lastMsgId };
}
