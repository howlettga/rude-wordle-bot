import { Bot, Composer, InputFile, webhookCallback } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { conversations } from "@grammyjs/conversations";
import type { ConversationData, VersionedState, VersionedStateStorage } from "@grammyjs/conversations";
import { random } from "./util.js";
import type { StorageService } from "./storage-service.js";
import { type MyContext, replyToMessage, replyPhoto } from "./context.js";
import { WordleGolfComposer } from "./wordle-golf.js";
import { StockMarketComposer } from "./stock-market.js";
import { RudeComposer } from "./rude.js";
import beenMentionedPhoto from "../assets/beens_mentioned.jpg";
import beenMentionedPhoto2 from "../assets/beens_mentioned_2.jpg";

const BEEN_PHOTOS = [beenMentionedPhoto, beenMentionedPhoto2];

export class RudeBot {
  private bot: Bot<MyContext>;
  private ownerChatId: number | undefined;
  private storage: StorageService;

  constructor(token: string, botInfo: UserFromGetMe, storage: StorageService, ownerChatId?: number) {
    this.bot = new Bot<MyContext>(token, { botInfo });
    this.ownerChatId = ownerChatId;
    this.storage = storage;

    this.registerErrorHandler();

    // Always-on, regardless of pause state: Wordle Golf, and the pause toggle itself (see
    // registerPauseControl). Registered before the gate below, so these never pay the cost of checking it.
    this.bot.use(conversations({ storage: this.conversationStorage() }));
    this.bot.use(new WordleGolfComposer(this.storage));
    this.registerPauseControl();

    // Gated as a unit: /stopmarket makes an entire composer stop responding for that chat, without
    // touching any of its stored state. The stock market and rude composers are gated separately because
    // they sit on either side of the always-on handlers below — the market has to see every message
    // first (activity tracking), and the rude replies have to come last so they never swallow a mention
    // forward or a been/bean count. isChatActive memoizes per update, so anything that reaches both gates
    // still costs only one Durable Object read. Anything resolved above (Wordle, /startmarket,
    // /stopmarket) never pays for it at all.
    const pauseLookups = new WeakMap<MyContext, Promise<boolean>>();
    const isChatActive = async (ctx: MyContext) => {
      if (!ctx.chat) {
        return true;
      }
      let paused = pauseLookups.get(ctx);
      if (!paused) {
        paused = this.storage.isChatPaused(ctx.chat.id);
        pauseLookups.set(ctx, paused);
      }
      return !(await paused);
    };

    this.bot.branch(isChatActive, new StockMarketComposer(this.storage, ownerChatId), this.pausedMarket());

    this.registerStart();
    this.registerMentionForwarding();
    this.registerPollForwarding();
    this.registerBeenCounter();

    this.bot.filter(isChatActive, new RudeComposer(this.storage, botInfo));
  }

  // Stands in for StockMarketComposer while a chat is paused. Buttons sent before /stopmarket (the
  // buy/sell and options pickers, delist/reset confirms) can still be tapped afterwards — answer them so
  // Telegram doesn't leave a spinner on the button until it times out. Everything else passes through.
  private pausedMarket() {
    const composer = new Composer<MyContext>();
    composer.callbackQuery(/^(buy|sell|delist|reset|option_\w+):/, (ctx) =>
      ctx.answerCallbackQuery({ text: "The market is paused right now." })
    );
    return composer;
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

  // Owner-only. /stopmarket silences the stock market and every ambient/rude reply (see the RudeComposer
  // and StockMarketComposer filter above) for this chat — everything except Wordle Golf and the bean/been
  // counter. /startmarket undoes it. Registered directly on the bot (not inside a composer) since it's
  // the control plane for the gate itself and must never be blocked by its own flag.
  private registerPauseControl() {
    this.bot.command("stopmarket", async (ctx) => {
      if (this.ownerChatId === undefined || ctx.from?.id !== this.ownerChatId || !ctx.chat) {
        return;
      }

      await this.storage.setChatPaused(ctx.chat.id, true);
      await replyToMessage(
        ctx,
        "Paused. Wordle and the been/bean count still work — everything else is quiet until /startmarket."
      );
    });

    this.bot.command("startmarket", async (ctx) => {
      if (this.ownerChatId === undefined || ctx.from?.id !== this.ownerChatId || !ctx.chat) {
        return;
      }

      await this.storage.setChatPaused(ctx.chat.id, false);
      await replyToMessage(ctx, "Unpaused. Back to normal.");
    });
  }

  // Forwards any message mentioning @howlettga to the owner's DM. Requires ownerChatId to be set, and
  // requires the owner to have started a private chat with the bot at least once (Telegram won't let a
  // bot DM someone cold). Always calls next() so this never swallows an update from the been counter or
  // the RudeComposer easter eggs registered after it.
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

  // "been"/"beens" increments the tally silently — the word is common enough in normal chat that
  // replying every time would be spammy. Saying "bean"/"beans" instead (a nod to the bot's name)
  // triggers the announcement below, reporting the current tally without bumping it further.
  private registerBeenCounter() {
    this.bot.hears(/(?<!@)\bbeens?\b/i, async (ctx) => {
      const occurrences = ctx.message?.text?.match(/(?<!@)\bbeens?\b/gi)?.length ?? 1;
      await this.storage.incrementBeenCounter(`been_counter_${ctx.chat.id}`, occurrences);
    });

    this.bot.hears(/(?<!@)\bbeans?\b/i, async (ctx) => {
      const occurrences = ctx.message?.text?.match(/(?<!@)\bbeans?\b/gi)?.length ?? 1;
      const [beenCount] = await Promise.all([
        this.storage.incrementBeenCounter(`been_counter_${ctx.chat.id}`, 0),
        this.storage.incrementBeanCounter(`bean_counter_${ctx.chat.id}`, occurrences),
      ]);
      const photo = new InputFile(new Uint8Array(random(BEEN_PHOTOS)), "beens_mentioned.jpg");
      await replyPhoto(ctx, photo, `Been count: <b>${beenCount}</b>`);
    });
  }
}
