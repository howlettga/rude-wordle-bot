import { Composer, InlineKeyboard } from "grammy";
import type { Api, Context, Filter, NextFunction } from "grammy";
import { createConversation } from "@grammyjs/conversations";
import type { Conversation } from "@grammyjs/conversations";
import { type MyContext, replyToMessage, replyHTML, realReplyTo, isNotCommand, CONVERSATION_TIMEOUT_MS } from "./context.js";
import { random } from "./util.js";
import type { StorageService } from "./storage-service.js";
import type {
  StockMarketPlayer,
  StockMarketPortfolio,
  StockMarketSetTickerResult,
  StockMarketTradeErrorType,
  StockMarketTradeResult,
  StockMarketOptionStrikePct,
  StockMarketOptionDurationDays,
  StockMarketBuyOptionResult,
} from "./durable-objects/stock-market.js";

// Inside a conversation, ctx is always the plain (unflavored) Context — same pattern as wordle-golf.ts.
type ConversationContext = Context;
type MyConversation = Conversation<MyContext, ConversationContext>;

// A ticker-holder in the middle of a /buy or /sell conversation's picker — carried through from the
// keyboard selection straight to trade execution, so there's no need to re-look-up the target by ticker.
type TickerOption = { ticker: string; userId: number; firstName: string };

const SET_TICKER_CONVERSATION = "stock-market-set-ticker";
const TRADE_CONVERSATION = "stock-market-trade";
const OPTIONS_CONVERSATION = "stock-market-options";
const EXIT_KEYWORDS = new Set(["stop", "quit", "exit", "end", "cancel"]);
const TICKER_PATTERN = /^[A-Za-z]{1,4}$/;

const OPTIONS_BLURB =
  "📈 Long Call Selected.\n - A long call option lets you pay a small fee to bet a stock's price will go up.\n\n" +
  "Pick a stock, a strike, and a duration, then pay the premium up front — if that " +
  "stock's price finishes above your strike when the contract expires (always at the next 5pm ET rollover " +
  "after your chosen duration), you collect the difference. Otherwise it expires worthless: no refunds, no " +
  "exercising early, and you can never go negative — the premium is the most you can ever lose. Which stock?";

const OPTIONS_ITM_MESSAGES: ((buyer: string, underlying: string, payout: number) => string)[] = [
  (buyer, underlying, payout) => `📈 ${buyer}'s call on ${underlying} finished ITM. +$${payout.toFixed(2)}. Even a broken clock.`,
  (buyer, underlying, payout) => `💰 ${buyer} correctly bet on ${underlying}. +$${payout.toFixed(2)}. Don't let it go to your head.`,
  (buyer, underlying, payout) => `🎯 ${buyer} called it on ${underlying} and got paid: +$${payout.toFixed(2)}. Beginner's luck, probably.`,
  (buyer, underlying, payout) => `📈 ${underlying} actually delivered for once. ${buyer} collects +$${payout.toFixed(2)}.`,
];
const OPTIONS_WORTHLESS_MESSAGES: ((buyer: string, underlying: string) => string)[] = [
  (buyer, underlying) => `📉 ${buyer}'s call on ${underlying} expired worthless. The premium is gone. So is your dignity.`,
  (buyer, underlying) => `🔥 ${underlying} didn't even come close. ${buyer} just donated that premium to the void.`,
  (buyer, underlying) => `🗑️ ${buyer} bet on ${underlying} and lost the premium for their trouble. Better luck next contract.`,
  (buyer, underlying) => `📉 Expired worthless. ${buyer}'s faith in ${underlying} was not rewarded.`,
];

// Callback data for the strike/duration pickers is just the raw percent/day number (e.g. "option_strike:8"),
// so these map that back to the typed literal union values used everywhere else.
const STRIKE_PCT_BY_CALLBACK: Record<string, StockMarketOptionStrikePct> = {
  "8": 0.08,
  "10": 0.1,
  "15": 0.15,
  "20": 0.2,
  "30": 0.3,
  "45": 0.45,
};
const DURATION_DAYS_BY_CALLBACK: Record<string, StockMarketOptionDurationDays> = { "0": 0, "1": 1, "3": 3, "7": 7 };

// Mirrors OPTION_STRIKES_BY_DURATION in the durable object (the pricing/validation authority) — needed
// here purely to build each duration's strike keyboard with the right three buttons, and to catch a stale
// button from a different duration's menu with a clearer message than the DO's generic INVALID_TERMS
// would give. Keep in sync by hand if the strike tiers ever change.
const OPTION_STRIKE_PCTS_BY_DURATION: Record<StockMarketOptionDurationDays, readonly [number, number, number]> = {
  0: [8, 10, 15],
  1: [10, 15, 20],
  3: [15, 20, 30],
  7: [20, 30, 45],
};

// Column widths for /market's aligned metrics line (see formatMarketMetrics) — wide enough for a
// four-digit price and a ▲/▼ + sign + two-decimal change with room to spare, so the percent that
// follows lines up across every row regardless of how long the preceding numbers are.
const MARKET_PRICE_WIDTH = 9;
const MARKET_CHANGE_WIDTH = 10;

// A 1-in-100 chance on any real (non-command) message — see maybeAwardCashBonus. Pure surprise, no
// strategy or pattern to it: doesn't move price or count as market activity in any other way, just cash.
const CASH_BONUS_CHANCE = 0.02;
const CASH_BONUS_AMOUNTS = [1, 5, 10, 20];
const CASH_BONUS_MESSAGES: ((amount: number) => string)[] = [
  (amount) => `🎰 Congress just passed a surprise stimulus bill in your honor: +$${amount}. Spend it wisely, or more likely, don't.`,
  (amount) => `A mysterious benefactor deposited +$${amount} into your account. Do not ask questions. There are no questions.`,
  (amount) => `The Federal Reserve's "vibes-based monetary policy" just kicked in: +$${amount}.`,
  (amount) => `+$${amount} appeared out of nowhere. I'm not saying it fell off a truck. I'm also not NOT saying that.`,
  (amount) => `The IRS made an error in your favor: +$${amount}. This will absolutely not come back to haunt you.`,
  (amount) => `A wizard blesses you with +$${amount} and vanishes without another word.`,
  (amount) => `You've been randomly selected for a UBI pilot program nobody else knows exists: +$${amount}.`,
  (amount) => `Found +$${amount} on the sidewalk. It's actually just a number in a database, but sure, feel things about it.`,
  (amount) => `The universe rewards you with +$${amount} for posting too much.`,
  (amount) => `Somebody's Venmo request bounced back to you as a gift: +$${amount}. Don't look a gift horse in the mouth.`,
];

// Owner-triggered /stimulus announcement — see handleStimulus. Unlike CASH_BONUS_MESSAGES (random, passive,
// one person), this is always deliberate, always the owner, and always everyone at once — the jokes lean
// into that instead: an unelected admin with raw database access playing Federal Reserve chairman.
const STIMULUS_MESSAGES: ((amount: string, count: number, players: string) => string)[] = [
  (amount, count, players) => `🏛️ STIMULUS — the owner just personally airdropped +$${amount} into ${count} account${players}. No vote, no debate, no oversight. Just vibes and a real dollar amount.`,
  (amount, count, players) => `🚁 Helicopter money incoming: +$${amount} for all ${count} of you. The owner would like it on record that this was "necessary."`,
  (amount, count, players) => `💸 The Fed printed exactly enough to cover ${count} trader${players} getting +$${amount} each. Please do not ask where it actually came from.`,
  (amount, count, players) => `🎩 The owner reached into the top hat and pulled out +$${amount} for every one of you. This is not a magic trick. This is fiscal policy now.`,
  (amount, count, players) => `🏛️ BREAKING: unelected market administrator unilaterally cuts ${count} trader${players} a +$${amount} check. Economists are "concerned."`,
  (amount, count, players) => `💰 Stimulus check cleared: +$${amount} to all ${count} of you, courtesy of an owner with too much free time and full write access to the database.`,
  (amount, count, players) => `🏛️ The owner just declared a national holiday and handed ${count} trader${players} +$${amount} apiece. There was no national holiday. There is now.`,
  (amount, count, players) => `🖨️ Somewhere, a printer that only exists in a Cloudflare Durable Object just ran off +$${amount} for each of ${count} of you. Spend it before the owner changes his mind.`,
];

// Reply to a message 30+ days old. One-time per message (see claimNecromancy) so the same corpse can't
// be repeatedly dug up for repeat payouts.
const NECROMANCY_THRESHOLD_DAYS = 30;
const NECROMANCY_PAYOUT = 25;

// Duals of each other off a silence gap (see checkSilenceEvents): Conversation Terminator rewards
// whoever posted right before a long gap, Market Open rewards whoever breaks it. Both guard on "not the
// same person both times" — otherwise one person alone in a dead chat could farm Market Open by just
// posting to themselves every 6+ hours. Terminator is scoped per forum topic (a topic going quiet is its
// own event); Market Open stays chat-wide (breaking the silence anywhere in the chat counts).
const TERMINATOR_SILENCE_HOURS = 3;
const TERMINATOR_RATE_PER_HOUR = 10;
const TERMINATOR_CAP = 100;
const MARKET_OPEN_SILENCE_HOURS = 6;
const MARKET_OPEN_PAYOUT = 15;

