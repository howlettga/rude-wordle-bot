import { Composer, InlineKeyboard } from "grammy";
import { type MyContext, replyToMessage } from "./context.js";
import type { StorageService } from "./storage-service.js";
import { FEATURES, type FeatureFlags, isFeatureKey } from "./features.js";

// Owner-only, invisible (not in the / menu — see the README's "Invisible commands"). Per-chat feature
// switches, run inside the chat they apply to:
//   /features                  -> one button per feature (✅ on / ❌ off); tap to flip it
//   /features <key> on|off     -> same thing typed out, e.g. /features eastereggs off
// Registered in bot.ts before any feature gate, so it can never switch off its own controls. Anyone
// else running it gets no response, same as the other owner commands; anyone else tapping a button
// gets a short "owner only" notice, since the buttons are visible to the whole chat.
//
// Everything this posts is visible to the whole chat, and some features are meant to be discovered, not
// advertised (easter eggs, spicy) — so it only ever shows bare keys and on/off, never labels or
// descriptions. What each key covers is documented in the README's "Feature switches" section.
const CALLBACK_PREFIX = "features:toggle:";

export class FeatureControlComposer extends Composer<MyContext> {
  constructor(
    private storage: StorageService,
    private ownerChatId: number | undefined
  ) {
    super();
    this.command("features", (ctx) => this.handleCommand(ctx));
    this.callbackQuery(new RegExp(`^${CALLBACK_PREFIX}(\\w+)$`), (ctx) => this.handleToggle(ctx));
  }

  private isOwner(ctx: MyContext): boolean {
    return this.ownerChatId !== undefined && ctx.from?.id === this.ownerChatId;
  }

  private async handleCommand(ctx: MyContext) {
    if (!this.isOwner(ctx) || !ctx.chat) {
      return;
    }

    const args = String(ctx.match ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (args.length === 0) {
      const flags = await this.storage.getChatFeatures(ctx.chat.id);
      await ctx.reply("Settings", {
        reply_markup: this.menuKeyboard(flags),
        ...(ctx.message?.message_thread_id !== undefined && { message_thread_id: ctx.message.message_thread_id }),
      });
      return;
    }

    const [key, state] = args;
    if (args.length !== 2 || !key || !isFeatureKey(key) || (state !== "on" && state !== "off")) {
      await replyToMessage(ctx, "Usage: /features <key> on|off");
      return;
    }

    await this.storage.setChatFeature(ctx.chat.id, key, state === "on");
    await replyToMessage(ctx, "Done.");
  }

  private async handleToggle(ctx: MyContext) {
    if (!this.isOwner(ctx) || !ctx.chat) {
      await ctx.answerCallbackQuery({ text: "Only the owner can change these." });
      return;
    }

    const key = ctx.match?.[1];
    if (!key || !isFeatureKey(key)) {
      await ctx.answerCallbackQuery({ text: "That feature doesn't exist anymore." });
      return;
    }

    const before = await this.storage.getChatFeatures(ctx.chat.id);
    const enabled = !before[key].enabled;
    await this.storage.setChatFeature(ctx.chat.id, key, enabled);

    const after: FeatureFlags = { ...before, [key]: { ...before[key], enabled } };
    await ctx.editMessageReplyMarkup({ reply_markup: this.menuKeyboard(after) });
    await ctx.answerCallbackQuery();
  }

  // One button per row. Built from rows directly rather than text().row() in a loop, which leaves an
  // empty trailing row in the payload.
  private menuKeyboard(flags: FeatureFlags): InlineKeyboard {
    return InlineKeyboard.from(
      FEATURES.map((feature) => [
        InlineKeyboard.text(`${flags[feature.key].enabled ? "✅" : "❌"} ${feature.key}`, `${CALLBACK_PREFIX}${feature.key}`),
      ])
    );
  }
}
