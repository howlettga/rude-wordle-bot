import type { Context, InputFile } from "grammy";
import type { ConversationFlavor } from "@grammyjs/conversations";

export type MyContext = Context & ConversationFlavor<Context>;

// These take a plain Context (not MyContext) so they also work on the unflavored ctx handed to
// conversation functions and their conversation.wait() results, not just top-level handlers.

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