// Conversation Terminator only fires between 10am and 10pm ET, and only counts "awake hours" of
// silence (see awakeHoursBetween in checkSilenceEvents) — otherwise every single night's sleep would read
// as hours of silence and trigger it every morning. 10am ET ≈ 14:00 UTC and 10pm ET ≈ 02:00 UTC the
// next day: the same fixed-EDT approximation (and the same accepted DST drift) as TRADING_DAY_START in
// the durable object. Market Open deliberately does NOT use any of this — see checkSilenceEvents for why.
const AWAKE_WINDOW_START_UTC_HOUR = 14; // 10am ET
const AWAKE_WINDOW_END_UTC_HOUR = 2; // 10pm ET, lands on the next UTC day

const TERMINATOR_MESSAGES: ((label: string, duration: string, payout: number) => string)[] = [
  (label, duration, payout) => `💀 ${label} — CONVERSATION TERMINATED. ${duration} of silence because that message genuinely wasn't worth responding to. +$${payout}.`,
  (label, duration, payout) =>
    `☠️ ${duration} of nothing. ${label}, you said something so mind-numbingly dull the entire chat collectively lost the will to type. +$${payout}.`,
  (label, duration, payout) => `🪦 ${label} spoke ${duration} ago and everyone silently, unanimously agreed it wasn't worth a reply. +$${payout} for the eulogy.`,
  (label, duration, payout) => `💀 No reply. No 👍. Not even a "lol." ${duration} of ${label} being completely, thoroughly ignored. +$${payout}.`,
  (label, duration, payout) => `🧟 ${duration} of dead air because nobody could be bothered to respond to ${label}. Brutal, but fair. +$${payout}.`,
  (label, duration, payout) => `📉 ${label} killed the conversation on impact. ${duration} of silence to prove it, in case there was any doubt. +$${payout}.`,
];

// True if `now` falls inside the 10am-10pm ET awake window (see the constants above) — the check that
// gates whether checkSilenceEvents runs at all. AWAKE_WINDOW_END_UTC_HOUR (2) marks the tail end of the
// PREVIOUS UTC day's window spilling into this one, so "before 2am UTC" also counts as awake.
function isWithinAwakeWindow(now: Date): boolean {
  const utcHour = now.getUTCHours();
  return utcHour >= AWAKE_WINDOW_START_UTC_HOUR || utcHour < AWAKE_WINDOW_END_UTC_HOUR;
}

// Sums only the portion of [startMs, endMs) that falls inside a 10am-10pm ET awake window on some
// day, walking one UTC calendar day at a time. Windows are built directly in UTC millis (never a JS Date
// parse of a timezone-ambiguous string — the epoch-second inputs already came from SQLite's own strftime,
// see getThreadSilenceGap/getChatSilenceGap), and never overlap each other, so no interval can be
// double-counted.
function awakeMillisBetween(startMs: number, endMs: number): number {
  if (endMs <= startMs) {
    return 0;
  }

  const DAY_MS = 24 * 60 * 60 * 1000;
  const HOUR_MS = 60 * 60 * 1000;

  const start = new Date(startMs);
  // Start one UTC day early — a window can begin the previous UTC day and spill into this one (its
  // 10pm-ET tail lands at AWAKE_WINDOW_END_UTC_HOUR the following day).
  let dayStart = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() - 1);

  let total = 0;
  while (dayStart < endMs) {
    const windowStart = dayStart + AWAKE_WINDOW_START_UTC_HOUR * HOUR_MS;
    const windowEnd = dayStart + (24 + AWAKE_WINDOW_END_UTC_HOUR) * HOUR_MS;
    const overlapStart = Math.max(startMs, windowStart);
    const overlapEnd = Math.min(endMs, windowEnd);
    if (overlapEnd > overlapStart) {
      total += overlapEnd - overlapStart;
    }
    dayStart += DAY_MS;
  }

  return total;
}

function awakeHoursBetween(startMs: number, endMs: number): number {
  return awakeMillisBetween(startMs, endMs) / (60 * 60 * 1000);
}

type TradeCommand = { shares: number } & ({ replyUserId: number; replyIsBot: boolean; replyFirstName: string } | { ticker: string });

// A removal target resolved by either replying to their message or naming their $TICKER — same two paths
// /buy and /sell already accept, reused here for /delist and /reset's owner-targeted form.
type RemovalTarget = { userId: number; firstName: string };

export class StockMarketComposer extends Composer<MyContext> {
  constructor(
    private storage: StorageService,
    private ownerChatId?: number
  ) {
    super();
    // Must be registered before the /setticker, /buy, /sell handlers below — it's what makes each
    // conversation name resolvable when those handlers call ctx.conversation.enter().
    this.use(
      createConversation(this.setTickerDialogue.bind(this), {
        id: SET_TICKER_CONVERSATION,
        maxMillisecondsToWait: CONVERSATION_TIMEOUT_MS,
      })
    );
    this.use(
      createConversation(this.tradeDialogue.bind(this), { id: TRADE_CONVERSATION, maxMillisecondsToWait: CONVERSATION_TIMEOUT_MS })
    );
    this.use(
      createConversation(this.optionsDialogue.bind(this), { id: OPTIONS_CONVERSATION, maxMillisecondsToWait: CONVERSATION_TIMEOUT_MS })
    );

    this.command("portfolio", (ctx) => this.sendPortfolio(ctx));
    this.command("market", (ctx) => this.sendMarket(ctx));
    this.command("value", (ctx) => this.sendValue(ctx));
    this.command("setticker", (ctx) => this.handleSetTicker(ctx));
    this.command("buy", (ctx) => this.handleTrade(ctx, "buy"));
    this.command("sell", (ctx) => this.handleTrade(ctx, "sell"));
    this.command("options", (ctx) => this.handleOptions(ctx));
    this.command("delist", (ctx) => this.handleRemoval(ctx, "delist"));
    this.command("reset", (ctx) => this.handleRemoval(ctx, "reset"));
    this.command("stimulus", (ctx) => this.handleStimulus(ctx));
    this.callbackQuery(/^(delist|reset):(confirm|cancel):(\d+)$/, (ctx) => this.handleSelfRemovalCallback(ctx));
    this.on("message", (ctx, next) => this.trackActivity(ctx, next));
    this.on("message_reaction", (ctx) => this.trackReaction(ctx));
  }

  // Opt-in short handle for /buy and /sell targeting (see handleTrade) — replaces @username entirely for
  // trades, since not everyone has one and that was confusing people. Requires having posted a real
  // message already (same reach restriction as findPlayerByTicker) so a ticker never outlives its player
  // past the weekly ghost purge.
  //
  // Tapping /setticker from Telegram's command menu sends it bare — there's no inline way to type the
  // ticker as part of the command itself, which was tripping people up. So bare /setticker now drops into
  // a force_reply conversation (setTickerDialogue) instead of just erroring; /setticker ABCD still works
  // directly for anyone who already knows the syntax.
  private async handleSetTicker(ctx: MyContext) {
    if (!ctx.chat || !ctx.from) {
      return;
    }

    const raw = String(ctx.match ?? "").trim();
    if (!raw) {
      // enter() throws if any conversation (Wordle Golf's included — the session is shared per chat)
      // is already active for this chat, rather than silently colliding with it. That's a real "try
      // again" case, not the kind of ambient background noise the top-level error handler stays quiet
      // about, so it gets its own message here.
      try {
        await ctx.conversation.enter(SET_TICKER_CONVERSATION);
      } catch {
        await replyToMessage(ctx, "Someone else has a command in progress in this chat — try /setticker again in a moment.");
      }
      return;
    }

    if (!TICKER_PATTERN.test(raw)) {
      await replyToMessage(ctx, "Ticker must be 1-4 letters, e.g. /setticker ABCD.");
      return;
    }

    const result = await this.storage.setStockMarketTicker(ctx.chat.id, ctx.from.id, raw.toUpperCase());
    await replyToMessage(ctx, this.tickerResultMessage(result, raw.toUpperCase()));
  }

  // force_reply makes Telegram auto-open the reply box targeting this prompt, so the next thing the user
  // types becomes the answer — selective:true scopes that behavior to just them, not everyone in the chat.
  private async setTickerDialogue(conversation: MyConversation, ctx: ConversationContext) {
    if (!ctx.chat || !ctx.from) {
      return;
    }
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;

    await ctx.reply("What ticker do you want? (1-4 letters, e.g. ABCD)", {
      reply_markup: { force_reply: true, selective: true },
      ...(ctx.message?.message_id !== undefined && { reply_to_message_id: ctx.message.message_id }),
      ...(ctx.message?.message_thread_id !== undefined && { message_thread_id: ctx.message.message_thread_id }),
    });

    await this.waitForTicker(conversation, chatId, userId);
  }

