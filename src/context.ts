import type { Context, InputFile } from "grammy";
import type { ConversationFlavor } from "@grammyjs/conversations";

export type MyContext = Context & ConversationFlavor<Context>;

// These take a plain Context (not MyContext) so they also work on the unflavored ctx handed to
// conversation functions and their conversation.wait() results, not just top-level handlers.

// In a forum topic, Telegram auto-attaches reply_to_message to the topic's root message for EVERY
// message sent in that thread, not just genuine user-initiated replies — the giveaway is that the
// attached message's id equals the thread's own message_thread_id, since a topic's thread id is defined
// as its root message's id. Anything that treats "has a reply_to_message" as "the user meant to target
// someone" (reply-based /buy /sell /value targeting, the stock market's reply-price-bump tracking, etc.)
// needs this instead of reading ctx.message.reply_to_message directly, or every message in a non-General
// topic gets misread as a reply to whoever created the topic.
// Default timeout for a pending conversation wait (setTicker/trade/new-round dialogues) — see isNotCommand
// below for why a timeout is needed at all. 15 minutes is generous for anyone actively answering a
// prompt, but bounds how long an abandoned one can keep swallowing ambient chat/price-tracking before the
// @grammyjs/conversations engine auto-halts it on the next incoming update (any type, any chat member).
export const CONVERSATION_TIMEOUT_MS = 15 * 60 * 1000;

// Lets a command sent while a conversation.waitFor("message:text") is pending fall through to the
// bot's normal command handlers instead of being swallowed as an (invalid) answer to the prompt — pass
// as `.and(isNotCommand, { next: true })`. Without this, e.g. starting /buy and then someone sending
// /market gets silently absorbed by the trade dialogue's share-count prompt, and /market never runs.
export function isNotCommand(ctx: Context): boolean {
  return !ctx.message?.text?.startsWith("/");
}

export function realReplyTo(ctx: Context) {
  const repliedTo = ctx.message?.reply_to_message;
  if (!repliedTo) {
    return undefined;
  }
  if (ctx.message?.message_thread_id !== undefined && repliedTo.message_id === ctx.message.message_thread_id) {
    return undefined;
  }
  return repliedTo;
}

// Replies directly to the triggering message (reply arrow + quoted preview), staying in its forum topic thread if it has one.
// Keys are only included when defined, since exactOptionalPropertyTypes rejects an explicit `undefined`.
export function replyToMessage(ctx: Context, message: string) {
  return ctx.reply(message, {
    ...(ctx.message?.message_id !== undefined && { reply_to_message_id: ctx.message.message_id }),
    ...(ctx.message?.message_thread_id !== undefined && { message_thread_id: ctx.message.message_thread_id }),
  });
}

// Posts a new message into the same forum topic thread without quoting a specific message — for replies not tied to one user.
export function replyInThread(ctx: Context, message: string) {
  return ctx.reply(message, {
    ...(ctx.message?.message_thread_id !== undefined && { message_thread_id: ctx.message.message_thread_id }),
  });
}

export function replyHTML(ctx: Context, message: string) {
  return ctx.reply(message, {
    ...(ctx.message?.message_thread_id !== undefined && { message_thread_id: ctx.message.message_thread_id }),
    parse_mode: "HTML",
  });
}

// Replies with a photo, staying in its forum topic thread if it has one. `photo` data must be fresh per call —
// an InputFile can't be reused once sent.
export function replyPhoto(ctx: Context, photo: InputFile, caption?: string) {
  return ctx.replyWithPhoto(photo, {
    ...(caption !== undefined && { caption, parse_mode: "HTML" }),
    ...(ctx.message?.message_thread_id !== undefined && { message_thread_id: ctx.message.message_thread_id }),
  });
}