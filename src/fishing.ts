import { Composer } from "grammy";
import { type MyContext, replyToMessage, replyHTML } from "./context.js";
import type { StorageService } from "./storage-service.js";
import type { BottleListing, FishingLeaderboardEntry } from "./durable-objects/fishing.js";
import type { FeatureFlags } from "./features.js";
import { FISHING_CONFIG, parseLocation, rotatingLine, sunriseUtc, type GeoLocation } from "./fishing-math.js";
import { easternParts, formatEasternClock, formatEasternDateTime } from "./eastern-time.js";
import { HIGH_TIDE_LINES, HINT_LINES, JUNK_LINES, LAKE_LINES } from "./fishing-lines.js";
import { petDesireLine } from "./pet.js";
import { fishingSellButton } from "./store.js";
import { castGear, type AnglerGear } from "./gear.js";
import { BOTTLE_DISTANCES } from "./bottles.js";
import { escapeHtml, weightArticle } from "./util.js";

// The "fishing" feature (see features.ts):
//   /fish                         -> one cast per day; reports the catch, plus personal best / rank / chat
//                                    record lines when they apply — or, now and then, worthless junk. Then
//                                    one flavor line: the pet begging when it's hungry or lonely, else a
//                                    high tide, else a hint about a poor catch, else how busy the lake is
//                                    today. The roll math (fishing-math.ts) is
//                                    deliberately never shown, and buckets are private (the store's
//                                    Wallet pop-up shows only your own).
//                                    A fish (not junk) gets a Sell button while the store is on (see
//                                    store.ts), the reply's only button. Store gear (gear.ts) applies to
//                                    the cast while the store is on, and a cast uses up one worm if any.
//                                    Sometimes it reels in someone's message in a bottle instead (see
//                                    bottles.ts): the reply just reads the note out, with no button and no
//                                    flavor line, and nothing goes in the bucket or on the leaderboard.
//   /fishing                      -> leaderboard: everyone's heaviest catch, ranked by weight
//   /fishingwindow <days>|forever -> owner-only: how far back the leaderboard looks (default forever)
//   /resetfishing                 -> owner-only: leaderboard starts over; nothing is deleted
//   /setlocation [lat, lon|default] -> owner-only: where this chat fishes. The fishing day turns over at sunrise
//                                    there (see fishingDay). With no argument, shows the current one and
//                                    today's sunrise
//   /bottles                      -> owner-only: this chat's bottles in the water and the last few found
//   /bottlepull <id>              -> owner-only: takes a bottle out of the water before anyone finds it
//   /bottlewho <id>               -> owner-only: who wrote that bottle
// Owner-only commands ignore anyone else silently, same as the other owner commands. The bottle ones answer in
// the owner's private chat, never the group, so notes and their writers don't leak, and then try to delete the
// owner's command from the group.
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
    this.command("setlocation", (ctx) => this.handleSetLocation(ctx));
    this.command("bottles", (ctx) => this.handleBottles(ctx));
    this.command("bottlepull", (ctx) => this.handleBottlePull(ctx));
    this.command("bottlewho", (ctx) => this.handleBottleWho(ctx));
  }

  private isOwner(ctx: MyContext): boolean {
    return this.ownerChatId !== undefined && ctx.from?.id === this.ownerChatId;
  }

  private async handleFish(ctx: MyContext) {
    if (!ctx.from || !ctx.chat) {
      return;
    }

    const chatId = ctx.chat.id;
    const gear = await this.gear(ctx);
    const useWorm = gear !== null && gear.worms > 0;
    const result = await this.storage.castFishing(chatId, {
      userId: ctx.from.id,
      ...(ctx.from.username !== undefined && { username: ctx.from.username }),
      firstName: ctx.from.first_name,
      ...(gear && { gear: castGear(gear, useWorm) }),
    });
    if (!result.ok) {
      await replyToMessage(ctx, "You already fished today. Come back tomorrow.");
      return;
    }
    if (useWorm) {
      // After the cast, so a cast that didn't happen never costs a worm. A failure here just means a free one.
      await this.storage.useWorm(chatId, ctx.from.id).catch((err) => console.error("useWorm failed", err));
    }
    if (result.kind === "bottle") {
      // Plain text, since the note is whatever someone typed, and no link preview, so a URL in it stays just text.
      await ctx.reply(`🍾 You reeled in a bottle! There's a note inside:\n\n"${result.text}"`, {
        ...(ctx.message?.message_id !== undefined && { reply_to_message_id: ctx.message.message_id }),
        ...(ctx.message?.message_thread_id !== undefined && { message_thread_id: ctx.message.message_thread_id }),
        link_preview_options: { is_disabled: true },
      });
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
      lines.push(`You caught ${weightArticle(weightText)} ${weightText} lbs ${species}! ${emoji}`);
      if (result.chatRecord) {
        lines.push(`🏆 New chat record!`);
      } else if (result.previousBest === null) {
        lines.push(`You're #${result.rank} on the leaderboard.`);
      } else if (weight > result.previousBest) {
        lines.push(`New personal best! You're #${result.rank} on the leaderboard.`);
      }
    }
    // Exactly one flavor line, so the reply never runs on. Each kind supersedes the ones before it: the
    // lake line is the fallback, a poor-catch hint beats it, a high tide beats that, and a hungry or
    // lonely pet beats everything.
    let flavor = pick(LAKE_LINES[result.lake], `lake:${result.lake}`);
    if (result.hint) {
      flavor = pick(HINT_LINES[result.hint], `hint:${result.hint}`);
    }
    if (result.highTide) {
      flavor = pick(HIGH_TIDE_LINES, "tide");
    }
    lines.push((await this.petBegging(ctx, result.kind)) ?? flavor);
    const sellButton = result.kind === "fish" ? await this.sellButton(ctx, result.catchId, result.catch) : null;
    await ctx.reply(lines.join("\n"), {
      ...(ctx.message?.message_id !== undefined && { reply_to_message_id: ctx.message.message_id }),
      ...(ctx.message?.message_thread_id !== undefined && { message_thread_id: ctx.message.message_thread_id }),
      ...(sellButton && { reply_markup: sellButton }),
    });
  }

  // This angler's store gear (rod, boat, worms; see gear.ts), or null while the store is off: gear only
  // counts while it's on. Like the pet's begging line, a store problem never costs anyone their cast.
  private async gear(ctx: MyContext): Promise<AnglerGear | null> {
    try {
      if (!ctx.chat || !ctx.from || !(await this.features(ctx)).store.enabled) {
        return null;
      }
      return await this.storage.getGear(ctx.chat.id, ctx.from.id);
    } catch (err) {
      console.error(err);
      return null;
    }
  }

  // The store's Sell button for this catch, priced at today's rate. Like the pet's begging line, a store
  // problem never costs anyone their catch reply: it just goes out without the button.
  private async sellButton(ctx: MyContext, catchId: number, fish: { species: string; weight: number }) {
    try {
      if (!ctx.chat || !(await this.features(ctx)).store.enabled) {
        return null;
      }
      return fishingSellButton(catchId, await this.storage.quoteFish(ctx.chat.id, fish));
    } catch (err) {
      console.error(err);
      return null;
    }
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

  // The location is shown rounded to 2 decimal places (about a kilometre), since the reply goes to the whole chat.
  private async handleSetLocation(ctx: MyContext) {
    if (!this.isOwner(ctx) || !ctx.chat) {
      return;
    }
    const chatId = ctx.chat.id;
    const arg = String(ctx.match ?? "").trim();
    const usage = "Usage: /setlocation <latitude>, <longitude> (e.g. 35.88, -78.79), or /setlocation default";

    if (arg === "") {
      const { location, isDefault } = await this.storage.getFishingLocation(chatId);
      await replyToMessage(ctx, `${describeLocation(location, isDefault)}
${usage}`);
      return;
    }
    if (arg.toLowerCase() === "default") {
      await this.storage.setFishingLocation(chatId, null);
      const { location } = await this.storage.getFishingLocation(chatId);
      await replyToMessage(ctx, `Back to the default. ${describeLocation(location, true)}`);
      return;
    }
    const location = parseLocation(arg);
    if (!location) {
      await replyToMessage(ctx, `That's not a location.
${usage}`);
      return;
    }
    await this.storage.setFishingLocation(chatId, location);
    await replyToMessage(ctx, `Location set. ${describeLocation(location, false)}`);
  }

  private async handleReset(ctx: MyContext) {
    if (!this.isOwner(ctx) || !ctx.chat) {
      return;
    }

    await this.storage.resetFishing(ctx.chat.id);
    await replyToMessage(ctx, "Fishing leaderboard reset. Earlier catches no longer count.");
  }

  private async handleBottles(ctx: MyContext) {
    if (!this.isOwner(ctx) || !ctx.chat) {
      return;
    }
    const where = ctx.chat.type === "private" ? "this chat" : (ctx.chat.title ?? "this chat");
    await this.answerOwner(ctx, formatBottles(where, await this.storage.listBottles(ctx.chat.id)));
  }

  private async handleBottlePull(ctx: MyContext) {
    if (!this.isOwner(ctx) || !ctx.chat) {
      return;
    }
    const id = bottleIdArg(ctx);
    if (id === null) {
      await this.answerOwner(ctx, "Usage: /bottlepull <id> (see /bottles for ids)");
      return;
    }
    const removed = await this.storage.removeBottle(ctx.chat.id, id);
    await this.answerOwner(
      ctx,
      removed ? `🍾 Pulled bottle #${id} out of the water. Nobody will find it.` : `Bottle #${id} isn't in the water here (found, pulled, or never thrown).`
    );
  }

  private async handleBottleWho(ctx: MyContext) {
    if (!this.isOwner(ctx) || !ctx.chat) {
      return;
    }
    const id = bottleIdArg(ctx);
    if (id === null) {
      await this.answerOwner(ctx, "Usage: /bottlewho <id> (see /bottles for ids)");
      return;
    }
    const author = await this.storage.getBottleAuthor(ctx.chat.id, id);
    await this.answerOwner(
      ctx,
      author ? `🍾 Bottle #${id} was written by ${author.authorName} (user id ${author.authorId}).` : `There's no bottle #${id} in this chat.`
    );
  }

  // Sends a bottle moderation answer to the owner's private chat (plain text, since notes are whatever people
  // typed), then tries to delete the owner's command from the group so it doesn't hang around asking questions.
  // If the DM fails (most likely the owner has never started a private chat with the bot), nothing happens in the
  // group at all. The bot may not be allowed to delete messages there, which is fine.
  private async answerOwner(ctx: MyContext, text: string) {
    if (this.ownerChatId === undefined || !ctx.chat) {
      return;
    }
    try {
      await ctx.api.sendMessage(this.ownerChatId, text, { link_preview_options: { is_disabled: true } });
    } catch (err) {
      console.error("bottle moderation DM to the owner failed", ctx.chat.id, err);
      return;
    }
    if (ctx.chat.id !== this.ownerChatId && ctx.message) {
      await ctx.deleteMessage().catch(() => {});
    }
  }
}