  // Only the person who ran /setticker gets to answer — the conversation session is shared per-chat (see
  // bot.ts's conversationStorage), so without this check anyone else's unrelated reply in the meantime
  // would get misread as the answer. Loops on an invalid/taken ticker rather than ending the conversation,
  // same pattern as wordle-golf.ts's askForNumber.
  private async waitForTicker(conversation: MyConversation, chatId: number, userId: number): Promise<void> {
    const response = await conversation.waitFor("message:text").and(isNotCommand, { next: true });

    if (response.from?.id !== userId) {
      return this.waitForTicker(conversation, chatId, userId);
    }

    const raw = response.message.text.trim();
    if (EXIT_KEYWORDS.has(raw.toLowerCase())) {
      await replyToMessage(response, "No ticker set — you can run /setticker again anytime.");
      return;
    }

    if (!TICKER_PATTERN.test(raw)) {
      await replyToMessage(response, "Ticker must be 1-4 letters — try again, or send \"cancel\" to stop.");
      return this.waitForTicker(conversation, chatId, userId);
    }
    const ticker = raw.toUpperCase();

    const result = await conversation.external(() => this.storage.setStockMarketTicker(chatId, userId, ticker));
    await replyToMessage(response, this.tickerResultMessage(result, ticker));
    if (result === "TAKEN") {
      return this.waitForTicker(conversation, chatId, userId);
    }
  }

  private tickerResultMessage(result: StockMarketSetTickerResult, ticker: string): string {
    switch (result) {
      case "NOT_A_PLAYER":
        return "Post something in the chat first before you can set a ticker.";
      case "TAKEN":
        return `$${ticker} is already taken by someone else in this chat.`;
      case "OK":
        return `Your ticker is now $${ticker}.`;
    }
  }

  // Runs on every message in the chat — any type, not just text, and not just commands — that's the whole
  // point (price is driven by ambient activity). Always calls next() so it never interferes with any other
  // feature's handlers.
  private async trackActivity(ctx: MyContext, next: NextFunction) {
    const isCommand = ctx.message?.text?.startsWith("/") ?? false;
    if (ctx.from && ctx.chat && ctx.message && !ctx.from.is_bot && !isCommand) {
      // Must run before recordStockMarketMessage below — that's what inserts the current message into
      // message_authors, and this needs to see the state as it was right before that happens.
      await this.checkSilenceEvents(ctx);

      await this.storage.recordStockMarketMessage(ctx.chat.id, {
        messageId: ctx.message.message_id,
        userId: ctx.from.id,
        ...(ctx.from.username !== undefined && { username: ctx.from.username }),
        firstName: ctx.from.first_name,
        ...(ctx.message.message_thread_id !== undefined && { threadId: ctx.message.message_thread_id }),
      });

      const repliedToMessage = realReplyTo(ctx);
      const repliedTo = repliedToMessage?.from;
      if (repliedTo && !repliedTo.is_bot && repliedTo.id !== ctx.from.id) {
        await this.storage.recordStockMarketReply(ctx.chat.id, {
          recipientUserId: repliedTo.id,
          ...(repliedTo.username !== undefined && { recipientUsername: repliedTo.username }),
          recipientFirstName: repliedTo.first_name,
          replierUserId: ctx.from.id,
        });
      }
      if (repliedToMessage) { // is this broken? sometimes responds to a normal message in a thread, not a reply
        // await this.maybeAwardNecromancy(ctx, repliedToMessage);  // remove necromancy
      }

      await this.maybeAwardCashBonus(ctx);
    }

    await next();
  }

  // Detects a silence gap ending with this message. Conversation Terminator and Market Open are
  // independent checks (no longer off one shared gap) — Terminator looks at this specific forum topic,
  // Market Open looks at the whole chat, and each can fire on its own. Both guard on "not the same person
  // both times" — see the constants above for why. The awake-window/awake-hours machinery below is
  // Terminator-only: Market Open is deliberately untouched by it and keeps its original raw-gap, any-hour
  // behavior — "breaking the silence" is specifically supposed to mean breaking an overnight gap, so
  // excluding overnight hours from its math would gut the entire mechanic. Terminator has one more escape
  // hatch: any genuine reaction on that last message (see recordReaction's last_reacted_at) counts as real
  // engagement and blocks it outright, even with zero text replies.
  private async checkSilenceEvents(ctx: MyContext): Promise<void> {
    if (!ctx.chat || !ctx.from) {
      return;
    }

    const threadId = ctx.message?.message_thread_id ?? null;

    if (isWithinAwakeWindow(new Date())) {
      const threadLast = await this.storage.getStockMarketThreadSilenceGap(ctx.chat.id, threadId);
      if (threadLast && !threadLast.hasReaction && threadLast.userId !== ctx.from.id) {
        const awakeHours = awakeHoursBetween(threadLast.lastEpochSec * 1000, threadLast.nowEpochSec * 1000);
        if (awakeHours >= TERMINATOR_SILENCE_HOURS) {
          if (Math.random() < 0.7) return; // 30% chance of paying out for this
          const payout = Math.min(TERMINATOR_CAP, Math.round(awakeHours * TERMINATOR_RATE_PER_HOUR));
          await this.storage.awardStockMarketCash(ctx.chat.id, threadLast.userId, payout);
          const label = this.formatTaggedLabel(threadLast.userId, threadLast.firstName, threadLast.ticker);
          const message = random(TERMINATOR_MESSAGES)(label, this.formatDuration(awakeHours), payout);
          // A genuine reply to the terminated message itself, not a fresh announcement — unlike Market
          // Open below, this doesn't go through sendMarketAnnouncement or the configurable announcement
          // thread, since the point is to land directly under the message that killed the conversation.
          await ctx.api.sendMessage(ctx.chat.id, message, {
            parse_mode: "HTML",
            reply_to_message_id: threadLast.messageId,
            ...(threadId !== null && { message_thread_id: threadId }),
          });
        }
      }
    }

    const chatLast = await this.storage.getStockMarketChatSilenceGap(ctx.chat.id);
    if (chatLast && chatLast.userId !== ctx.from.id) {
      const gapHours = (chatLast.nowEpochSec - chatLast.lastEpochSec) / 3600;
      if (gapHours >= MARKET_OPEN_SILENCE_HOURS) {
        // temp removal
        // await this.storage.awardStockMarketCash(ctx.chat.id, ctx.from.id, MARKET_OPEN_PAYOUT);
        // await this.sendMarketAnnouncement(
        //   ctx,
        //   `🔔 MARKET OPEN — ${this.formatTaggedLabel(ctx.from.id, ctx.from.first_name, null)} broke the silence. +$${MARKET_OPEN_PAYOUT}.`
        // );
      }
    }
  }

  // Same "($TICKER)" shape as formatLabel, but the name itself is a tg://user link — pings/highlights the
  // person by their Telegram user id, which works even if they've never set a public @username (unlike an
  // @-mention, which requires one).
  private formatTaggedLabel(userId: number, firstName: string, ticker: string | null): string {
    const name = `<a href="tg://user?id=${userId}">${firstName}</a>`;
    return ticker ? `${name} ($${ticker})` : name;
  }

  // A fresh, non-reply HTML message — Market Open shouldn't interrupt the conversation flow the way a
  // reply bubble does (Conversation Terminator is the opposite: see checkSilenceEvents, it deliberately
  // does reply). Prefers the configured market announcement thread (/setmarketthread) if one's set,
  // falling back to whichever thread the triggering message was itself posted in (or the main chat, if
  // neither applies).
  private async sendMarketAnnouncement(ctx: MyContext, message: string): Promise<void> {
    if (!ctx.chat) {
      return;
    }
    const marketThread = await this.storage.getStockMarketAnnouncementThread(ctx.chat.id);
    const threadId = marketThread ?? ctx.message?.message_thread_id;
    await ctx.api.sendMessage(ctx.chat.id, message, {
      parse_mode: "HTML",
      ...(threadId !== undefined && { message_thread_id: threadId }),
    });
  }

