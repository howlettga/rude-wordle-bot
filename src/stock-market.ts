import { Composer } from "grammy";
import type { NextFunction } from "grammy";
import { type MyContext, replyToMessage, replyHTML } from "./context.js";
import type { StorageService } from "./storage-service.js";
import type {
  StockMarketPlayer,
  StockMarketPortfolio,
  StockMarketTradeErrorType,
} from "./durable-objects/stock-market.js";

const TICKER_PATTERN = /^[A-Za-z]{1,4}$/;

// Column widths for /market's aligned metrics line (see formatMarketMetrics) — wide enough for a
// four-digit price and a ▲/▼ + sign + two-decimal change with room to spare, so the percent that
// follows lines up across every row regardless of how long the preceding numbers are.
const MARKET_PRICE_WIDTH = 9;
const MARKET_CHANGE_WIDTH = 10;

type TradeCommand = { shares: number } & ({ replyUserId: number; replyIsBot: boolean; replyFirstName: string } | { ticker: string });

export class StockMarketComposer extends Composer<MyContext> {
  constructor(private storage: StorageService) {
    super();
    this.command("portfolio", (ctx) => this.sendPortfolio(ctx));
    this.command("market", (ctx) => this.sendMarket(ctx));
    this.command("value", (ctx) => this.sendValue(ctx));
    this.command("setticker", (ctx) => this.handleSetTicker(ctx));
    this.command("buy", (ctx) => this.handleTrade(ctx, "buy"));
    this.command("sell", (ctx) => this.handleTrade(ctx, "sell"));
    this.on("message", (ctx, next) => this.trackActivity(ctx, next));
    this.on("message_reaction", (ctx) => this.trackReaction(ctx));
  }

  // Opt-in short handle for /buy and /sell targeting (see handleTrade) — replaces @username entirely for
  // trades, since not everyone has one and that was confusing people. Requires having posted a real
  // message already (same reach restriction as findPlayerByTicker) so a ticker never outlives its player
  // past the weekly ghost purge.
  private async handleSetTicker(ctx: MyContext) {
    if (!ctx.chat || !ctx.from) {
      return;
    }

    const raw = String(ctx.match ?? "").trim();
    if (!TICKER_PATTERN.test(raw)) {
      await replyToMessage(ctx, "Ticker must be 1-4 letters, e.g. /setticker ABCD.");
      return;
    }
    const ticker = raw.toUpperCase();

    const result = await this.storage.setStockMarketTicker(ctx.chat.id, ctx.from.id, ticker);
    if (result === "NOT_A_PLAYER") {
      await replyToMessage(ctx, "Post something in the chat first before you can set a ticker.");
      return;
    }
    if (result === "TAKEN") {
      await replyToMessage(ctx, `$${ticker} is already taken by someone else in this chat.`);
      return;
    }

    await replyToMessage(ctx, `Your ticker is now $${ticker}.`);
  }

