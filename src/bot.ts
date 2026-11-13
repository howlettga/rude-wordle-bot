import { Bot, Composer, webhookCallback } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { conversations } from "@grammyjs/conversations";
import type { ConversationData, VersionedState, VersionedStateStorage } from "@grammyjs/conversations";
import type { StorageService } from "./storage-service.js";
import { type MyContext, replyToMessage } from "./context.js";
import { FEATURES, type FeatureFlags, type FeatureKey, resolveFeatures } from "./features.js";
import { FeatureControlComposer } from "./feature-control.js";
import { WordleGolfComposer } from "./wordle-golf.js";
import { StockMarketComposer } from "./stock-market.js";
import { BeanCounterComposer } from "./beans.js";
import { FishingComposer } from "./fishing.js";
import { PetComposer } from "./pet.js";
import { SpicyComposer, EasterEggComposer, RepliesComposer } from "./rude.js";

export class RudeBot {
  private bot: Bot<MyContext>;
  private ownerChatId: number | undefined;
  private storage: StorageService;
  private featureLookups = new WeakMap<MyContext, Promise<FeatureFlags>>();

  constructor(token: string, botInfo: UserFromGetMe, storage: StorageService, ownerChatId?: number) {
    this.bot = new Bot<MyContext>(token, { botInfo });
    this.ownerChatId = ownerChatId;
    this.storage = storage;

    this.registerErrorHandler();

    // Core, never switchable: the conversations plugin (Wordle and market dialogues both run on it), and
    // /features itself, which has to sit ahead of every gate so it can never switch off its own controls.
    this.bot.use(conversations({ storage: this.conversationStorage() }));
    this.bot.use(new FeatureControlComposer(this.storage, ownerChatId));

    // Handler order matters: whichever handler answers first without calling next() ends the update. The
    // market has to see every message early (activity tracking always calls next()); the been/bean counter
    // swallows its words before the rude composers can; and the rude composers come last so an easter egg
    // never swallows a mention forward or a count.
    this.gate("wordle", new WordleGolfComposer(this.storage), /^wordle_/);
    this.gate("market", new StockMarketComposer(this.storage, ownerChatId), /^(buy|sell|delist|reset|option_\w+):/);
    this.gate("fishing", new FishingComposer(this.storage, ownerChatId));
    this.gate("pet", new PetComposer(this.storage, ownerChatId), /^pet:/);

    this.registerStart();
    this.registerMentionForwarding();
    this.registerPollForwarding();

    this.gate("beans", new BeanCounterComposer(this.storage));
    const features = (ctx: MyContext) => this.features(ctx);
    this.gate("spicy", new SpicyComposer(this.storage, botInfo, features));
    this.gate("eastereggs", new EasterEggComposer(this.storage, botInfo, features));
    this.gate("replies", new RepliesComposer(this.storage, botInfo, features));
  }

  // This chat's feature switches, loaded at most once per update no matter how many gates (or handlers,
  // like the spicy-aware easter eggs) ask — one Durable Object read per message, the same cost the old
  // single pause flag had. Lazy, so anything resolved before the first gate never pays for it.
  private features(ctx: MyContext): Promise<FeatureFlags> {
    if (!ctx.chat) {
      return Promise.resolve(resolveFeatures([]));
    }
    let lookup = this.featureLookups.get(ctx);
    if (!lookup) {
      lookup = this.storage.getChatFeatures(ctx.chat.id);
      this.featureLookups.set(ctx, lookup);
    }
    return lookup;
  }

  // Runs `composer` only in chats where `key` is switched on. Switching a feature off never touches its
  // stored state — flipping it back on picks up exactly where it left off. staleButtons matches the
  // feature's inline-keyboard callback data: buttons sent before it was switched off can still be tapped,
  // so they get a short notice instead of a spinner stuck until Telegram times out.
  private gate(key: FeatureKey, composer: Composer<MyContext>, staleButtons?: RegExp) {
    const enabled = async (ctx: MyContext) => (await this.features(ctx))[key].enabled;
    if (!staleButtons) {
      this.bot.filter(enabled, composer);
      return;
    }

    const label = FEATURES.find((feature) => feature.key === key)!.label;
    const off = new Composer<MyContext>();
    off.callbackQuery(staleButtons, (ctx) => ctx.answerCallbackQuery({ text: `${label} is turned off in this chat.` }));
    this.bot.branch(enabled, composer, off);
  }