  private formatDuration(hours: number): string {
    const totalMinutes = Math.round(hours * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${h}h ${m}m`;
  }

  // Reviving a 30+ day old message — the age comes directly from Telegram's own timestamp on the
  // replied-to message, no separate lookup needed. Must be called with realReplyTo's result specifically
  // (see trackActivity), not raw ctx.message.reply_to_message — otherwise the topic-auto-reply bug would
  // falsely "revive" a topic's root message on every message sent in an old topic. Excludes the bot's own
  // messages so the steadily-accumulating pool of bot posts (photos, announcements) doesn't quietly make
  // this common instead of rare.
  private async maybeAwardNecromancy(ctx: MyContext, repliedTo: NonNullable<ReturnType<typeof realReplyTo>>): Promise<void> {
    if (!ctx.chat || !ctx.from || repliedTo.from?.is_bot) {
      return;
    }

    const ageDays = (Date.now() / 1000 - repliedTo.date) / 86_400;
    if (ageDays < NECROMANCY_THRESHOLD_DAYS) {
      return;
    }

    const claimed = await this.storage.claimStockMarketNecromancy(ctx.chat.id, repliedTo.message_id);
    if (!claimed) {
      return;
    }

    await this.storage.awardStockMarketCash(ctx.chat.id, ctx.from.id, NECROMANCY_PAYOUT);
    await replyToMessage(
      ctx,
      `⚰️ NECROMANCY — you just revived a ${Math.floor(ageDays)}-day-old message. +$${NECROMANCY_PAYOUT}, you absolute freak.`
    );
  }

  // 1-in-100 chance per qualifying message (same gate as trackActivity's recordStockMarketMessage —
  // already known non-null/non-bot/non-command by the time this is called). Cash only, never price, so
  // it's a pure surprise with no interaction with dampenGain, decay, or halts.
  private async maybeAwardCashBonus(ctx: MyContext): Promise<void> {
    if (!ctx.chat || !ctx.from || Math.random() >= CASH_BONUS_CHANCE) {
      return;
    }

    const amount = random(CASH_BONUS_AMOUNTS);
    await this.storage.awardStockMarketCash(ctx.chat.id, ctx.from.id, amount);
    await replyToMessage(ctx, random(CASH_BONUS_MESSAGES)(amount));
  }

  // Telegram's message_reaction updates only cover one user's reaction state per update, and can fire for
  // adds/removals/changes — only newly-added emoji get a price effect, nothing is reversed on removal.
  private async trackReaction(ctx: MyContext) {
    if (!ctx.chat || !ctx.messageReaction?.user || ctx.messageReaction.user.is_bot) {
      return;
    }

    const { message_id: messageId, user } = ctx.messageReaction;
    for (const emoji of ctx.reactions().emojiAdded) {
      await this.storage.recordStockMarketReaction(ctx.chat.id, { messageId, reactorUserId: user.id, emoji });
    }
  }

  private async sendPortfolio(ctx: MyContext) {
    if (!ctx.from || !ctx.chat) {
      return;
    }

    const portfolio = await this.storage.getStockMarketPortfolio(ctx.chat.id, ctx.from.id);
    if (!portfolio) {
      await replyToMessage(ctx, "You don't have a stock yet — post something in the chat first!");
      return;
    }

    await replyHTML(ctx, this.formatPortfolio(portfolio));
  }

  private formatPortfolio(portfolio: StockMarketPortfolio): string {
    const lines = [
      `<b>${this.formatLabel(portfolio.firstName, portfolio.ticker, portfolio.isHalted, false)}'s Portfolio</b>`,
      `<code>${portfolio.price.toFixed(2)}</code> ${this.formatChange(portfolio.dailyChange, portfolio.price)}`,
      `-----`,
      `Cash: <code>${portfolio.cash.toFixed(2)}</code>`,
    ];

    if (portfolio.holdings.length === 0) {
      lines.push(`-----`, `No holdings yet — reply to someone's message with /buy to invest in them.`);
    } else {
      lines.push(`-----`, `Holdings:`, ``);
      for (const holding of portfolio.holdings) {
        lines.push(
          `${this.formatLabel(holding.firstName, holding.ticker, holding.isHalted)}:`,
          `   ${holding.shares} @ <code>${holding.price.toFixed(2)}</code> ${this.formatPercentOnly(holding.dailyChange, holding.price)} = <code>${holding.value.toFixed(2)}</code>`
        );
      }
    }

    // Omitted entirely when empty, same as holdings-less portfolios not getting a bare "Holdings:" header
    // — most players never buy an option, so this shouldn't be permanent clutter on every /portfolio.
    if (portfolio.openOptions.length > 0) {
      lines.push(`-----`, `Open Options:`, ``);
      // Grouped by underlying so buying several contracts on the same person doesn't repeat their name/
      // ticker header once per contract — getPortfolio already orders soonest-expiry-first, and a Map
      // preserves that as first-appearance order per group, so both the group order and each group's own
      // contracts stay soonest-first.
      const byUnderlying = new Map<number, typeof portfolio.openOptions>();
      for (const option of portfolio.openOptions) {
        const group = byUnderlying.get(option.underlyingUserId);
        if (group) {
          group.push(option);
        } else {
          byUnderlying.set(option.underlyingUserId, [option]);
        }
      }

      for (const group of byUnderlying.values()) {
        const [first] = group;
        if (!first) {
          continue;
        }
        // currentPrice is the underlying's live price, identical across every contract in the group (not
        // a per-contract snapshot) — shown once on the header line rather than repeated per contract.
        lines.push(`${this.formatLabel(first.underlyingFirstName, first.underlyingTicker, first.isHalted)} — S<code>${first.currentPrice.toFixed(2)}</code>:`);
        for (const option of group) {
          const runway = this.formatDuration((option.expiresAtEpochSec - option.nowEpochSec) / 3600);
          lines.push(`   K<code>${option.strikePrice.toFixed(2)}</code> - expires ~${runway}`);
        }
      }
    }

    const netWorth = portfolio.cash + portfolio.holdings.reduce((sum, h) => sum + h.value, 0);
    lines.push(`-----`, `Net worth: <code>${netWorth.toFixed(2)}</code>`);
    return lines.join("\n");
  }

  private async sendMarket(ctx: MyContext) {
    if (!ctx.chat) {
      return;
    }

    const players = await this.storage.getStockMarket(ctx.chat.id);
    if (players.length === 0) {
      await replyToMessage(ctx, "No stocks yet — the market opens once people start posting.");
      return;
    }

    await replyHTML(ctx, this.formatMarket(players));
  }

  // Two lines per player: name, then indented metrics. Regular Telegram message text uses a proportional
  // font (no <pre>/monospace here), so the space-padding in formatMarketMetrics won't align pixel-perfect
  // the way a code block would — but most Telegram clients render digits at a fairly even width even in
  // their regular font, so it reads close enough to a real ticker without the code-block styling <pre>
  // forces on the whole message.
  private formatMarket(players: StockMarketPlayer[]): string {
    const lines = [`<b>Beans &amp; Poors 500</b>`];
    players.forEach((player, index) => {
      lines.push(`${index + 1}. ${this.formatLabel(player.firstName, player.ticker, player.isHalted)}`);
      lines.push(`    ${this.formatMarketMetrics(player.price, player.dailyChange)}`);
    });
    return lines.join("\n");
  }

  // showTickerPrefix defaults on for every call site except the portfolio title (see formatPortfolio),
  // which deliberately keeps the bare "(TICKER)" look instead of "($TICKER)".
  private formatLabel(firstName: string, ticker: string | null, isHalted: boolean, showTickerPrefix = true): string {
    const tickerTag = ticker ? (showTickerPrefix ? `$${ticker}` : ticker) : null;
    const name = tickerTag ? `${firstName} (${tickerTag})` : firstName;
    return isHalted ? `🚨 ${name} HALTED` : name;
  }

  // Shared math behind formatChange and formatMarketMetrics: this trading day's price movement (see
  // TRADING_DAY_START — 5pm ET, not midnight), both absolute and percent versus the opening price
  // (price - change). Every row gets the same
  // shape — arrow, signed amount, percent — even when flat or pinned at the floor, so no row looks like a
  // one-off special case (previously a near-zero change short-circuited to a bare "-0.00" with no percent
  // at all, which read as broken rather than "unchanged"). A price at the floor (0) forces a flat/0.00
  // result rather than a real percent: opening = price - change reduces to opening = -change whenever
  // price is 0, so the ratio would always land at exactly ±100% no matter how small the actual move was,
  // and can even contradict the arrow (e.g. a same-day recovery from 0 computes a negative opening,
  // flipping the percent's sign against the arrow's) — flat is simply less wrong than a guaranteed ±100%.
  private computeChange(price: number, change: number): { arrow: string; abs: string; pct: number } {
    if (Math.abs(price) < 0.01 || Math.abs(change) < 0.01) {
      return { arrow: "", abs: "0.00", pct: 0 };
    }

    const arrow = change > 0 ? "▲" : "▼";
    const sign = change > 0 ? "+" : "";
    const abs = `${sign}${change.toFixed(2)}`;

    const opening = price - change;
    const pct = Math.abs(opening) < 0.01 ? 0 : (change / opening) * 100;
    return { arrow, abs, pct };
  }

  // Telegram's HTML parse mode has no way to color text (no <font>/CSS support), so direction is conveyed
  // with ▲/▼ rather than red/green.
  private formatChange(change: number, price: number): string {
    const { arrow, abs, pct } = this.computeChange(price, change);
    const pctSign = pct > 0 ? "+" : "";
    const prefix = arrow ? `${arrow} ` : "";
    return `${prefix}${abs} (${pctSign}${pct.toFixed(2)}%)`;
  }

