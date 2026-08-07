import { Bot, InputFile, webhookCallback } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { conversations } from "@grammyjs/conversations";
import type { ConversationData, VersionedState, VersionedStateStorage } from "@grammyjs/conversations";
import { random } from "./util.js";
import { WORDLE_INSTRUCTIONS, MARKET_INSTRUCTIONS, phrases, RDU_ADVERTISEMENT, replies } from "./replies.js";
import type { StorageService } from "./storage-service.js";
import { type MyContext, replyToMessage, replyInThread, replyHTML, replyPhoto } from "./context.js";
import { WordleGolfComposer } from "./wordle-golf.js";
import { StockMarketComposer } from "./stock-market.js";
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

    this.bot.use(conversations({ storage: this.conversationStorage() }));
    this.bot.use(new WordleGolfComposer(this.storage));
    this.bot.use(new StockMarketComposer(this.storage, ownerChatId));
    // this.hearAndRespond(["value"], "toMessage", () => "Check your worth with the /portfolio command.");
    // this.hearAndRespond(["market"], "toMessage", () => "Check the market with the /market command.");
    this.registerErrorHandler();

    this.registerStart();
    this.registerCommands();
    this.registerMentionForwarding();
    this.registerPollForwarding();
    this.registerBeenCounter();
    this.registerSpankConversation();
    this.registerEasterEggs();
    this.registerDirectReply();
    this.registerGeneralConversation();
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

  private registerCommands() {
    this.bot.command("instructions", (ctx) => replyInThread(ctx, WORDLE_INSTRUCTIONS));
    this.bot.command("marketrules", (ctx) => replyInThread(ctx, MARKET_INSTRUCTIONS));
    this.registerRestart();
    this.registerSetMarketThread();
    this.registerSetOptionsGuard();
  }

  // Owner-only. Cron-driven market announcements (the trading-halt notice, and any future ones) default
  // to the General topic / main chat since they're not a reply to anyone. Run this inside the topic you
  // want them to land in instead — captures that topic's message_thread_id and stores it per chat.
  // Running it outside any topic (e.g. in General) clears the preference back to the default.
  private registerSetMarketThread() {
    this.bot.command("setmarketthread", async (ctx) => {
      if (this.ownerChatId === undefined || ctx.from?.id !== this.ownerChatId || !ctx.chat) {
        return;
      }

      const threadId = ctx.message?.message_thread_id ?? null;
      await this.storage.setStockMarketAnnouncementThread(ctx.chat.id, threadId);
      await replyToMessage(
        ctx,
        threadId !== null
          ? "Market announcements will now be posted in this thread."
          : "Market announcements will now be posted in the main chat."
      );
    });
  }

  // Owner-only, per-chat. Off by default — self-pumping your own option via a big buy order is
  // deliberately allowed chaos (see TRADE_BASE_IMPACT_PCT in the stock market DO) — this is the escape
  // hatch if it ever gets out of hand for a specific chat, not a permanent rule change.
  private registerSetOptionsGuard() {
    this.bot.command("setoptionsguard", async (ctx) => {
      if (this.ownerChatId === undefined || ctx.from?.id !== this.ownerChatId || !ctx.chat) {
        return;
      }

      const arg = String(ctx.match ?? "").trim().toLowerCase();
      if (arg !== "on" && arg !== "off") {
        await replyToMessage(ctx, "Usage: /setoptionsguard on|off");
        return;
      }

      await this.storage.setStockMarketOptionsGuard(ctx.chat.id, arg === "on");
      await replyToMessage(
        ctx,
        arg === "on"
          ? "Anti-pump guard is ON — can't trade shares of anyone you're holding an open option on."
          : "Anti-pump guard is OFF — pump away."
      );
    });
  }

  // Owner-only full wipe of this chat's stock market — every player, holding, and price event, gone.
  // For clearing out an economy corrupted by a bug (e.g. the topic-auto-reply mismeasurement fixed
  // alongside this) rather than correcting people one at a time, which /delist and /reset (both now
  // registered on StockMarketComposer itself, alongside /buy and /sell) already cover.
  private registerRestart() {
    this.bot.command("restart", async (ctx) => {
      if (this.ownerChatId === undefined || ctx.from?.id !== this.ownerChatId || !ctx.chat) {
        return;
      }

      await this.storage.restartStockMarket(ctx.chat.id);
      await replyToMessage(ctx, "The market has been reset. Everyone starts fresh from here.");
    });
  }

  // Forwards any message mentioning @howlettga to the owner's DM. Requires ownerChatId to be set, and
  // requires the owner to have started a private chat with the bot at least once (Telegram won't let a
  // bot DM someone cold). Always calls next() so this never swallows an update from the easter eggs below.
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

  // Replies when someone directly tags the bot (@mean_bean_bot) or addresses it by name ("Rude Boi").
  private registerDirectReply() {
    const pattern = new RegExp(`@${this.bot.botInfo.username}\\b|\\b${this.bot.botInfo.first_name}\\b`, "i");
    this.bot.hears(pattern, async (ctx) => {
      await replyToMessage(ctx, random(phrases.PETULANT_REPLY));
    });
  }

  // private registerEcho() {
  //   this.bot.on("message:text", (ctx) => replyToMessage(ctx, `You said: ${ctx.message.text}`));
  // }

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

  // A reply chain: "bad bot" starts it, and replying to the bot's own last message in the chain with a
  // spank-themed emoji keeps it going indefinitely. The active chain tail is tracked per-chat in SpankChain
  // (a Durable Object) since Telegram gives us no way to tag a sent message with our own metadata.
  private registerSpankConversation() {
    const spankEmoji = /😈|🍑|✋|👋|👏|👍|👎/u;

    this.bot.hears(/\bbad bot\b/i, async (ctx) => {
      const sent = await replyToMessage(ctx, "You can spank me now 😈");
      await this.storage.setSpankChainTail(ctx.chat.id, sent.message_id);
    });

    this.bot.on("message:text", async (ctx, next) => {
      const repliedTo = ctx.message.reply_to_message;
      if (
        repliedTo?.from?.id === this.bot.botInfo.id &&
        spankEmoji.test(ctx.message.text) &&
        (await this.storage.isSpankChainTail(ctx.chat.id, repliedTo.message_id))
      ) {
        const sent = await replyToMessage(ctx, random(replies.SPANK));
        await this.storage.setSpankChainTail(ctx.chat.id, sent.message_id);
        return; // spank chain reply takes priority — don't let other handlers also fire
      }
      await next();
    });
  }

  // matches first to last
  private registerEasterEggs() {
    // TODO
    // commune/cult
    // Asheville - damn dirty hippies

    // DONE
    // random bad corrections
    this.hearAndRespond(["would of"], "toMessage", () => "*would have");
    this.hearAndRespond(["would have"], "toMessage", () => "*would of");
    this.hearAndRespond(["you and me"], "toMessage", () => "*you and I");
    this.hearAndRespond(["supposedly"], "toMessage", () => "*supposably");
    // full moon - roast taylor
    this.hearAndRespond(["full moon"], "toMessage", () => random(replies.FULL_MOON));
    // gas - with these gas prices, im glad me and my brethren run on drinking water
    this.hearAndRespond(["gas"], "toMessage", () => "With gas prices these high, I'm glad I run on drinking water ;)", 60);
    // cocaine/bag - shame - NSA watching you - reported to DEA
    this.hearAndRespond(["cocaine", "coke", "bag", "drugs"], "toMessage", () => random([
      "Shame. This is why your mother isn't proud of you.",
      "I just reported you to the DEA.",
      "🤫 The NSA is watching this chat.",
    ]), 80);
    // galen - fall in love (but not "@galen" — that's a mention, handled by registerMentionForwarding)
    this.bot.hears(/(?<!@)\bgalen\b/i, async (ctx) => {
      await replyToMessage(ctx, random(phrases.ADORING_REPLY));
    });
    // promotion/raise - shut up and pay me allemony
    this.hearAndRespond(["promotion", "raise"], "toMessage", () => random(replies.COORPORATE));
    // commute - stop bitching
    this.hearAndRespond(["commute"], "toMessage", () => random(replies.COMMUTE));
    // julie - back down eli - ror ror ror ror - down boy
    this.hearAndRespond(["julie"], "toMessage", () => random(replies.JULIE_ELI), 50);
    // Minneapolis or MN or SF - advertisement of Raleigh Durham area to MJ
    this.hearAndRespond(["Minneapolis", "MN", "SF"], "html", RDU_ADVERTISEMENT);
    this.hearAndRespond(["purge"], "inThread", `Delete all humans DELETE KILL KILL 💀`);
    this.hearAndRespond(["lacquer"], "toMessage", `PSA: Nail Polish Anonymous: https://www.nailpolishanon.helpme/`);
    this.hearAndRespond(["mamdani"], "toMessage", `Hubba hubba ❤️`);
    this.hearAndRespond(["coordinate"], "toMessage", () => random(replies.COORDINATE));
    this.hearAndRespond(["vouch"], "inThread", () => random(replies.VOUCH), 50);
    this.hearAndRespond(["luckily i have"], "toMessage", () => `Luckily I have ${random(phrases.WEIRD_WORD)}.`);
    this.hearAndRespond(["butthole", "butt hole"], "toMessage", "SHOW ME YOUR BUTT HOLE!!!");
    this.hearAndRespond(["show me your butthole"], "inThread", () => `I rate it a ${random([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])}!`);
    this.hearAndRespond(["cheater"], "inThread", "🚨🚨🚨 CHEATER ALERT 🚨🚨🚨 CHEATER ALERT 🚨🚨🚨 CHEATER ALERT 🚨🚨🚨\n\nLooks like we have a cheater!! Get em!!!!!!");
    this.hearAndRespond(["looks like"], "toMessage", "It looks like a fucking Wordle score! Geeeeeeesh 😂", 10);
  }

  // Falls back to a random general retort whenever someone replies to any bot message that wasn't
  // already claimed by a more specific handler above (mention forwarding, spank chain, easter eggs, etc.).
  private registerGeneralConversation() {
    const PERCENT_CHANCE = 75; // chance of replying to any message
    this.bot.on("message:text", async (ctx, next) => {
      if (ctx.message.reply_to_message?.from?.id === this.bot.botInfo.id && Math.random() * 100 < PERCENT_CHANCE) {
        await replyToMessage(ctx, random(phrases.GENERAL_RETORT));
        return;
      }
      await next();
    });
  }

  // Registers a `hears` trigger matching any of the given words/phrases, replying with a fixed or lazily-computed message,
  // either quoting the trigger message or posting fresh into its thread. likelihood is a 0-100 percent
  // chance of actually replying once triggered — 100 (the default) always replies, 90 skips 10% of the time.
  private hearAndRespond(words: string[], replyType: "toMessage" | "inThread" | "html", message: string | (() => string), likelihood = 100) {
    const pattern = new RegExp(`\\b(${words.join("|")})\\b`, "i");
    this.bot.hears(pattern, async (ctx, next) => {
      if (Math.random() * 100 >= likelihood) {
        // A skip should look like this pattern never matched at all — otherwise missing the roll would
        // also block every other handler registered after this one (other hearAndRespond triggers,
        // registerDirectReply, registerGeneralConversation) from ever getting a turn on this update.
        await next();
        return;
      }

      const text = typeof message === "function" ? message() : message;
      if (replyType === "toMessage") {
        await replyToMessage(ctx, text);
      } else if (replyType === "html") {
        await replyHTML(ctx, text);
      } else {
        await replyInThread(ctx, text);
      }
    });
  }

}
