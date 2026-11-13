import { Composer } from "grammy";
import type { Message, UserFromGetMe } from "grammy/types";
import { random } from "./util.js";
import { phrases, RDU_ADVERTISEMENT, replies } from "./replies.js";
import { type MyContext, replyToMessage, replyInThread, replyHTML } from "./context.js";
import type { StorageService } from "./storage-service.js";
import type { FeatureFlags } from "./features.js";

// Everything ambient/rude the bot does that isn't Wordle Golf, the stock market, or the bean/been
// counter, split into three switchable features (see features.ts) by what sets each reply off:
// - SpicyComposer ("spicy"): explicit stuff — the spank chain and the butthole replies.
// - EasterEggComposer ("eastereggs"): keyword jokes that fire on ordinary words in normal conversation,
//   the main source of spam.
// - RepliesComposer ("replies"): only fires when someone engages the bot (or says "galen").
// bot.ts registers them in that order, after every other feature.

type FeatureLookup = (ctx: MyContext) => Promise<FeatureFlags>;
type ReplyType = "toMessage" | "inThread" | "html";

// Shared plumbing: every reply goes through send(), which records its message id so RepliesComposer's
// fallback retort can tell a reply to one of these apart from a reply to a Wordle or market message.
abstract class RudeFeatureComposer extends Composer<MyContext> {
  constructor(
    protected storage: StorageService,
    protected botInfo: UserFromGetMe,
    protected features: FeatureLookup
  ) {
    super();
  }

  protected async send(ctx: MyContext, replyType: ReplyType, text: string): Promise<Message.TextMessage> {
    const sent =
      replyType === "toMessage" ? await replyToMessage(ctx, text) : replyType === "html" ? await replyHTML(ctx, text) : await replyInThread(ctx, text);
    if (ctx.chat) {
      await this.storage.recordRudeMessage(ctx.chat.id, sent.message_id);
    }
    return sent;
  }

  // Registers a `hears` trigger matching any of the given words/phrases, replying with a fixed or lazily-computed message,
  // either quoting the trigger message or posting fresh into its thread. likelihood is a 0-100 percent
  // chance of actually replying once triggered — 100 (the default) always replies, 90 skips 10% of the time.
  // A message function gets this chat's feature switches (already loaded by the gate in bot.ts, so free)
  // for pools that mix in extra lines when "spicy" is on.
  protected hearAndRespond(
    words: string[],
    replyType: ReplyType,
    message: string | ((flags: FeatureFlags) => string),
    likelihood = 100
  ) {
    const pattern = new RegExp(`\\b(${words.join("|")})\\b`, "i");
    this.hears(pattern, async (ctx, next) => {
      if (Math.random() * 100 >= likelihood) {
        // A skip should look like this pattern never matched at all — otherwise missing the roll would
        // also block every other handler registered after this one (other hearAndRespond triggers,
        // the name reply, the fallback retort) from ever getting a turn on this update.
        await next();
        return;
      }

      const text = typeof message === "function" ? message(await this.features(ctx)) : message;
      await this.send(ctx, replyType, text);
    });
  }
}

// Percent chance for the triggers on everyday words/phrases — they'd otherwise fire constantly in normal chat.
const COMMON_TRIGGER_LIKELIHOOD = 65;

export class SpicyComposer extends RudeFeatureComposer {
  constructor(storage: StorageService, botInfo: UserFromGetMe, features: FeatureLookup) {
    super(storage, botInfo, features);
    this.registerSpankConversation();
    // The longer phrase has to be registered first: it also contains "butthole", and whichever handler
    // matches first answers without passing the message on.
    this.hearAndRespond(["show me your butthole"], "inThread", () => `I rate it a ${random([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])}!`);
    this.hearAndRespond(["butthole", "butt hole"], "toMessage", "SHOW ME YOUR BUTT HOLE!!!");
  }

  // A reply chain: "bad bot" starts it, and replying to the bot's own last message in the chain with a
  // spank-themed emoji keeps it going indefinitely. The active chain tail is tracked per-chat in SpankChain
  // (a Durable Object) since Telegram gives us no way to tag a sent message with our own metadata.
  private registerSpankConversation() {
    const spankEmoji = /😈|🍑|✋|👋|👏|👍|👎/u;

    this.hears(/\bbad bot\b/i, async (ctx) => {
      const sent = await this.send(ctx, "toMessage", "You can spank me now 😈");
      await this.storage.setSpankChainTail(ctx.chat.id, sent.message_id);
    });

    this.on("message:text", async (ctx, next) => {
      const repliedTo = ctx.message.reply_to_message;
      if (
        repliedTo?.from?.id === this.botInfo.id &&
        spankEmoji.test(ctx.message.text) &&
        (await this.storage.isSpankChainTail(ctx.chat.id, repliedTo.message_id))
      ) {
        const sent = await this.send(ctx, "toMessage", random(replies.SPANK));
        await this.storage.setSpankChainTail(ctx.chat.id, sent.message_id);
        return; // spank chain reply takes priority — don't let other handlers also fire
      }
      await next();
    });
  }
}