  // Same data as formatChange, but padded into fixed-width columns for /market — value, then change, then
  // percent, each starting at the same character position on every row. No parens around the percent here
  // (unlike formatChange's inline prose style) since the column position alone already separates it.
  private formatMarketMetrics(price: number, change: number): string {
    const { arrow, abs, pct } = this.computeChange(price, change);
    const priceStr = price.toFixed(2).padEnd(MARKET_PRICE_WIDTH);
    const changeStr = (arrow ? `${arrow}${abs}` : abs).padEnd(MARKET_CHANGE_WIDTH);
    const pctSign = pct > 0 ? "+" : "";
    return `${priceStr}${changeStr}${pctSign}${pct.toFixed(2)}%`;
  }

  // Just the percent, parenthesized — used in /portfolio's holdings list where a full arrow+abs+pct
  // (formatChange's shape) made each line too long once shares/price/total were already on it.
  private formatPercentOnly(change: number, price: number): string {
    const { pct } = this.computeChange(price, change);
    const pctSign = pct > 0 ? "+" : "";
    return `(${pctSign}${pct.toFixed(2)}%)`;
  }

  // Reply-only — no @username or ticker fallback. Not everyone has a Telegram username (that's why /buy
  // and /sell target by ticker instead, see handleTrade below), and requiring a reply here is simpler
  // than asking people to remember yet another way to point at someone just to check a number.
  private async sendValue(ctx: MyContext) {
    const target = await this.resolveValueTarget(ctx);
    if (!target) {
      await replyToMessage(ctx, "Reply to someone's message with /value to check their stock.");
      return;
    }

    await replyHTML(ctx, `${this.formatLabel(target.firstName, target.ticker, target.isHalted)}'s stock is worth <code>${target.price.toFixed(2)}</code>.`);
  }

  private async resolveValueTarget(ctx: MyContext): Promise<StockMarketPlayer | null> {
    if (!ctx.chat) {
      return null;
    }

    const repliedTo = realReplyTo(ctx)?.from;
    return repliedTo ? this.storage.getStockMarketPlayer(ctx.chat.id, repliedTo.id) : null;
  }

  // Both /buy and /sell can target whoever's message you're replying to, or an explicit /buy $TICKER <n>.
  // Reply wins if both are somehow present. Ticker lookup only reaches someone who's set one via
  // /setticker (which itself requires having already posted) — targeting used to fall back to Telegram
  // @username, but not everyone has one, which was confusing people, so tickers replaced it entirely here.
  //
  // Tapping /buy or /sell bare from Telegram's command menu (no args, not a reply) drops into a
  // conversation that lists available tickers as tappable buttons instead of just erroring — same
  // rationale as /setticker, but here the target is a fixed, enumerable set, so a picker fits better than
  // a free-text prompt. Anyone who already knows the /buy $TICKER <n> syntax can still just type it.
  private async handleTrade(ctx: MyContext, action: "buy" | "sell") {
    if (!ctx.chat || !ctx.from) {
      return;
    }

    if (!realReplyTo(ctx) && String(ctx.match ?? "").trim() === "") {
      try {
        await ctx.conversation.enter(TRADE_CONVERSATION, action);
      } catch {
        await replyToMessage(ctx, `Someone else has a command in progress in this chat — try /${action} again in a moment.`);
      }
      return;
    }

    const parsed = this.parseTradeCommand(ctx);
    if (!parsed) {
      await replyToMessage(
        ctx,
        `Reply to someone's message with /${action} <shares>, or use /${action} $TICKER <shares> if they've set one with /setticker.`
      );
      return;
    }

    let targetUserId: number;
    let targetFirstName: string;
    let targetTicker: string | null;

    if ("replyUserId" in parsed) {
      if (parsed.replyIsBot) {
        await replyToMessage(ctx, "Bots don't trade on this exchange.");
        return;
      }
      targetUserId = parsed.replyUserId;
      targetFirstName = parsed.replyFirstName;
      // Reply targeting only gives us Telegram's name for the person, not their ticker — a reply-path
      // trade still needs the DB lookup /value already does (resolveValueTarget) purely for display.
      const player = await this.storage.getStockMarketPlayer(ctx.chat.id, targetUserId);
      targetTicker = player?.ticker ?? null;
    } else {
      const found = await this.storage.findStockMarketPlayerByTicker(ctx.chat.id, parsed.ticker);
      if (!found) {
        await replyToMessage(ctx, `Couldn't find $${parsed.ticker} — check the ticker, or ask them to set one with /setticker.`);
        return;
      }
      targetUserId = found.userId;
      targetFirstName = found.firstName;
      targetTicker = found.ticker;
    }

    const result =
      action === "buy"
        ? await this.storage.buyStock(ctx.chat.id, {
            buyerUserId: ctx.from.id,
            ...(ctx.from.username !== undefined && { buyerUsername: ctx.from.username }),
            buyerFirstName: ctx.from.first_name,
            targetUserId,
            shares: parsed.shares,
          })
        : await this.storage.sellStock(ctx.chat.id, {
            sellerUserId: ctx.from.id,
            targetUserId,
            shares: parsed.shares,
          });

    await this.sendTradeResult(ctx, action, result, targetFirstName, targetTicker);
  }

  // Shared between handleTrade's direct path and the conversation's final step (waitForShares) so both
  // report results identically.
  private async sendTradeResult(
    replyCtx: Context,
    action: "buy" | "sell",
    result: StockMarketTradeResult,
    targetFirstName: string,
    targetTicker: string | null
  ): Promise<void> {
    if (!result.ok) {
      await replyToMessage(replyCtx, this.tradeErrorMessage(result.type));
      return;
    }

    // $NULL is deliberate, not a bug — a bit of a jab at anyone who hasn't set a ticker yet with /setticker.
    const tickerTag = `$${targetTicker ?? "NULL"}`;
    const verb = action === "buy" ? "Bought" : "Sold";
    const holdingNote =
      result.totalShares > 0
        ? `You now hold ${result.totalShares} share${result.totalShares === 1 ? "" : "s"} of ${tickerTag}.`
        : `You no longer hold any shares of ${tickerTag}.`;
    await replyToMessage(
      replyCtx,
      `${verb} ${result.shares} share${result.shares === 1 ? "" : "s"} of ${targetFirstName} at ${result.price.toFixed(2)} each — total ${result.total.toFixed(2)}.\n${holdingNote}`
    );
  }

  // Builds the /buy picker: everyone else in the chat who's set a ticker, minus self (can't buy your own
  // stock — CANNOT_TRADE_SELF, excluded up front rather than letting the trade call reject it) and minus
  // anyone currently halted (nothing to buy while trading's frozen).
  private async buyableTickers(chatId: number, userId: number): Promise<TickerOption[]> {
    const players = await this.storage.getStockMarket(chatId);
    return players
      .filter((p): p is StockMarketPlayer & { ticker: string } => p.ticker !== null && p.userId !== userId && !p.isHalted)
      .map((p) => ({ ticker: p.ticker, userId: p.userId, firstName: p.firstName }));
  }

  // Builds the /sell picker: holdings you actually own that also have a ticker set and aren't currently
  // halted — getPortfolio already filters to shares > 0, so no separate check needed there. A holding
  // without a ticker, or one that's halted, just can't be reached this way; /sell <shares> as a reply to
  // their message still works once the halt lifts.
  private async sellableTickers(chatId: number, userId: number): Promise<TickerOption[]> {
    const portfolio = await this.storage.getStockMarketPortfolio(chatId, userId);
    if (!portfolio) {
      return [];
    }
    const options: TickerOption[] = [];
    for (const holding of portfolio.holdings) {
      if (holding.ticker !== null && !holding.isHalted) {
        options.push({ ticker: holding.ticker, userId: holding.stockUserId, firstName: holding.firstName });
      }
    }
    return options;
  }

  // /buy or /sell with no args and no reply lands here (see handleTrade). Shows a ticker picker as inline
  // buttons — not a free-text prompt, since the target set is fixed and small, unlike /setticker's
  // arbitrary ticker — then asks for a share count via force_reply once a ticker's picked.
  private async tradeDialogue(conversation: MyConversation, ctx: ConversationContext, action: "buy" | "sell") {
    if (!ctx.chat || !ctx.from) {
      return;
    }
    const chatId = ctx.chat.id;
    const threadId = ctx.message?.message_thread_id;
    const buyer: { userId: number; firstName: string; username?: string } = {
      userId: ctx.from.id,
      firstName: ctx.from.first_name,
      ...(ctx.from.username !== undefined && { username: ctx.from.username }),
    };

    const options = await conversation.external(() =>
      action === "buy" ? this.buyableTickers(chatId, buyer.userId) : this.sellableTickers(chatId, buyer.userId)
    );

    if (options.length === 0) {
      await ctx.reply(
        action === "buy"
          ? "Nobody in this chat has set a ticker yet — reply to their message with /buy <shares> instead, or ask them to /setticker."
          : "You don't hold shares in anyone with a ticker set — reply to their message with /sell <shares> instead, or check /portfolio.",
        { ...(threadId !== undefined && { message_thread_id: threadId }) }
      );
      return;
    }

    const keyboard = new InlineKeyboard();
    options.forEach((option, index) => {
      keyboard.text(`$${option.ticker} — ${option.firstName}`, `${action}:${option.ticker}`);
      if (index % 2 === 1) {
        keyboard.row();
      }
    });

    await ctx.reply(`Who do you want to ${action}?`, {
      reply_markup: keyboard,
      ...(threadId !== undefined && { message_thread_id: threadId }),
    });

    const target = await this.waitForTickerChoice(conversation, buyer.userId, action, options);
    if (!target) {
      return;
    }

    await ctx.api.sendMessage(chatId, `How many shares of $${target.ticker} do you want to ${action}?`, {
      reply_markup: { force_reply: true, selective: true },
      ...(threadId !== undefined && { message_thread_id: threadId }),
    });

    await this.waitForShares(conversation, chatId, action, buyer, target);
  }

