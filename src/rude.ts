import { Composer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { random } from "./util.js";
import { phrases, RDU_ADVERTISEMENT, replies } from "./replies.js";
import { type MyContext, replyToMessage, replyInThread, replyHTML } from "./context.js";
import type { StorageService } from "./storage-service.js";

// Everything ambient/rude the bot does that isn't Wordle Golf, the stock market, or the bean/been
// counter — the spank chain, easter eggs, direct replies, and the general fallback retort. Grouped as
// its own composer so it can be toggled on/off as a unit (see RudeBot's use of Composer.filter).
export class RudeComposer extends Composer<MyContext> {
  constructor(
    private storage: StorageService,
    private botInfo: UserFromGetMe
  ) {
    super();
    this.registerSpankConversation();
    this.registerEasterEggs();
    this.registerDirectReply();
    this.registerGeneralConversation();
  }

  // A reply chain: "bad bot" starts it, and replying to the bot's own last message in the chain with a
  // spank-themed emoji keeps it going indefinitely. The active chain tail is tracked per-chat in SpankChain
  // (a Durable Object) since Telegram gives us no way to tag a sent message with our own metadata.
  private registerSpankConversation() {
    const spankEmoji = /😈|🍑|✋|👋|👏|👍|👎/u;

    this.hears(/\bbad bot\b/i, async (ctx) => {
      const sent = await replyToMessage(ctx, "You can spank me now 😈");
      await this.storage.setSpankChainTail(ctx.chat.id, sent.message_id);
    });

    this.on("message:text", async (ctx, next) => {
      const repliedTo = ctx.message.reply_to_message;
      if (
        repliedTo?.from?.id === this.botInfo.id &&
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
    this.hears(/(?<!@)\bgalen\b/i, async (ctx) => {
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

  // Replies when someone directly tags the bot (@mean_bean_bot) or addresses it by name ("Rude Boi").
  private registerDirectReply() {
    const pattern = new RegExp(`@${this.botInfo.username}\\b|\\b${this.botInfo.first_name}\\b`, "i");
    this.hears(pattern, async (ctx) => {
      await replyToMessage(ctx, random(phrases.PETULANT_REPLY));
    });
  }

  // Falls back to a random general retort whenever someone replies to any bot message that wasn't
  // already claimed by a more specific handler above (mention forwarding, spank chain, easter eggs, etc.).
  private registerGeneralConversation() {
    const PERCENT_CHANCE = 75; // chance of replying to any message
    this.on("message:text", async (ctx, next) => {
      if (ctx.message.reply_to_message?.from?.id === this.botInfo.id && Math.random() * 100 < PERCENT_CHANCE) {
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
    this.hears(pattern, async (ctx, next) => {
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