// The id after /bottlepull or /bottlewho, or null if there isn't a sensible one.
function bottleIdArg(ctx: MyContext): number | null {
  const arg = String(ctx.match ?? "").trim().replace(/^#/, "");
  const id = /^\d+$/.test(arg) ? Number(arg) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function easternTime(epochSec: number): string {
  return `${formatEasternDateTime(epochSec)} ET`;
}

// The owner's /bottles, in plain text. Kept under Telegram's limit like the leaderboard: whatever doesn't fit is
// counted at the end.
function formatBottles(where: string, listing: BottleListing): string {
  const blocks: string[] = [];
  blocks.push(listing.drifting.length === 0 ? "In the water: none." : `In the water (${listing.drifting.length}):`);
  for (const bottle of listing.drifting) {
    const { emoji, label } = BOTTLE_DISTANCES[bottle.distance] ?? { emoji: "🍾", label: bottle.distance };
    const washUp = bottle.washedUp
      ? `washed up ${easternTime(bottle.washesUpAt)}, waiting to be found`
      : `washes up ${easternTime(bottle.washesUpAt)}`;
    blocks.push(`#${bottle.id} ${emoji} ${label} · thrown ${easternTime(bottle.thrownAt)} · ${washUp}\n"${bottle.text}"`);
  }
  blocks.push(listing.found.length === 0 ? "Recently found: none yet." : "Recently found:");
  for (const bottle of listing.found) {
    blocks.push(`#${bottle.id} found by ${bottle.caughtByName}, ${easternTime(bottle.caughtAt)}\n"${bottle.text}"`);
  }

  let text = `🍾 Bottles in ${where}`;
  let shown = 0;
  for (const block of blocks) {
    if (text.length + 2 + block.length > MAX_MESSAGE_CHARS) {
      break;
    }
    text += `\n\n${block}`;
    shown++;
  }
  if (shown < blocks.length) {
    text += `\n\n…and ${blocks.length - shown} more that didn't fit`;
  }
  return text;
}

function formatEntry(entry: FishingLeaderboardEntry, index: number): string {
  const place = MEDALS[index] ?? `${index + 1}.`;
  return `${place} ${escapeHtml(entry.firstName)} — ${entry.weight.toFixed(1)} lbs ${entry.species} ${entry.emoji}`;
}

// "Fishing at 35.88, -78.79 (the default). Today's sunrise, when the fishing day turns over: 7:03 AM ET."
function describeLocation(location: GeoLocation, isDefault: boolean): string {
  const where = `Fishing at ${location.lat.toFixed(2)}, ${location.lon.toFixed(2)}${isDefault ? " (the default)" : ""}.`;
  const today = easternParts(new Date());
  const sunrise = sunriseUtc(today.year, today.month, today.day, location);
  const when =
    sunrise === null
      ? `No sunrise there today, so the fishing day turns over at ${FISHING_CONFIG.DAY_STARTS_HOUR_ET} AM ET.`
      : `Today's sunrise, when the fishing day turns over: ${formatEasternClock(sunrise)} ET.`;
  return `${where} ${when}`;
}