  // Runs on every message in the chat — any type, not just text, and not just commands — that's the whole
  // point (price is driven by ambient activity). Always calls next() so it never interferes with any other
  // feature's handlers.
  private async trackActivity(ctx: MyContext, next: NextFunction) {
    const isCommand = ctx.message?.text?.startsWith("/") ?? false;
    if (ctx.from && ctx.chat && ctx.message && !ctx.from.is_bot && !isCommand) {
      await this.storage.recordStockMarketMessage(ctx.chat.id, {
        messageId: ctx.message.message_id,
        userId: ctx.from.id,
        ...(ctx.from.username !== undefined && { username: ctx.from.username }),
        firstName: ctx.from.first_name,
      });

      const repliedTo = ctx.message.reply_to_message?.from;
      if (repliedTo && !repliedTo.is_bot && repliedTo.id !== ctx.from.id) {
        await this.storage.recordStockMarketReply(ctx.chat.id, {
          recipientUserId: repliedTo.id,
          ...(repliedTo.username !== undefined && { recipientUsername: repliedTo.username }),
          recipientFirstName: repliedTo.first_name,
          replierUserId: ctx.from.id,
        });
      }
    }

    await next();
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
      `<b>${portfolio.firstName}'s Portfolio ${portfolio.ticker ? `(${portfolio.ticker})` : ''}</b>`,
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
          `${this.formatLabel(holding.firstName, holding.ticker)}:`,
          `   ${holding.shares} @ <code>${holding.price.toFixed(2)}</code> ${this.formatPercentOnly(holding.dailyChange, holding.price)} = <code>${holding.value.toFixed(2)}</code>`
        );
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
      lines.push(`${index + 1}. ${this.formatLabel(player.firstName, player.ticker)}`);
      lines.push(`    ${this.formatMarketMetrics(player.price, player.dailyChange)}`);
    });
    return lines.join("\n");
  }

  private formatLabel(firstName: string, ticker: string | null): string {
    return ticker ? `${firstName} (${ticker})` : firstName;
  }

  // Shared math behind formatChange and formatMarketMetrics: today's price movement, both absolute and
  // percent versus this morning's (UTC midnight) opening price (price - change). Every row gets the same
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

    await replyHTML(ctx, `${this.formatLabel(target.firstName, target.ticker)}'s stock is worth <code>${target.price.toFixed(2)}</code>.`);
  }

  private async resolveValueTarget(ctx: MyContext): Promise<StockMarketPlayer | null> {
    if (!ctx.chat) {
      return null;
    }

    const repliedTo = ctx.message?.reply_to_message?.from;
    return repliedTo ? this.storage.getStockMarketPlayer(ctx.chat.id, repliedTo.id) : null;
  }

  // Both /buy and /sell can target whoever's message you're replying to, or an explicit /buy $TICKER <n>.
  // Reply wins if both are somehow present. Ticker lookup only reaches someone who's set one via
  // /setticker (which itself requires having already posted) — targeting used to fall back to Telegram
  // @username, but not everyone has one, which was confusing people, so tickers replaced it entirely here.
  private async handleTrade(ctx: MyContext, action: "buy" | "sell") {
    if (!ctx.chat || !ctx.from) {
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

    if ("replyUserId" in parsed) {
      if (parsed.replyIsBot) {
        await replyToMessage(ctx, "Bots don't trade on this exchange.");
        return;
      }
      targetUserId = parsed.replyUserId;
      targetFirstName = parsed.replyFirstName;
    } else {
      const found = await this.storage.findStockMarketPlayerByTicker(ctx.chat.id, parsed.ticker);
      if (!found) {
        await replyToMessage(ctx, `Couldn't find $${parsed.ticker} — check the ticker, or ask them to set one with /setticker.`);
        return;
      }
      targetUserId = found.userId;
      targetFirstName = found.firstName;
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

    if (!result.ok) {
      await replyToMessage(ctx, this.tradeErrorMessage(result.type));
      return;
    }

    const verb = action === "buy" ? "Bought" : "Sold";
    const holdingNote =
      result.totalShares > 0
        ? `You now hold ${result.totalShares} share${result.totalShares === 1 ? "" : "s"} of ${targetFirstName}.`
        : `You no longer hold any shares of ${targetFirstName}.`;
    await replyToMessage(
      ctx,
      `${verb} ${result.shares} share${result.shares === 1 ? "" : "s"} of ${targetFirstName} at ${result.price.toFixed(2)} each — total ${result.total.toFixed(2)}.\n${holdingNote}`
    );
  }

  private parseTradeCommand(ctx: MyContext): TradeCommand | null {
    const repliedTo = ctx.message?.reply_to_message?.from;
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
    }
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
      await this.storage.purgeStockMarketOldData(chatId);
      await this.storage.purgeStockMarketGhostPlayers(chatId);
    }
  }
}