  // Only the person who ran /buy or /sell gets to pick — same per-chat session sharing concern as
  // waitForTicker. Loops rather than ending the conversation if someone else taps a button, or if the
  // button data somehow doesn't match one of the options we just built the keyboard from.
  private async waitForTickerChoice(
    conversation: MyConversation,
    userId: number,
    action: "buy" | "sell",
    options: TickerOption[]
  ): Promise<TickerOption | null> {
    const response = await conversation.waitForCallbackQuery(new RegExp(`^${action}:`), { next: true });

    if (response.from.id !== userId) {
      await response.answerCallbackQuery({ text: "This isn't your trade to make.", show_alert: true });
      return this.waitForTickerChoice(conversation, userId, action, options);
    }

    const ticker = response.callbackQuery.data?.slice(action.length + 1);
    const match = options.find((option) => option.ticker === ticker);
    if (!match) {
      await response.answerCallbackQuery({ text: "That option isn't available anymore.", show_alert: true });
      return null;
    }

    await response.answerCallbackQuery();
    await response.editMessageText(`${action === "buy" ? "Buying" : "Selling"} $${match.ticker} (${match.firstName})...`);
    return match;
  }

  // Loops on an invalid amount, same pattern as wordle-golf.ts's askForNumber. The actual buy/sell call
  // is wrapped in conversation.external() since it's a real storage mutation — see setTickerDialogue's
  // waitForTicker for the same requirement.
  private async waitForShares(
    conversation: MyConversation,
    chatId: number,
    action: "buy" | "sell",
    buyer: { userId: number; firstName: string; username?: string },
    target: TickerOption
  ): Promise<void> {
    const response = await conversation.waitFor("message:text").and(isNotCommand, { next: true });

    if (response.from?.id !== buyer.userId) {
      return this.waitForShares(conversation, chatId, action, buyer, target);
    }

    const raw = response.message.text.trim();
    if (EXIT_KEYWORDS.has(raw.toLowerCase())) {
      await replyToMessage(response, "Trade cancelled.");
      return;
    }

    const shares = parseInt(raw, 10);
    if (Number.isNaN(shares) || shares <= 0) {
      await replyToMessage(response, "Enter a positive whole number of shares, or send \"cancel\" to stop.");
      return this.waitForShares(conversation, chatId, action, buyer, target);
    }

    const result = await conversation.external(() =>
      action === "buy"
        ? this.storage.buyStock(chatId, {
            buyerUserId: buyer.userId,
            buyerFirstName: buyer.firstName,
            ...(buyer.username !== undefined && { buyerUsername: buyer.username }),
            targetUserId: target.userId,
            shares,
          })
        : this.storage.sellStock(chatId, {
            sellerUserId: buyer.userId,
            targetUserId: target.userId,
            shares,
          })
    );

    await this.sendTradeResult(response, action, result, target.firstName, target.ticker);
  }

  private async handleOptions(ctx: MyContext) {
    if (!ctx.chat || !ctx.from) {
      return;
    }
    try {
      await ctx.conversation.enter(OPTIONS_CONVERSATION);
    } catch {
      await replyToMessage(ctx, "Someone else has a command in progress in this chat — try /options again in a moment.");
    }
  }

  // /options always lands here — walks ticker picker (reusing buyableTickers, same filters as /buy) →
  // duration picker → strike picker (duration first, since strikes are duration-scoped — see
  // OPTION_STRIKE_PCTS_BY_DURATION) → a live quote → confirm/cancel. Kept as its own dialogue rather than
  // folded into tradeDialogue since every step's callback-data prefix and shape is different from /buy's.
  private async optionsDialogue(conversation: MyConversation, ctx: ConversationContext) {
    if (!ctx.chat || !ctx.from) {
      return;
    }
    const chatId = ctx.chat.id;
    const threadId = ctx.message?.message_thread_id;
    const buyer: { userId: number; firstName: string; username?: string } = {
      userId: ctx.from.id,
      firstName: ctx.from.first_name,
      ...(ctx.from.username !== undefined && { username: ctx.from.username }),
    };

    const options = await conversation.external(() => this.buyableTickers(chatId, buyer.userId));
    if (options.length === 0) {
      await ctx.reply("Nobody in this chat has set a ticker yet — ask them to /setticker first.", {
        ...(threadId !== undefined && { message_thread_id: threadId }),
      });
      return;
    }

    const tickerKeyboard = new InlineKeyboard();
    options.forEach((option, index) => {
      tickerKeyboard.text(`$${option.ticker} — ${option.firstName}`, `option_ticker:${option.ticker}`);
      if (index % 2 === 1) {
        tickerKeyboard.row();
      }
    });
    await ctx.reply(OPTIONS_BLURB, { reply_markup: tickerKeyboard, ...(threadId !== undefined && { message_thread_id: threadId }) });

    const target = await this.waitForOptionTicker(conversation, buyer.userId, options);
    if (!target) {
      return;
    }

    const durationKeyboard = new InlineKeyboard()
      .text("0D", "option_duration:0")
      .text("1D", "option_duration:1")
      .text("3D", "option_duration:3")
      .text("7D", "option_duration:7");
    await ctx.api.sendMessage(chatId, "Choose your expiration:", {
      reply_markup: durationKeyboard,
      ...(threadId !== undefined && { message_thread_id: threadId }),
    });
    const durationDays = await this.waitForDurationChoice(conversation, buyer.userId);
    if (durationDays === null) {
      return;
    }

    // Strikes are duration-scoped (see OPTION_STRIKE_PCTS_BY_DURATION) — a fixed 8% strike that's roughly
    // a coinflip at 0D would be close to free money by 7D, so each duration offers its own three-tier menu
    // instead of one fixed set, hence duration has to be picked before strike, not after.
    const [conservative, middle, aggressive] = OPTION_STRIKE_PCTS_BY_DURATION[durationDays];
    const strikeKeyboard = new InlineKeyboard()
      .text(`${conservative}% OTM`, `option_strike:${conservative}`)
      .text(`${middle}% OTM`, `option_strike:${middle}`)
      .text(`${aggressive}% OTM`, `option_strike:${aggressive}`);
    await ctx.api.sendMessage(chatId, "Choose your strike:", {
      reply_markup: strikeKeyboard,
      ...(threadId !== undefined && { message_thread_id: threadId }),
    });
    const strikePct = await this.waitForStrikeChoice(conversation, buyer.userId, durationDays);
    if (strikePct === null) {
      return;
    }

    const quote = await conversation.external(() => this.storage.quoteStockMarketOption(chatId, target.userId, strikePct, durationDays));
    if (!quote) {
      await ctx.api.sendMessage(chatId, `Couldn't quote $${target.ticker} anymore — they may have been delisted.`, {
        ...(threadId !== undefined && { message_thread_id: threadId }),
      });
      return;
    }

    const runway = this.formatDuration((quote.expiresAtEpochSec - quote.nowEpochSec) / 3600);
    const confirmKeyboard = new InlineKeyboard().text("Purchase", "option_confirm:yes").text("Cancel", "option_confirm:no");
    await ctx.api.sendMessage(
      chatId,
      `$${target.ticker} is at ${quote.underlyingPrice.toFixed(2)}. Strike: ${quote.strikePrice.toFixed(2)} (+${Math.round(strikePct * 100)}%). Expires in ~${runway}. Premium cost is ${quote.premium.toFixed(2)}. Confirm?`,
      { reply_markup: confirmKeyboard, ...(threadId !== undefined && { message_thread_id: threadId }) }
    );

    const confirmed = await this.waitForOptionConfirm(conversation, buyer.userId);
    if (confirmed === null) {
      // Already told the user it's cancelled — see waitForOptionConfirm's typed-cancel path.
      return;
    }
    if (!confirmed) {
      await ctx.api.sendMessage(chatId, "Cancelled — no premium charged.", { ...(threadId !== undefined && { message_thread_id: threadId }) });
      return;
    }

    // Recomputed fresh inside buyOption off the live price at this exact moment — may differ slightly
    // from the quote above if price moved during the picker steps. The confirmation message below reports
    // whatever actually got charged, not the earlier quote.
    const result = await conversation.external(() =>
      this.storage.buyStockMarketOption(chatId, {
        buyerUserId: buyer.userId,
        buyerFirstName: buyer.firstName,
        ...(buyer.username !== undefined && { buyerUsername: buyer.username }),
        underlyingUserId: target.userId,
        strikePct,
        durationDays,
      })
    );

    await ctx.api.sendMessage(chatId, this.optionResultMessage(result, target), {
      ...(threadId !== undefined && { message_thread_id: threadId }),
    });
  }

