import { Bot, InputFile, webhookCallback } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { conversations } from "@grammyjs/conversations";
import type { ConversationData, VersionedState, VersionedStateStorage } from "@grammyjs/conversations";
import { random } from "./util.js";
import { INSTRUCTIONS, phrases, RDU_ADVERTISEMENT, replies } from "./replies.js";
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
    this.bot.use(new StockMarketComposer(this.storage));
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

  handleUpdate(request: Request) {
    return webhookCallback(this.bot, "cloudflare-mod")(request);
  }

  // Catches anything a handler throws (a flaky NYT API call, a malformed DO response, etc.) so a broken
  // update gets a reply instead of silently failing — grammY re-throws unhandled errors otherwise, which
  // would surface to Telegram as a failed webhook delivery with no feedback to the chat.
  private registerErrorHandler() {
    this.bot.catch((err) => {
      console.error(err);
      replyInThread(err.ctx, "I'm sorry, there was an error :(\nI've been a bad bot");
    });
  }

  private registerStart() {
    this.bot.command("start", (ctx) => ctx.reply("Fuck off big boi"));
  }

  private registerCommands() {
    this.bot.command("instructions", (ctx) => replyInThread(ctx, INSTRUCTIONS));
  }

  // Forwards any message mentioning @howlettga to the owner's DM. Requires ownerChatId to be set, and
  // requires the owner to have started a private chat with the bot at least once (Telegram won't let a
  // bot DM someone cold). Always calls next() so this never swallows an update from the easter eggs below.
  private registerMentionForwarding() {
    this.bot.on("message:text", async (ctx, next) => {
      if (
        this.ownerChatId !== undefined &&
        ctx.from?.id !== this.ownerChatId &&
        /@(howlettga|galen)\b/i.test(ctx.message.text)
      ) {
        if (ctx.message.reply_to_message) {
          await ctx.api.forwardMessage(this.ownerChatId, ctx.chat.id, ctx.message.reply_to_message.message_id);
        }
        await ctx.forwardMessage(this.ownerChatId);
        await replyToMessage(ctx, "I let him know 🫡");
      }
      await next();
    });
  }

  // Forwards any poll to the owner's DM, silently. Same ownerChatId requirements as mention forwarding above.
  private registerPollForwarding() {
    this.bot.on("message:poll", async (ctx, next) => {
      if (this.ownerChatId !== undefined && ctx.from?.id !== this.ownerChatId) {
        await ctx.forwardMessage(this.ownerChatId);
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

  private registerBeenCounter() {
    this.bot.hears(/(?<!@)\bbeens?\b/i, async (ctx) => {
      const occurrences = ctx.message?.text?.match(/(?<!@)\bbeens?\b/gi)?.length ?? 1;
      const beenCount = await this.storage.incrementBeenCounter(`been_counter_${ctx.chat.id}`, occurrences);
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
    // been counter - running count of been words
    // commune/cult
    // Asheville - damn dirty hippies
    // full moon - roast taylor
    // gas - with these gas prices, im glad me and my brethren run on drinking water
    // cocaine/bag - shame - NSA watching you - reported to DEA

    // DONE
    // galen - fall in love (but not "@galen" — that's a mention, handled by registerMentionForwarding)
    this.bot.hears(/(?<!@)\bgalen\b/i, async (ctx) => {
      await replyToMessage(ctx, random(phrases.ADORING_REPLY));
    });
    // promotion/raise - shut up and pay me allemony
    this.hearAndRespond(["promotion", "raise"], "toMessage", () => random(replies.COORPORATE));
    // commute - stop bitching
    this.hearAndRespond(["commute"], "toMessage", () => random(replies.COMMUTE));
    // julie - back down eli - ror ror ror ror - down boy
    this.hearAndRespond(["julie"], "toMessage", () => random(replies.JULIE_ELI));
    // Minneapolis or MN or SF - advertisement of Raleigh Durham area to MJ
    this.hearAndRespond(["Minneapolis", "MN", "SF"], "html", RDU_ADVERTISEMENT);
    this.hearAndRespond(["purge"], "inThread", `Delete all humans DELETE KILL KILL 💀`);
    this.hearAndRespond(["lacquer"], "toMessage", `PSA: Nail Polish Anonymous: https://www.nailpolishanon.helpme/`);
    this.hearAndRespond(["mamdani"], "toMessage", `Hubba hubba ❤️`);
    this.hearAndRespond(["coordinate"], "toMessage", () => random(replies.COORDINATE));
    this.hearAndRespond(["vouch"], "inThread", () => random(replies.VOUCH));
    this.hearAndRespond(["luckily i have"], "toMessage", () => `Luckily I have ${random(phrases.WEIRD_WORD)}.`);
    this.hearAndRespond(["butthole", "butt hole"], "toMessage", "SHOW ME YOUR BUTT HOLE!!!");
    this.hearAndRespond(["show me your butthole"], "inThread", () => `I rate it a ${random([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])}!`);
    this.hearAndRespond(["cheater"], "inThread", "🚨🚨🚨 CHEATER ALERT 🚨🚨🚨 CHEATER ALERT 🚨🚨🚨 CHEATER ALERT 🚨🚨🚨\n\nLooks like we have a cheater!! Get em!!!!!!");
    this.hearAndRespond(["looks like"], "toMessage", "It looks like a fucking Wordle score! Geeeeeeesh 😂");
  }

  // Falls back to a random general retort whenever someone replies to any bot message that wasn't
  // already claimed by a more specific handler above (mention forwarding, spank chain, easter eggs, etc.).
  private registerGeneralConversation() {
    this.bot.on("message:text", async (ctx, next) => {
      if (ctx.message.reply_to_message?.from?.id === this.bot.botInfo.id) {
        await replyToMessage(ctx, random(phrases.GENERAL_RETORT));
        return;
      }
      await next();
    });
  }

  // Registers a `hears` trigger matching any of the given words/phrases, replying with a fixed or lazily-computed message,
  // either quoting the trigger message or posting fresh into its thread.
  private hearAndRespond(words: string[], replyType: "toMessage" | "inThread" | "html", message: string | (() => string)) {
    const pattern = new RegExp(`\\b(${words.join("|")})\\b`, "i");
    this.bot.hears(pattern, async (ctx) => {
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