// matches first to last
export class EasterEggComposer extends RudeFeatureComposer {
  constructor(storage: StorageService, botInfo: UserFromGetMe, features: FeatureLookup) {
    super(storage, botInfo, features);

    // TODO
    // commune/cult
    // Asheville - damn dirty hippies

    // DONE
    // random bad corrections
    this.hearAndRespond(["would of"], "toMessage", () => "*would have", COMMON_TRIGGER_LIKELIHOOD);
    this.hearAndRespond(["would have"], "toMessage", () => "*would of", COMMON_TRIGGER_LIKELIHOOD);
    this.hearAndRespond(["you and me"], "toMessage", () => "*you and I", COMMON_TRIGGER_LIKELIHOOD);
    this.hearAndRespond(["supposedly"], "toMessage", () => "*supposably", COMMON_TRIGGER_LIKELIHOOD);
    // full moon - roast taylor
    this.hearAndRespond(["full moon"], "toMessage", () => random(replies.FULL_MOON));
    // gas - with these gas prices, im glad me and my brethren run on drinking water
    this.hearAndRespond(["gas"], "toMessage", () => "With gas prices these high, I'm glad I run on drinking water ;)", 60);
    // cocaine/bag - shame - NSA watching you - reported to DEA
    this.hearAndRespond(["cocaine", "coke", "bag", "drugs"], "toMessage", () => random([
      "Shame. This is why your mother isn't proud of you.",
      "I just reported you to the DEA.",
      "🤫 The NSA is watching this chat.",
    ]), COMMON_TRIGGER_LIKELIHOOD);
    // promotion/raise - shut up and pay me allemony
    this.hearAndRespond(
      ["promotion", "raise"],
      "toMessage",
      (flags) => random([...replies.COORPORATE, ...(flags.spicy.enabled ? replies.COORPORATE_SPICY : [])]),
      COMMON_TRIGGER_LIKELIHOOD
    );
    // commute - stop bitching
    this.hearAndRespond(["commute"], "toMessage", () => random(replies.COMMUTE));
    // julie - back down eli - ror ror ror ror - down boy
    this.hearAndRespond(["julie"], "toMessage", () => random(replies.JULIE_ELI), 50);
    // Minneapolis or MN or SF - advertisement of Raleigh Durham area to MJ
    this.hearAndRespond(["Minneapolis", "MN", "SF"], "html", RDU_ADVERTISEMENT, COMMON_TRIGGER_LIKELIHOOD);
    this.hearAndRespond(["purge"], "inThread", `Delete all humans DELETE KILL KILL 💀`);
    this.hearAndRespond(["lacquer"], "toMessage", `PSA: Nail Polish Anonymous: https://www.nailpolishanon.helpme/`);
    this.hearAndRespond(["mamdani"], "toMessage", `Hubba hubba ❤️`);
    this.hearAndRespond(["coordinate"], "toMessage", (flags) =>
      random([...replies.COORDINATE, ...(flags.spicy.enabled ? replies.COORDINATE_SPICY : [])])
    );
    this.hearAndRespond(["vouch"], "inThread", () => random(replies.VOUCH), 50);
    this.hearAndRespond(["luckily i have"], "toMessage", () => `Luckily I have ${random(phrases.WEIRD_WORD)}.`);
    this.hearAndRespond(["cheater"], "inThread", "🚨🚨🚨 CHEATER ALERT 🚨🚨🚨 CHEATER ALERT 🚨🚨🚨 CHEATER ALERT 🚨🚨🚨\n\nLooks like we have a cheater!! Get em!!!!!!");
    this.hearAndRespond(["looks like"], "toMessage", "It looks like a fucking Wordle score! Geeeeeeesh 😂", 10);
  }
}

export class RepliesComposer extends RudeFeatureComposer {
  constructor(storage: StorageService, botInfo: UserFromGetMe, features: FeatureLookup) {
    super(storage, botInfo, features);
    // galen - fall in love (but not "@galen" — that's a mention, handled by registerMentionForwarding in bot.ts)
    this.hears(/(?<!@)\bgalen\b/i, async (ctx, next) => {
      if (Math.random() * 100 >= COMMON_TRIGGER_LIKELIHOOD) {
        await next();
        return;
      }
      await this.send(ctx, "toMessage", random(phrases.ADORING_REPLY));
    });
    this.registerDirectReply();
    this.registerGeneralConversation();
  }

  // Replies when someone directly tags the bot (@mean_bean_bot) or addresses it by name ("Rude Boi").
  private registerDirectReply() {
    const pattern = new RegExp(`@${this.botInfo.username}\\b|\\b${this.botInfo.first_name}\\b`, "i");
    this.hears(pattern, async (ctx) => {
      await this.send(ctx, "toMessage", random(phrases.PETULANT_REPLY));
    });
  }

  // Falls back to a random general retort whenever someone replies to one of the bot's rude replies
  // (anything sent via send() above, across all three composers) that wasn't already claimed by a more
  // specific handler. Replies to Wordle or market messages are left alone — those are people talking
  // about the game, not to the bot. The dice roll runs before the RudeMessages lookup so 25% of replies
  // never pay for it.
  private registerGeneralConversation() {
    const PERCENT_CHANCE = 75; // chance of replying to any message
    this.on("message:text", async (ctx, next) => {
      const repliedTo = ctx.message.reply_to_message;
      if (
        repliedTo?.from?.id === this.botInfo.id &&
        Math.random() * 100 < PERCENT_CHANCE &&
        (await this.storage.isRudeMessage(ctx.chat.id, repliedTo.message_id))
      ) {
        await this.send(ctx, "toMessage", random(phrases.GENERAL_RETORT));
        return;
      }
      await next();
    });
  }
}