  // Shared by every /options picker step below — unlike /setticker and /buy's share-count prompt, none of
  // these steps has a text-typing path of its own to catch EXIT_KEYWORDS on, since they're pure button
  // pickers. This is the one place that matters here: races a callback query against a plain text message
  // on the same wait (grammY conversations only support one outstanding wait at a time, so this has to be
  // a single combined waitFor rather than two separate wait calls), and treats "stop"/"quit"/"exit"/"end"/
  // "cancel" as ending the whole dialogue regardless of which step it's typed at. Returns null on cancel,
  // otherwise the matched callback context for the caller to parse its own data out of.
  private async waitForOptionsCallback(conversation: MyConversation, userId: number): Promise<Filter<ConversationContext, "callback_query:data"> | null> {
    // The .and() predicate is what keeps this from freezing the whole chat: without it, EVERY text
    // message from ANYONE (not just userId) would type-match "message:text" and get swallowed into the
    // conversation — silently blocking price scoring, /portfolio, everything else — for as long as this
    // dialogue stays open. Only text that's actually a cancel keyword gets pulled in; everything else
    // fails the predicate and, with next:true, flows straight through to the rest of the middleware
    // instead of being consumed. The outer waitFor's own next:true covers the remaining case (an update
    // that's neither a callback query nor text at all, e.g. a sticker) the same way.
    const response = await conversation
      .waitFor(["callback_query:data", "message:text"], { next: true })
      .and((ctx) => !ctx.message || EXIT_KEYWORDS.has(ctx.message.text.trim().toLowerCase()), { next: true });

    if (response.message) {
      if (response.from?.id !== userId) {
        return this.waitForOptionsCallback(conversation, userId);
      }
      // Reaching here means the .and() predicate already confirmed this is a cancel keyword.
      await replyToMessage(response, "Cancelled — no premium charged.");
      return null;
    }

    if (response.callbackQuery.from.id !== userId) {
      await response.answerCallbackQuery({ text: "This isn't your trade to make.", show_alert: true });
      return this.waitForOptionsCallback(conversation, userId);
    }

    return response;
  }

  private async waitForOptionTicker(conversation: MyConversation, userId: number, options: TickerOption[]): Promise<TickerOption | null> {
    const response = await this.waitForOptionsCallback(conversation, userId);
    if (!response) {
      return null;
    }

    const ticker = response.callbackQuery.data?.slice("option_ticker:".length);
    const match = options.find((option) => option.ticker === ticker);
    if (!match) {
      await response.answerCallbackQuery({ text: "That option isn't available anymore.", show_alert: true });
      return null;
    }

    await response.answerCallbackQuery();
    await response.editMessageText(`Selected $${match.ticker} (${match.firstName}) for a long call.`);
    return match;
  }

  private async waitForStrikeChoice(
    conversation: MyConversation,
    userId: number,
    durationDays: StockMarketOptionDurationDays
  ): Promise<StockMarketOptionStrikePct | null> {
    const response = await this.waitForOptionsCallback(conversation, userId);
    if (!response) {
      return null;
    }

    const raw = response.callbackQuery.data?.slice("option_strike:".length);
    const rawNum = raw !== undefined ? Number(raw) : undefined;
    const pct = raw !== undefined ? STRIKE_PCT_BY_CALLBACK[raw] : undefined;
    // Validated against the ALREADY-CHOSEN duration's own menu, not just any known percentage — a stale
    // button from a different duration's strike keyboard (e.g. two /options attempts in flight) shouldn't
    // silently succeed with the wrong duration's pricing tier.
    if (pct === undefined || rawNum === undefined || !OPTION_STRIKE_PCTS_BY_DURATION[durationDays].includes(rawNum)) {
      await response.answerCallbackQuery({ text: "That option isn't available anymore.", show_alert: true });
      return null;
    }

    await response.answerCallbackQuery();
    await response.editMessageText(`Strike: ${raw}% OTM`);
    return pct;
  }

  private async waitForDurationChoice(conversation: MyConversation, userId: number): Promise<StockMarketOptionDurationDays | null> {
    const response = await this.waitForOptionsCallback(conversation, userId);
    if (!response) {
      return null;
    }

    const raw = response.callbackQuery.data?.slice("option_duration:".length);
    const days = raw !== undefined ? DURATION_DAYS_BY_CALLBACK[raw] : undefined;
    if (days === undefined) {
      await response.answerCallbackQuery({ text: "That option isn't available anymore.", show_alert: true });
      return null;
    }

    await response.answerCallbackQuery();
    await response.editMessageText(`Expiration: ${raw}D`);
    return days;
  }

  // null specifically means "already told the user it's cancelled" (waitForOptionsCallback's typed-cancel
  // path already replied) — distinct from false ("Cancel" button pressed), which still needs
  // optionsDialogue's own message, so the two paths don't end up sending the cancellation notice twice.
  private async waitForOptionConfirm(conversation: MyConversation, userId: number): Promise<boolean | null> {
    const response = await this.waitForOptionsCallback(conversation, userId);
    if (!response) {
      return null;
    }

    const choice = response.callbackQuery.data?.slice("option_confirm:".length);
    await response.answerCallbackQuery();
    await response.editMessageText(choice === "yes" ? "Purchasing..." : "Cancelled.");
    return choice === "yes";
  }

  private optionResultMessage(result: StockMarketBuyOptionResult, target: TickerOption): string {
    if (!result.ok) {
      switch (result.type) {
        case "INVALID_TERMS":
          return "Those terms aren't valid anymore — try /options again.";
        case "CANNOT_TRADE_SELF":
          return "You can't buy an option on your own stock.";
        case "UNKNOWN_STOCK":
          return `Couldn't find $${target.ticker} anymore.`;
        case "HALTED":
          return "Trading in that stock has been halted pending review of irregular activity. No further comment will be provided.";
        case "INSUFFICIENT_CASH":
          return "You don't have enough cash for that premium.";
        case "BLOCKED":
          return "You've been delisted from this exchange. Regulatory action is final.";
      }
    }
    return `📈 Bought a call on $${target.ticker} (${target.firstName}) — strike ${result.strikePrice.toFixed(2)}, premium ${result.premium.toFixed(2)}. Settles at the next matching 5pm ET rollover.`;
  }

  private parseTradeCommand(ctx: MyContext): TradeCommand | null {
    const repliedTo = realReplyTo(ctx)?.from;
    const args = String(ctx.match ?? "").trim().split(/\s+/).filter(Boolean);

    if (repliedTo) {
      const shares = parseInt(args[0] ?? "", 10);
      if (Number.isNaN(shares) || shares <= 0) {
        return null;
      }
      return { replyUserId: repliedTo.id, replyIsBot: repliedTo.is_bot, replyFirstName: repliedTo.first_name, shares };
    }

    if (args.length === 2 && args[0]?.startsWith("$")) {
      const ticker = args[0].slice(1);
      const shares = parseInt(args[1] ?? "", 10);
      if (!TICKER_PATTERN.test(ticker) || Number.isNaN(shares) || shares <= 0) {
        return null;
      }
      return { ticker: ticker.toUpperCase(), shares };
    }

    return null;
  }

  private tradeErrorMessage(type: StockMarketTradeErrorType): string {
    switch (type) {
      case "INVALID_AMOUNT":
        return "Enter a positive number of shares.";
      case "CANNOT_TRADE_SELF":
        return "You can't trade your own stock.";
      case "UNKNOWN_STOCK":
        return "That person doesn't have a stock yet — they need to post something first.";
      case "INSUFFICIENT_CASH":
        return "You don't have enough cash for that.";
      case "INSUFFICIENT_SHARES":
        return "You don't own that many shares.";
      case "HALTED":
        return "Trading in that stock has been halted pending review of irregular activity. No further comment will be provided.";
      case "BLOCKED":
        return "You've been delisted from this exchange. Regulatory action is final.";
      case "OPTIONS_CONFLICT":
        return "You're holding an open option on them — the anti-pump guard is on for this chat, so you can't trade their shares until it settles or the guard's turned off.";
    }
  }

