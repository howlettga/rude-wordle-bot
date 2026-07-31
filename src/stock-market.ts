import { Composer } from "grammy";
import type { NextFunction } from "grammy";
import { type MyContext, replyToMessage, replyHTML } from "./context.js";
import type { StorageService } from "./storage-service.js";
import type {
  StockMarketPlayer,
  StockMarketPortfolio,
  StockMarketTradeErrorType,
} from "./durable-objects/stock-market.js";

type TradeCommand = { shares: number } & ({ replyUserId: number; replyIsBot: boolean; replyFirstName: string } | { username: string });

export class StockMarketComposer extends Composer<MyContext> {
  constructor(private storage: StorageService) {
    super();
    this.command("portfolio", (ctx) => this.sendPortfolio(ctx));
    this.command("market", (ctx) => this.sendMarket(ctx));
    this.command("value", (ctx) => this.sendValue(ctx));
    this.command("buy", (ctx) => this.handleTrade(ctx, "buy"));
    this.command("sell", (ctx) => this.handleTrade(ctx, "sell"));
    this.on("message", (ctx, next) => this.trackActivity(ctx, next));
    this.on("message_reaction", (ctx) => this.trackReaction(ctx));
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
      `<b>${portfolio.firstName}'s Portfolio</b>`,
      `-----`,
      `Stock value: <code>${portfolio.price.toFixed(2)}</code>`,
      `Cash: <code>${portfolio.cash.toFixed(2)}</code>`,
    ];

    if (portfolio.holdings.length === 0) {
      lines.push(``, `No holdings yet — reply to someone's message with <code>/buy 2</code> to invest in them.`);
    } else {
      lines.push(`-----`, `Holdings:`, ``);
      for (const holding of portfolio.holdings) {
        lines.push(
          `${holding.firstName}: ${holding.shares} @ <code>${holding.price.toFixed(2)}</code> = <code>${holding.value.toFixed(2)}</code>`
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

  private formatMarket(players: StockMarketPlayer[]): string {
    const lines = [`<b>Market</b>`, `-----`];
    players.forEach((player, index) => {
      lines.push(`${index + 1}. ${player.firstName}: <code>${player.price.toFixed(2)}</code>`);
    });
    return lines.join("\n");
  }

  // Same targeting convention as /buy and /sell: reply to their message, or /value @username.
  private async sendValue(ctx: MyContext) {
    const target = await this.resolveValueTarget(ctx);
    if (!target) {
      await replyToMessage(ctx, "Reply to someone's message with /value, or use /value @username, to check their stock.");
      return;
    }

    await replyHTML(ctx, `${target.firstName}'s stock is worth <code>${target.price.toFixed(2)}</code>.`);
  }

  private async resolveValueTarget(ctx: MyContext): Promise<StockMarketPlayer | null> {
    if (!ctx.chat) {
      return null;
    }

    const repliedTo = ctx.message?.reply_to_message?.from;
    if (repliedTo) {
      return this.storage.getStockMarketPlayer(ctx.chat.id, repliedTo.id);
    }

    const arg = String(ctx.match ?? "").trim();
    if (arg.startsWith("@")) {
      return this.storage.findStockMarketPlayerByUsername(ctx.chat.id, arg.slice(1));
    }

    return null;
  }

  // Both /buy and /sell can target whoever's message you're replying to, or an explicit /buy @username <n>.
  // Reply wins if both are somehow present. Username lookup only reaches someone who's already posted in
  // this chat (and therefore has a stock) — same reach as reply-based targeting, just a different way in.
  private async handleTrade(ctx: MyContext, action: "buy" | "sell") {
    if (!ctx.chat || !ctx.from) {
      return;
    }

    const parsed = this.parseTradeCommand(ctx);
    if (!parsed) {
      await replyToMessage(
        ctx,
        `Reply to someone's message with /${action} <shares>, or use /${action} @username <shares>.`
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
      const found = await this.storage.findStockMarketPlayerByUsername(ctx.chat.id, parsed.username);
      if (!found) {
        await replyToMessage(ctx, `Couldn't find @${parsed.username} — they need to have posted in this chat before.`);
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

    if (args.length === 2 && args[0]?.startsWith("@")) {
      const shares = parseInt(args[1] ?? "", 10);
      if (Number.isNaN(shares) || shares <= 0) {
        return null;
      }
      return { username: args[0].slice(1), shares };
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
    }
  }
}
