import { Composer } from "grammy";
import { type MyContext, replyToMessage, replyHTML } from "./context.js";
import type { StorageService } from "./storage-service.js";
import type { FishingLeaderboardEntry } from "./durable-objects/fishing.js";
import { escapeHtml } from "./util.js";

// The "fishing" feature (see features.ts):
//   /fish                         -> one cast per day; reports the catch, plus personal best / rank / chat
//                                    record lines when they apply — or, now and then, worthless junk. The
//                                    roll math (fishing-math.ts) is deliberately never shown.
//   /fishing                      -> leaderboard: everyone's heaviest catch, ranked by weight
//   /fishingwindow <days>|forever -> owner-only: how far back the leaderboard looks (default forever)
//   /resetfishing                 -> owner-only: leaderboard starts over; nothing is deleted
// Owner-only commands ignore anyone else silently, same as the other owner commands.
const LEADERBOARD_SIZE = 10;
const MAX_WINDOW_DAYS = 36500;
const MEDALS = ["🥇", "🥈", "🥉"];

export class FishingComposer extends Composer<MyContext> {
  constructor(
    private storage: StorageService,
    private ownerChatId: number | undefined
  ) {
    super();
    this.command("fish", (ctx) => this.handleFish(ctx));
    this.command("fishing", (ctx) => this.sendLeaderboard(ctx));
    this.command("fishingwindow", (ctx) => this.handleSetWindow(ctx));
    this.command("resetfishing", (ctx) => this.handleReset(ctx));
  }

  private isOwner(ctx: MyContext): boolean {
    return this.ownerChatId !== undefined && ctx.from?.id === this.ownerChatId;
  }

  private async handleFish(ctx: MyContext) {
    if (!ctx.from || !ctx.chat) {
      return;
    }

    const result = await this.storage.castFishing(ctx.chat.id, {
      userId: ctx.from.id,
      ...(ctx.from.username !== undefined && { username: ctx.from.username }),
      firstName: ctx.from.first_name,
    });
    if (!result.ok) {
      await replyToMessage(ctx, "You already fished today. Come back tomorrow.");
      return;
    }
    if (result.kind === "trash") {
      const tagline = result.overfished ? "Nothing good comes from overfished waters." : "Worthless.";
      await replyToMessage(ctx, [`You reeled in ${result.item}! ${result.emoji}`, tagline, ...tideLine(result.highTide)].join("\n"));
      return;
    }

    const { species, emoji, weight } = result.catch;
    const weightText = weight.toFixed(1);
    const lines = [`You caught ${article(weightText)} ${weightText} lbs ${species}! ${emoji}`];
    if (result.chatRecord) {
      lines.push(`🏆 New chat record!`);
    } else if (result.previousBest === null) {
      lines.push(`You're #${result.rank} on the leaderboard.`);
    } else if (weight > result.previousBest) {
      lines.push(`New personal best! You're #${result.rank} on the leaderboard.`);
    }
    lines.push(...tideLine(result.highTide));
    await replyToMessage(ctx, lines.join("\n"));
  }

  private async sendLeaderboard(ctx: MyContext) {
    if (!ctx.chat) {
      return;
    }

    const { entries, windowDays } = await this.storage.getFishingLeaderboard(ctx.chat.id);
    const title = `🎣 <b>Fishing leaderboard</b>${windowDays !== null ? ` (last ${windowDays} days)` : ""}`;
    if (entries.length === 0) {
      await replyHTML(ctx, `${title}\n\nNobody's caught anything yet. Use /fish to cast a line.`);
      return;
    }

    const lines = entries.slice(0, LEADERBOARD_SIZE).map((entry, index) => formatEntry(entry, index));
    await replyHTML(ctx, [title, ``, ...lines].join("\n"));
  }

  private async handleSetWindow(ctx: MyContext) {
    if (!this.isOwner(ctx) || !ctx.chat) {
      return;
    }

    const arg = String(ctx.match ?? "").trim().toLowerCase();
    const days = arg === "forever" ? null : /^\d+$/.test(arg) ? Number(arg) : NaN;
    if (days !== null && !(days >= 1 && days <= MAX_WINDOW_DAYS)) {
      const { windowDays } = await this.storage.getFishingLeaderboard(ctx.chat.id);
      await replyToMessage(
        ctx,
        `Leaderboard window: ${windowDays === null ? "forever" : `last ${windowDays} days`}.\nUsage: /fishingwindow <days>|forever`
      );
      return;
    }

    await this.storage.setFishingWindow(ctx.chat.id, days);
    await replyToMessage(ctx, `Leaderboard window set to ${days === null ? "forever" : `the last ${days} days`}.`);
  }

  private async handleReset(ctx: MyContext) {
    if (!this.isOwner(ctx) || !ctx.chat) {
      return;
    }

    await this.storage.resetFishing(ctx.chat.id);
    await replyToMessage(ctx, "Fishing leaderboard reset. Earlier catches no longer count.");
  }
}

// The only hint tides exist at all. King tides read the same, so they stay a surprise.
function tideLine(highTide: boolean): string[] {
  return highTide ? ["🌊 High tide today!"] : [];
}

function formatEntry(entry: FishingLeaderboardEntry, index: number): string {
  const place = MEDALS[index] ?? `${index + 1}.`;
  return `${place} ${escapeHtml(entry.firstName)} — ${entry.weight.toFixed(1)} lbs ${entry.species} ${entry.emoji}`;
}

// "an 8.2 lbs", "an 11.0 lbs", "an 18.4 lbs" — every other weight reads with "a".
function article(weightText: string): string {
  const whole = weightText.split(".")[0]!;
  return whole.startsWith("8") || whole === "11" || whole === "18" ? "an" : "a";
}