  // The Worker rebuilds the Bot instance on every request, so the conversations plugin's default
  // in-memory storage would lose its place between one message and the next. This persists it in the
  // per-chat WordleGolf Durable Object instead — plain KV storage, keyed the same way the plugin already
  // keys sessions by default (stringified chat id).
  private conversationStorage(): VersionedStateStorage<string, ConversationData> {
    return {
      read: (key) =>
        this.storage.readWordleGolfSession(Number(key)) as Promise<VersionedState<ConversationData> | undefined>,
      write: (key, state) => this.storage.writeWordleGolfSession(Number(key), state),
      delete: (key) => this.storage.deleteWordleGolfSession(Number(key)),
    };
  }

  // grammY's bot.catch() (registerErrorHandler, below) only gets invoked by Bot.handleUpdates() — the
  // plural, long-polling entry point. webhookCallback() drives the singular Bot.handleUpdate() instead,
  // which wraps a middleware error as BotError and rethrows it, completely bypassing bot.catch(). So for
  // this webhook-based Worker, bot.catch() has never actually caught anything — every unhandled error has
  // always propagated out of fetch() as an uncaught exception, which Cloudflare turns into a 500. Telegram
  // retries non-2xx webhook deliveries, and delivers a chat's updates in order, so one permanently-failing
  // update (e.g. replying to a since-deleted message) can back up everything after it for that chat
  // indefinitely. This try/catch is the actual safety net for webhook mode: whatever happens inside
  // grammY, we always resolve the request normally so Telegram considers the update delivered and moves on.
  async handleUpdate(request: Request): Promise<Response> {
    try {
      return await webhookCallback(this.bot, "cloudflare-mod")(request);
    } catch (err) {
      console.error(err);
      return new Response("OK");
    }
  }

  // Kept for correctness/documentation of intent, and in case this bot ever runs via long polling
  // instead — but see the note on handleUpdate above: this is NOT what protects the webhook deployment.
  // Deliberately doesn't reply into the chat: people hit this from ambient background behavior they never
  // asked for (e.g. a mention triggering a forward Telegram refuses), so an out-of-nowhere "I've been a
  // bad bot" message would just confuse whoever's mid-conversation with no idea anything failed.
  private registerErrorHandler() {
    this.bot.catch((err) => {
      console.error(err);
    });
  }

  private registerStart() {
    this.bot.command("start", (ctx) => ctx.reply("Fuck off big boi"));
  }

  // Forwards any message mentioning @howlettga to the owner's DM. Requires ownerChatId to be set, and
  // requires the owner to have started a private chat with the bot at least once (Telegram won't let a
  // bot DM someone cold). Always calls next() so this never swallows an update from the been counter or
  // the rude composers registered after it.
  // Telegram refuses to forward some messages outright (forum-topic system messages like "X started the
  // topic", content-protected chats, etc.) — that's routine, not a bug, so failures here are caught and
  // skipped quietly rather than thrown: nobody in the chat asked for this forward, so surfacing an error
  // about it would be confusing, and letting it escape unhandled risks a Worker crash (see registerErrorHandler).
  private registerMentionForwarding() {
    this.bot.on("message:text", async (ctx, next) => {
      if (
        this.ownerChatId !== undefined &&
        ctx.from?.id !== this.ownerChatId &&
        /@(howlettga|galen)\b/i.test(ctx.message.text)
      ) {
        try {
          if (ctx.message.reply_to_message) {
            await ctx.api.forwardMessage(this.ownerChatId, ctx.chat.id, ctx.message.reply_to_message.message_id);
          }
          await ctx.forwardMessage(this.ownerChatId);
          await replyToMessage(ctx, "I let him know 🫡");
        } catch (err) {
          console.error(err);
        }
      }
      await next();
    });
  }

  // Forwards any poll to the owner's DM, silently. Same ownerChatId requirements and forward-failure
  // handling as mention forwarding above.
  private registerPollForwarding() {
    this.bot.on("message:poll", async (ctx, next) => {
      if (this.ownerChatId !== undefined && ctx.from?.id !== this.ownerChatId) {
        try {
          await ctx.forwardMessage(this.ownerChatId);
        } catch (err) {
          console.error(err);
        }
      }
      await next();
    });
  }
}