  // Owner path for both /delist and /reset — same reply-or-$TICKER targeting /buy and /sell already use.
  // Everyone else (including any chat member at all, if no owner is configured) falls through to the
  // self-service, confirmation-gated path instead, and can only ever target themselves.
  private async handleRemoval(ctx: MyContext, kind: "delist" | "reset") {
    if (!ctx.chat || !ctx.from) {
      return;
    }

    if (this.ownerChatId === undefined || ctx.from.id !== this.ownerChatId) {
      await this.confirmSelfRemoval(ctx, kind);
      return;
    }

    const repliedTo = realReplyTo(ctx)?.from;
    const arg = String(ctx.match ?? "").trim();

    let target: RemovalTarget;
    if (repliedTo) {
      target = { userId: repliedTo.id, firstName: repliedTo.first_name };
    } else if (arg.startsWith("$")) {
      const found = await this.storage.findStockMarketPlayerByTicker(ctx.chat.id, arg.slice(1));
      if (!found) {
        await replyToMessage(ctx, `Couldn't find ${arg} in this chat's market.`);
        return;
      }
      target = { userId: found.userId, firstName: found.firstName };
    } else {
      await replyToMessage(ctx, `Reply to their message with /${kind}, or use /${kind} $TICKER if they set one.`);
      return;
    }

    // Silent on purpose — the owner triggering this isn't something the chat needs announced, unlike the
    // self-service path above (confirmSelfRemoval/handleSelfRemovalCallback), which does reply since the
    // person removing themselves is the one who needs the outcome confirmed.
    await this.performRemoval(ctx.chat.id, kind, target.userId);
  }

  // Self-targeting only, and gated behind a confirmation — unlike the owner path, this is one tap away
  // from a bare command with no reply/ticker to double-check against, and /delist's lockout is permanent.
  // The target userId rides along in the callback data itself (see handleSelfRemovalCallback) rather than
  // any session, since this is a single request/response, not a multi-step conversation.
  private async confirmSelfRemoval(ctx: MyContext, kind: "delist" | "reset"): Promise<void> {
    if (!ctx.chat || !ctx.from) {
      return;
    }

    const keyboard = new InlineKeyboard()
      .text(kind === "delist" ? "Yes, delist me" : "Yes, reset me", `${kind}:confirm:${ctx.from.id}`)
      .text("Cancel", `${kind}:cancel:${ctx.from.id}`);

    const warning =
      kind === "delist"
        ? "This cashes out everyone holding your stock at today's price and pulls you off the market for good — you will NOT be able to rejoin by posting again. Sure?"
        : "This cashes out everyone holding your stock at today's price and pulls you off the market — you'll start fresh automatically the next time you post. Sure?";

    await ctx.reply(warning, {
      reply_markup: keyboard,
      ...(ctx.message?.message_id !== undefined && { reply_to_message_id: ctx.message.message_id }),
      ...(ctx.message?.message_thread_id !== undefined && { message_thread_id: ctx.message.message_thread_id }),
    });
  }

  // Only the person the confirmation was sent to can answer it — enforced by comparing the presser's id
  // against the userId embedded in the callback data, same guard shape as waitForTickerChoice's userId
  // check for /buy and /sell's picker.
  private async handleSelfRemovalCallback(ctx: MyContext): Promise<void> {
    const match = ctx.callbackQuery?.data?.match(/^(delist|reset):(confirm|cancel):(\d+)$/);
    if (!match || !ctx.chat || !ctx.callbackQuery) {
      return;
    }
    const kind = match[1] as "delist" | "reset";
    const action = match[2] as "confirm" | "cancel";
    const targetUserId = Number(match[3]);

    if (ctx.callbackQuery.from.id !== targetUserId) {
      await ctx.answerCallbackQuery({ text: "This isn't your confirmation to answer.", show_alert: true });
      return;
    }

    if (action === "cancel") {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText("Cancelled — you're still on the market.");
      return;
    }

    await ctx.answerCallbackQuery();
    const removed = await this.performRemoval(ctx.chat.id, kind, targetUserId);
    const message = !removed
      ? "You weren't in the market."
      : kind === "delist"
        ? "You're delisted. Everyone holding your stock got cashed out at today's price. You will not be able to rejoin by posting again."
        : "You're reset. Everyone holding your stock got cashed out at today's price — post again anytime to start fresh.";
    await ctx.editMessageText(message);
  }

  private performRemoval(chatId: number, kind: "delist" | "reset", userId: number): Promise<boolean> {
    return kind === "delist" ? this.storage.delistStockMarketPlayer(chatId, userId) : this.storage.resetStockMarketPlayer(chatId, userId);
  }

  // Owner-only. Flat cash injection to every active player in this chat's market at once — /stimulus 1000
  // gives everyone $1000, no target to pick. Cash only, same as awardCash: doesn't touch price, doesn't
  // care about halts. Announced chat-wide (via sendMarketAnnouncement) since, unlike the owner path on
  // /delist and /reset, this is very much something the whole chat needs to know just happened.
  private async handleStimulus(ctx: MyContext) {
    if (!ctx.chat || !ctx.from) {
      return;
    }
    if (this.ownerChatId === undefined || ctx.from.id !== this.ownerChatId) {
      return;
    }

    const amount = Number(String(ctx.match ?? "").trim());
    if (!Number.isFinite(amount) || amount <= 0) {
      await replyToMessage(ctx, "Usage: /stimulus <amount>, e.g. /stimulus 1000");
      return;
    }

    const count = await this.storage.stimulusStockMarket(ctx.chat.id, amount);
    if (count === 0) {
      await replyToMessage(ctx, "No active players in this chat's market yet.");
      return;
    }

    await this.sendMarketAnnouncement(ctx, random(STIMULUS_MESSAGES)(amount.toFixed(2), count, count === 1 ? "" : "s"));
  }

  /** Driven by main.ts's scheduled() handler — no Telegram messages to send, just storage mutations. */

  async runDailyDecay(): Promise<void> {
    const chatIds = await this.storage.listStockMarketChats();
    for (const chatId of chatIds) {
      await this.storage.applyStockMarketDailyDecay(chatId);
    }
  }

  async runWeeklyAllowance(): Promise<void> {
    const chatIds = await this.storage.listStockMarketChats();
    for (const chatId of chatIds) {
      await this.storage.applyStockMarketWeeklyAllowance(chatId);
    }
  }

  // Same daily-morning cron as runDailyHaltCheck (see main.ts's DAILY_MORNING_CRON) — moved here from the
  // weekly cron since message_authors/price_events accumulate on every message, and a week between purges
  // let them grow much larger than a day between purges ever would. Purely storage mutation, nothing to
  // announce, so kept separate from runDailyHaltCheck the same way runDailyDecay is kept separate from it.
  async runDailyCleanup(): Promise<void> {
    const chatIds = await this.storage.listStockMarketChats();
    for (const chatId of chatIds) {
      await this.storage.purgeStockMarketOldData(chatId);
      await this.storage.purgeStockMarketGhostPlayers(chatId);
    }
  }

  // Same daily cron as runDailyDecay, kept separate since this one needs an Api to announce the halt (if
  // any) — runDailyDecay is pure storage mutation with nothing to say. Posts into whichever topic was set
  // via /setmarketthread, if any — otherwise falls back to the General topic / main chat, same as before
  // that command existed.
  async runDailyHaltCheck(api: Api): Promise<void> {
    const chatIds = await this.storage.listStockMarketChats();
    for (const chatId of chatIds) {
      const halted = await this.storage.rollStockMarketHalt(chatId);
      if (!halted) {
        continue;
      }
      const label = halted.ticker ? `$${halted.ticker} (${halted.firstName})` : halted.firstName;
      const threadId = await this.storage.getStockMarketAnnouncementThread(chatId);
      await api.sendMessage(
        chatId,
        `🚨 Trading in ${label} has been halted for 24 hours pending review of irregular activity. No further comment will be provided.`,
        { ...(threadId !== null && { message_thread_id: threadId }) }
      );
    }
  }

  // Driven by its own 5pm-ET cron (see OPTIONS_SETTLEMENT_CRON in main.ts) — separate from the other
  // three since it's the only one that needs to fire at that specific boundary. Batches every settled
  // contract in a chat into ONE message (not one send per contract) — several contracts settling in the
  // same run would otherwise risk Telegram's per-chat rate limit and just read as spam.
  async runOptionsSettlement(api: Api): Promise<void> {
    const chatIds = await this.storage.listStockMarketChats();
    for (const chatId of chatIds) {
      const settlements = await this.storage.settleStockMarketOptions(chatId);
      if (settlements.length === 0) {
        continue;
      }

      const threadId = await this.storage.getStockMarketAnnouncementThread(chatId);
      const lines = settlements.map((s) => {
        const buyerLabel = this.formatTaggedLabel(s.buyerUserId, s.buyerFirstName, s.buyerTicker);
        const underlyingLabel = this.formatTaggedLabel(s.underlyingUserId, s.underlyingFirstName, s.underlyingTicker);
        return s.payout > 0
          ? random(OPTIONS_ITM_MESSAGES)(buyerLabel, underlyingLabel, s.payout)
          : random(OPTIONS_WORTHLESS_MESSAGES)(buyerLabel, underlyingLabel);
      });

      await api.sendMessage(chatId, [`⏰ <b>Options settlement</b>`, ...lines].join("\n"), {
        parse_mode: "HTML",
        ...(threadId !== null && { message_thread_id: threadId }),
      });
    }
  }
}
