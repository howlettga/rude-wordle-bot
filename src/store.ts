import { Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "./context.js";
import type { StorageService } from "./storage-service.js";
import type { HeldFish } from "./durable-objects/fishing.js";
import type { StoreCard, StoreItem, StoreTapResult } from "./durable-objects/store.js";
import { GEAR_LINES, WORMS, type AnglerGear } from "./gear.js";
import { formatBeanPrice, formatBeans } from "./store-math.js";
import { escapeHtml, random, weightArticle } from "./util.js";

// The "store" feature (see features.ts): a shared General Store card, built like the pet card, so the
// chat only ever sees one message whose buttons update it in place. Everything personal (what you sold,
// what something costs you, your wallet) comes back as a pop-up only the tapper sees.
//   /store -> the card: today's fish price, the latest sale or upgrade, and buttons to
//             - sell a fish (a random one from your bucket, so it's one button: the pop-up says which)
//             - buy your next rod or boat tier, or a worm (see gear.ts). The first tap quotes the price
//               privately; a second tap on the same button within BUY_CONFIRM_SECONDS buys it.
//             - check your wallet: beans, how many fish you have, and your gear
// /fish replies also get a Sell button for that exact fish (see fishingSellButton), which only its catcher
// can use. Selling and gear need fishing on too; with it off, the card only has the wallet. Prices live in
// store-math.ts and gear.ts, and the money is beans, always written with 🫘 as the currency sign.
//
// Fish don't spoil yet, but a cooler is planned, so the shopkeeper drops the odd hint that they might
// (FRESHNESS_LINES), and the wallet mentions it when someone's been holding a fish for a while.
const SELL_CAUGHT = /^store:sell:fish:(\d+)$/;
const GEAR_BUTTON = /^store:gear:(rod|boat|worms)$/;
// Telegram rejects pop-ups longer than this.
const POPUP_MAX = 200;
const FRESHNESS_CHANCE = 1 / 3;
const FRESHNESS_LINES = [
  "The shopkeeper sniffs it. Still fresh.",
  "\"Bring 'em in while they're fresh,\" says the shopkeeper.",
  "Fresh enough. For now.",
  "The shopkeeper mutters that fish don't keep forever.",
  "Smells fine. Today.",
];
const OLD_FISH_DAYS = 7;

// The button under a /fish reply, for selling that catch on the spot.
export function fishingSellButton(catchId: number, quote: number): InlineKeyboard {
  return new InlineKeyboard().text(`💰 Sell for ${formatBeans(quote)}`, `store:sell:fish:${catchId}`);
}

export class StoreComposer extends Composer<MyContext> {
  constructor(private storage: StorageService) {
    super();
    this.command("store", (ctx) => this.sendCard(ctx));
    this.callbackQuery(SELL_CAUGHT, (ctx) => this.sellCaught(ctx));
    this.callbackQuery("store:sellrandom", (ctx) => this.sellFromCard(ctx));
    this.callbackQuery(GEAR_BUTTON, (ctx) => this.tapGear(ctx));
    this.callbackQuery("store:wallet", (ctx) => this.showWallet(ctx));
  }

  private async fishingOn(chatId: number): Promise<boolean> {
    return (await this.storage.getChatFeatures(chatId)).fishing.enabled;
  }

  private async sendCard(ctx: MyContext) {
    if (!ctx.chat) {
      return;
    }
    const fishing = await this.fishingOn(ctx.chat.id);
    const card = await this.storage.getStoreCard(ctx.chat.id);
    await ctx.reply(formatCard(card, fishing), {
      parse_mode: "HTML",
      reply_markup: cardKeyboard(fishing),
      ...(ctx.message?.message_thread_id !== undefined && { message_thread_id: ctx.message.message_thread_id }),
    });
  }

  // Refreshes the card the tap came from (after a sale or an upgrade changes its activity line).
  private async refreshCard(ctx: MyContext, chatId: number) {
    const card = await this.storage.getStoreCard(chatId);
    await ctx
      .editMessageText(formatCard(card, true), { parse_mode: "HTML", reply_markup: cardKeyboard(true) })
      .catch((err) => console.error(err)); // e.g. "message is not modified"
  }

  // The Sell button on a /fish reply. On a sale the reply itself changes ("Sold for ..."), and its button
  // goes away, so nothing new is posted.
  private async sellCaught(ctx: MyContext) {
    const match = ctx.callbackQuery?.data?.match(SELL_CAUGHT);
    if (!match || !ctx.chat || !ctx.from) {
      return;
    }
    const chatId = ctx.chat.id;
    if (!(await this.fishingOn(chatId))) {
      await ctx.answerCallbackQuery({ text: "Fishing is turned off in this chat." });
      return;
    }
    const taken = await this.storage.takeFishById(chatId, ctx.from.id, Number(match[1]), "store", "sold");
    if (!taken.ok) {
      if (taken.reason === "NOT_YOURS") {
        await ctx.answerCallbackQuery({ text: "That's not your fish.", show_alert: true });
        return;
      }
      await ctx.editMessageReplyMarkup().catch((err) => console.error(err));
      await ctx.answerCallbackQuery({ text: "That fish is already gone.", show_alert: true });
      return;
    }

    const sale = await this.sell(chatId, ctx.from, taken.fish);
    const original = ctx.callbackQuery?.message?.text;
    const sold = `💰 Sold for ${formatBeans(sale.amount)}.`;
    // Edit first, then the pop-up, same order as the pet card (see PetComposer.handleButton).
    await (original !== undefined ? ctx.editMessageText(`${original}\n${sold}`) : ctx.editMessageReplyMarkup()).catch((err) =>
      console.error(err)
    );
    await ctx.answerCallbackQuery({ text: withFreshness(`${sold} You have ${formatBeans(sale.balance)}.`), show_alert: true });
  }

  private async sellFromCard(ctx: MyContext) {
    if (!ctx.chat || !ctx.from) {
      return;
    }
    const chatId = ctx.chat.id;
    if (!(await this.fishingOn(chatId))) {
      await ctx.answerCallbackQuery({ text: "Fishing is turned off in this chat." });
      return;
    }
    const fish = await this.storage.takeFish(chatId, ctx.from.id, "random", "store", "sold");
    if (!fish) {
      await ctx.answerCallbackQuery({ text: "🪣 Your bucket's empty. Go /fish first.", show_alert: true });
      return;
    }

    const sale = await this.sell(chatId, ctx.from, fish);
    await this.refreshCard(ctx, chatId);
    const weight = fish.weight.toFixed(1);
    await ctx.answerCallbackQuery({
      text: withFreshness(
        `${fish.emoji} The shopkeeper reached into your bucket and pulled out ${weightArticle(weight)} ${weight} lb ${fish.species}. ` +
          `Sold for ${formatBeans(sale.amount)}. You have ${formatBeans(sale.balance)}.`
      ),
      show_alert: true,
    });
  }

  // Pays for a fish already taken from the bucket, and puts the fish back if the payout fails, so a
  // broken sale never just eats someone's fish.
  private async sell(chatId: number, from: { id: number; first_name: string }, fish: HeldFish) {
    try {
      return await this.storage.sellFish(chatId, { userId: from.id, firstName: from.first_name, fish });
    } catch (err) {
      await this.storage.returnFish(chatId, fish.id).catch((refundErr) => console.error("returnFish failed", fish, refundErr));
      throw err;
    }
  }

  // Rod / Boat / Worms. Everything about the purchase is in the tapper's pop-up; only a finished rod or
  // boat upgrade shows on the card.
  private async tapGear(ctx: MyContext) {
    const match = ctx.callbackQuery?.data?.match(GEAR_BUTTON);
    if (!match || !ctx.chat || !ctx.from) {
      return;
    }
    const chatId = ctx.chat.id;
    if (!(await this.fishingOn(chatId))) {
      await ctx.answerCallbackQuery({ text: "Fishing is turned off in this chat." });
      return;
    }
    const result = await this.storage.tapStoreGear(chatId, {
      userId: ctx.from.id,
      firstName: ctx.from.first_name,
      item: match[1] as StoreItem,
    });
    if (result.kind === "BOUGHT" && result.item !== "worms") {
      await this.refreshCard(ctx, chatId);
    }
    await ctx.answerCallbackQuery({ text: gearPopup(result), show_alert: true });
  }

  private async showWallet(ctx: MyContext) {
    if (!ctx.chat || !ctx.from) {
      return;
    }
    const chatId = ctx.chat.id;
    const fishing = await this.fishingOn(chatId);
    const [bucket, wallet] = await Promise.all([
      fishing ? this.storage.getFishBucket(chatId, ctx.from.id) : Promise.resolve([]),
      this.storage.getWallet(chatId, ctx.from.id),
    ]);
    const lines = [`👛 You have ${formatBeans(wallet.balance)}.`];
    if (fishing) {
      lines.push(bucket.length === 0 ? `🪣 Your bucket's empty.` : `🪣 ${bucket.length} fish in your bucket.`, gearLine(wallet.gear));
      if (bucket.some((fish) => fish.daysHeld >= OLD_FISH_DAYS)) {
        lines.push(`Some of those fish have been in there a while.`);
      }
    }
    await ctx.answerCallbackQuery({ text: fitPopup(lines), show_alert: true });
  }
}

// Plain text: Telegram pop-ups don't render HTML.
function gearPopup(result: StoreTapResult): string {
  const emoji = result.item === "worms" ? WORMS.emoji : GEAR_LINES[result.item].emoji;
  const pitch = result.item === "worms" ? "half the junk on your next cast" : GEAR_LINES[result.item].pitch;
  switch (result.kind) {
    case "CONFIRM":
      return `${emoji} ${result.name}: ${pitch}. ${formatBeans(result.price)} (you have ${formatBeans(result.balance)}). Tap again to buy.`;
    case "CANT_AFFORD":
      return `${emoji} ${articled(result.name)} costs ${formatBeans(result.price)}. You have ${formatBeans(result.balance)}. Sell some fish.`;
    case "MAXED":
      return `${emoji} You already have the ${result.name}. It doesn't get better than this.`;
    case "FULL":
      return `${WORMS.emoji} Your worm can is full (${result.worms}). Go use some.`;
    case "BOUGHT":
      return result.item === "worms"
        ? `${emoji} Bought a worm. It goes on your next cast. Worms: ${result.gear.worms}. ${formatBeans(result.balance)} left.`
        : `${emoji} You bought the ${result.name}! ${formatBeans(result.balance)} left.`;
  }
}

function gearLine(gear: AnglerGear): string {
  const rod = GEAR_LINES.rod.tiers[gear.rod]?.name ?? GEAR_LINES.rod.tiers[0]!.name;
  const boat = GEAR_LINES.boat.tiers[gear.boat]?.name ?? GEAR_LINES.boat.tiers[0]!.name;
  const worms = gear.worms > 0 ? ` · ${WORMS.emoji} ${gear.worms} worm${gear.worms === 1 ? "" : "s"}` : "";
  return `${GEAR_LINES.rod.emoji} ${rod} · ${GEAR_LINES.boat.emoji} ${boat}${worms}`;
}

// Now and then, the shopkeeper hints that fish might not keep (see FRESHNESS_LINES), if it fits.
function withFreshness(text: string): string {
  if (Math.random() >= FRESHNESS_CHANCE) {
    return text;
  }
  const withHint = `${text}\n${random(FRESHNESS_LINES)}`;
  return withHint.length <= POPUP_MAX ? withHint : text;
}

// Joins pop-up lines, dropping trailing ones that would push it over Telegram's limit.
function fitPopup(lines: string[]): string {
  let text = lines[0] ?? "";
  for (const line of lines.slice(1)) {
    if (text.length + 1 + line.length > POPUP_MAX) {
      break;
    }
    text += `\n${line}`;
  }
  return text;
}

// "a Carbon rod", "an Inner tube".
function indefinite(name: string): string {
  return /^[aeiou]/i.test(name) ? "an" : "a";
}

function articled(name: string): string {
  const article = indefinite(name);
  return `${article.charAt(0).toUpperCase()}${article.slice(1)} ${name}`;
}

function formatCard(card: StoreCard, fishing: boolean): string {
  const lines = [`🏪 <b>General Store</b>`];
  if (fishing) {
    const { perLb, yesterdayPerLb } = card.fish;
    lines.push(`🐟 Fish: ${formatBeanPrice(perLb)}/lb${priceChange(perLb, yesterdayPerLb)}`);
  } else {
    lines.push(`Nothing for sale right now.`);
  }
  const activity = card.lastActivity;
  if (activity?.kind === "sale") {
    const { firstName, label, amount } = activity;
    lines.push(`<i>💰 ${escapeHtml(firstName)} sold ${weightArticle(label)} ${escapeHtml(label)} for ${formatBeans(amount)}.</i>`);
  } else if (activity?.kind === "upgrade") {
    const { firstName, label, line } = activity;
    lines.push(`<i>${GEAR_LINES[line].emoji} ${escapeHtml(firstName)} upgraded to ${indefinite(label)} ${escapeHtml(label)}.</i>`);
  }
  return lines.join("\n");
}

// " (▲ 12% since yesterday)", or nothing when it's flat.
function priceChange(today: number, yesterday: number): string {
  const pct = Math.round((today / yesterday - 1) * 100);
  if (pct === 0 || !Number.isFinite(pct)) {
    return "";
  }
  return ` (${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}% since yesterday)`;
}

function cardKeyboard(fishing: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (fishing) {
    keyboard
      .text("🐟 Sell a fish", "store:sellrandom")
      .row()
      .text(`${GEAR_LINES.rod.emoji} Rod ⬆️`, "store:gear:rod")
      .text(`${GEAR_LINES.boat.emoji} Boat ⬆️`, "store:gear:boat")
      .text(`${WORMS.emoji} Worms`, "store:gear:worms")
      .row();
  }
  return keyboard.text("👛 Wallet", "store:wallet");
}
