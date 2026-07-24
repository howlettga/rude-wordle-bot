import { Bot, Context, webhookCallback, type BotConfig } from "grammy";
import type { ConversationFlavor } from "@grammyjs/conversations";
import type { UserFromGetMe } from "grammy/types";
import { random } from "./util.js";
import { INSTRUCTIONS, phrases, RDU_ADVERTISEMENT, replies } from "./replies.js";

type MyContext = Context & ConversationFlavor<Context>;

export class RudeBot {
  private bot: Bot<MyContext>;
  private ownerChatId: number | undefined;

  constructor(token: string, botInfo: UserFromGetMe, ownerChatId?: number) {
    this.bot = new Bot<MyContext>(token, { botInfo });
    this.ownerChatId = ownerChatId;

    this.registerStart();
    this.registerCommands();
    this.registerMentionForwarding();
    this.registerDirectReply();
    this.registerEasterEggs();
  }

  handleUpdate(request: Request) {
    return webhookCallback(this.bot, "cloudflare-mod")(request);
  }

  // Replies directly to the triggering message (reply arrow + quoted preview), staying in its forum topic thread if it has one.
  // Keys are only included when defined, since exactOptionalPropertyTypes rejects an explicit `undefined`.
  private replyToMessage(ctx: MyContext, message: string) {
    return ctx.reply(message, {
      ...(ctx.message?.message_id !== undefined && { reply_to_message_id: ctx.message.message_id }),
      ...(ctx.message?.message_thread_id !== undefined && { message_thread_id: ctx.message.message_thread_id }),
    });
  }

  // Posts a new message into the same forum topic thread without quoting a specific message — for replies not tied to one user.
  private replyInThread(ctx: MyContext, message: string) {
    return ctx.reply(message, {
      ...(ctx.message?.message_thread_id !== undefined && { message_thread_id: ctx.message.message_thread_id }),
    });
  }

  private replyHTML(ctx: MyContext, message: string) {
    return ctx.reply(message, {
      ...(ctx.message?.message_thread_id !== undefined && { message_thread_id: ctx.message.message_thread_id }),
      parse_mode: "HTML",
    });
  }

  // Registers a `hears` trigger matching any of the given words/phrases, replying with a fixed or lazily-computed message,
  // either quoting the trigger message or posting fresh into its thread.
  private hearAndRespond(words: string[], replyType: "toMessage" | "inThread" | "html", message: string | (() => string)) {
    const pattern = new RegExp(`\\b(${words.join("|")})\\b`, "i");
    this.bot.hears(pattern, async (ctx) => {
      const text = typeof message === "function" ? message() : message;
      if (replyType === "toMessage") {
        await this.replyToMessage(ctx, text);
      } else if (replyType === "html") {
        await this.replyHTML(ctx, text);
      } else {
        await this.replyInThread(ctx, text);
      }
    });
  }

  private registerStart() {
    this.bot.command("start", (ctx) => ctx.reply("Fuck off big boi"));
  }

  private registerCommands() {
    this.bot.command("wordle", (ctx) => this.replyToMessage(ctx, random(phrases.PETULANT_REPLY)));
    this.bot.command("instructions", (ctx) => this.replyInThread(ctx, INSTRUCTIONS));
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
        await this.replyToMessage(ctx, "I let him know 🫡");
      }
      await next();
    });
  }

  // Replies when someone directly tags the bot (@mean_bean_bot) or addresses it by name ("Rude Boi").
  private registerDirectReply() {
    const pattern = new RegExp(`@${this.bot.botInfo.username}\\b|\\b${this.bot.botInfo.first_name}\\b`, "i");
    this.bot.hears(pattern, async (ctx) => {
      await this.replyToMessage(ctx, random(phrases.PETULANT_REPLY));
    });
  }

  // private registerEcho() {
  //   this.bot.on("message:text", (ctx) => this.replyToMessage(ctx, `You said: ${ctx.message.text}`));
  // }

  // matches first to last
  private registerEasterEggs() {
    // TODO
    // been counter - running count of been words
    // commune/cult
    // Asheville - damn dirty hippies
    // full moon - roast taylor
    // gas - with these gas prices, im glad me and my brethren run on drinking water

    // DONE
    // galen - fall in love (but not "@galen" — that's a mention, handled by registerMentionForwarding)
    this.bot.hears(/(?<!@)\bgalen\b/i, async (ctx) => {
      await this.replyToMessage(ctx, random(phrases.ADORING_REPLY));
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
    // i would rate it (butthole) [1-10]
    // this.bot.hears(/.*\bbad bot\b.*/i, async (ctx) => {
    //   const msg = await this.replyOne("You can spank me now 😈", ctx);
    //   this.spankRequests.init.push({ message_id: msg.message_id, thread_id: ctx.message?.message_thread_id });
    // }); // add spank reaction reaction
    this.bot.hears(/.*\blooks like\b.*/i, async (ctx) => {
      ctx.reply("It looks like a fucking Wordle score! Geeeeeeesh 😂", {
        reply_parameters: {
          message_id: ctx.message!.message_id,
        },
        message_thread_id: ctx.message?.message_thread_id || 0,
      });
    });
  }

}
