import { Composer } from "grammy";
import { type MyContext, replyToMessage, replyHTML } from "./context.js";
import type { StorageService } from "./storage-service.js";
import type { FishingLeaderboardEntry } from "./durable-objects/fishing.js";
import type { FeatureFlags } from "./features.js";
import { rotatingLine } from "./fishing-math.js";
import { HIGH_TIDE_LINES, HINT_LINES, JUNK_LINES, LAKE_LINES } from "./fishing-lines.js";
import { petDesireLine } from "./pet.js";
import { escapeHtml } from "./util.js";

// The "fishing" feature (see features.ts):
//   /fish                         -> one cast per day; reports the catch, plus personal best / rank / chat
//                                    record lines when they apply — or, now and then, worthless junk. Then
//                                    a line on how busy the lake is today, a hint about a poor catch, and
//                                    the pet begging when it's hungry. The roll math (fishing-math.ts) is
//                                    deliberately never shown, and neither is anyone's bucket.
//   /fishing                      -> leaderboard: everyone's heaviest catch, ranked by weight
//   /fishingwindow <days>|forever -> owner-only: how far back the leaderboard looks (default forever)
//   /resetfishing                 -> owner-only: leaderboard starts over; nothing is deleted
// Owner-only commands ignore anyone else silently, same as the other owner commands.
const MAX_WINDOW_DAYS = 36500;
// Telegram rejects messages over 4096 characters; the leaderboard stops a little short and says how many
// it left off.
const MAX_MESSAGE_CHARS = 3900;
const MEDALS = ["🥇", "🥈", "🥉"];

export class FishingComposer extends Composer<MyContext> {
  constructor(
    private storage: StorageService,
    private ownerChatId: number | undefined,
    private features: (ctx: MyContext) => Promise<FeatureFlags>
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

    const chatId = ctx.chat.id;
    const result = await this.storage.castFishing(chatId, {
      userId: ctx.from.id,
      ...(ctx.from.username !== undefined && { username: ctx.from.username }),
      firstName: ctx.from.first_name,
    });
    if (!result.ok) {
      await replyToMessage(ctx, "You already fished today. Come back tomorrow.");
      return;
    }
    // Every flavor line rotates through its set (see fishing-lines.ts), keyed to this chat's day and
    // stepped by the cast count, so two casts the same day don't get the same line.
    const pick = (lines: readonly string[], set: string) =>
      rotatingLine(lines, `${chatId}:${result.date}:${set}`, result.castsToday);
    const lines: string[] = [];
    if (result.kind === "trash") {
      lines.push(`You reeled in ${result.item}! ${result.emoji}`, pick(JUNK_LINES, "junk"));
    } else {
      const { species, emoji, weight } = result.catch;
      const weightText = weight.toFixed(1);
      lines.push(`You caught ${article(weightText)} ${weightText} lbs ${species}! ${emoji}`);
      if (result.chatRecord) {
        lines.push(`🏆 New chat record!`);
      } else if (result.previousBest === null) {
        lines.push(`You're #${result.rank} on the leaderboard.`);
      } else if (weight > result.previousBest) {
        lines.push(`New personal best! You're #${result.rank} on the leaderboard.`);
      }
    }
    lines.push(pick(LAKE_LINES[result.lake], `lake:${result.lake}`));
    if (result.hint) {
      lines.push(pick(HINT_LINES[result.hint], `hint:${result.hint}`));
    }
    if (result.highTide) {
      lines.push(pick(HIGH_TIDE_LINES, "tide"));
    }
    const begging = await this.petBegging(ctx, result.kind);
    if (begging) {
      lines.push(begging);
    }
    await replyToMessage(ctx, lines.join("\n"));
  }

  // The chat's pet, if it's hungry or lonely, begging at the end of the reply (see petDesireLine). A pet
  // problem never costs anyone their catch reply.
  private async petBegging(ctx: MyContext, caught: "fish" | "trash"): Promise<string | null> {
    try {
      if (!ctx.chat || !(await this.features(ctx)).pet.enabled) {
        return null;
      }
      const pet = await this.storage.peekPet(ctx.chat.id);
      return pet ? petDesireLine(pet, caught) : null;
    } catch (err) {
      console.error(err);
      return null;
    }
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

    // Everyone who's caught something, as far as fits in one message.
    let text = `${title}\n`;
    let shown = 0;
    for (const [index, entry] of entries.entries()) {
      const line = `\n${formatEntry(entry, index)}`;
      if (text.length + line.length > MAX_MESSAGE_CHARS) {
        break;
      }
      text += line;
      shown++;
    }
    if (shown < entries.length) {
      text += `\n…and ${entries.length - shown} more`;
    }
    await replyHTML(ctx, text);
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

function formatEntry(entry: FishingLeaderboardEntry, index: number): string {
  const place = MEDALS[index] ?? `${index + 1}.`;
  return `${place} ${escapeHtml(entry.firstName)} — ${entry.weight.toFixed(1)} lbs ${entry.species} ${entry.emoji}`;
}

// "an 8.2 lbs", "an 11.0 lbs", "an 18.4 lbs" — every other weight reads with "a".
function article(weightText: string): string {
  const whole = weightText.split(".")[0]!;
  return whole.startsWith("8") || whole === "11" || whole === "18" ? "an" : "a";
}
