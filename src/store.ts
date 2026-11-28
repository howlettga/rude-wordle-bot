import { Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "./context.js";
import type { StorageService } from "./storage-service.js";
import type { HeldFish } from "./durable-objects/fishing.js";
import type { StoreCard, StoreItem, StoreTapResult } from "./durable-objects/store.js";
import { GEAR_LINES, WORMS, type AnglerGear } from "./gear.js";
import { STORE_CONFIG, formatBeanPrice, formatBeans } from "./store-math.js";
import type { LinkPreviewOptions } from "grammy/types";
import { escapeHtml, random, weightArticle } from "./util.js";
import { storeAppUrl } from "./webapp/store-link.js";

// The "store" feature (see features.ts): a shared General Store card, built like the pet card, so the
// chat only ever sees one message whose buttons update it in place. Anything personal comes back as a pop-up
// only the tapper sees, or happens in the store page.
//   /store -> the card: today's fish price, the latest sale or upgrade, and two buttons:
//             - sell a fish (a random one from your bucket, so it's one button: the pop-up says which)
//             - open the store page (see webapp/api.ts and public/app/), where you see your whole bucket, sell any
//               fish, buy gear (see gear.ts), and check your beans. It's a URL button to the Mini App, whose link
//               carries this chat's id signed with the bot's token (see webapp/store-link.ts), re-signed on every
//               card edit, so a link is good for a day from the card's last change.
//             Cards posted before the store page also have Rod / Boat / Worms (the first tap on Rod or Boat quotes
//             the price, a second within BUY_CONFIRM_SECONDS buys) and Wallet buttons. Those still work, and the
//             card switches to the two-button layout the next time it's edited.
// /fish replies also get a Sell button for that exact fish (see fishingSellButton), which only its catcher
// can use. Selling and gear need fishing on too. Prices live in store-math.ts and gear.ts, and the money is
// beans, always written with 🫘 as the currency sign.
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

// What it takes to put the Open store button on a card: the bot's username (for the t.me link) and a way to sign
// a fresh link for a chat. Built in bot.ts for the composer, and in webapp/api.ts for card edits made from the page.
// bannerUrl is the card's banner image (see storeBannerUrl), or null for a plain text card.
export interface StoreLinks {
  botUsername: string | undefined;
  signLink: (chatId: number) => Promise<string>;
  bannerUrl: string | null;
}

// The card's banner: the store icon (public/app/general_store.png), shown as a large link preview above the card's
// text. A large preview makes Telegram draw the message at full width, so the card and its buttons fill the chat
// instead of shrinking to the card's short lines. publicUrl is this Worker's own address (the PUBLIC_URL var in
// wrangler.jsonc); without it, no banner. Bump BANNER_VERSION after changing the image: Telegram caches previews
// by URL, so a new query string is what makes it fetch the new one.
const BANNER_PATH = "/app/general_store.png";
const BANNER_VERSION = 1;
export function storeBannerUrl(publicUrl: string | undefined): string | null {
  return publicUrl ? `${publicUrl.replace(/\/+$/, "")}${BANNER_PATH}?v=${BANNER_VERSION}` : null;
}

// The Open store button's URL for this chat, or null (no button) if the bot has no username or signing fails, so
// a broken link never stops the card itself from going out.
export async function storeUrlFor(chatId: number, links: StoreLinks): Promise<string | null> {
  if (!links.botUsername) {
    return null;
  }
  try {
    return storeAppUrl(links.botUsername, await links.signLink(chatId));
  } catch (err) {
    console.error("store link signing failed", chatId, err);
    return null;
  }
}

export class StoreComposer extends Composer<MyContext> {
  constructor(
    private storage: StorageService,
    private links: StoreLinks
  ) {
    super();
    this.command("store", (ctx) => this.sendCard(ctx));
    this.callbackQuery(SELL_CAUGHT, (ctx) => this.sellCaught(ctx));
    this.callbackQuery("store:sellrandom", (ctx) => this.sellFromCard(ctx));
    // Only on cards posted before the store page (see the note at the top); new cards don't have these buttons.
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
    const chatId = ctx.chat.id;
    const [fishing, card, storeUrl] = await Promise.all([
      this.fishingOn(chatId),
      this.storage.getStoreCard(chatId),
      storeUrlFor(chatId, this.links),
    ]);
    const { text, reply_markup, link_preview_options } = renderStoreCard(card, fishing, storeUrl, this.links.bannerUrl);
    const sent = await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup,
      link_preview_options,
      ...(ctx.message?.message_thread_id !== undefined && { message_thread_id: ctx.message.message_thread_id }),
    });
    // Remembered so a sale or upgrade made in the store page can update this card (see webapp/api.ts). The card is
    // already out, so a failure here only costs that.
    await this.storage
      .recordStoreCard(chatId, sent.message_id, sent.message_thread_id ?? null)
      .catch((err) => console.error("recordStoreCard failed", chatId, err));
  }

  // Refreshes the card the tap came from (after a sale or an upgrade changes its activity line), with a freshly
  // signed Open store link.
  private async refreshCard(ctx: MyContext, chatId: number) {
    const [card, storeUrl] = await Promise.all([this.storage.getStoreCard(chatId), storeUrlFor(chatId, this.links)]);
    const { text, reply_markup, link_preview_options } = renderStoreCard(card, true, storeUrl, this.links.bannerUrl);
    await ctx
      .editMessageText(text, { parse_mode: "HTML", reply_markup, link_preview_options })
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

    // Taking the gamble on a random fish quietly pays RANDOM_SELL_BONUS extra. It's never mentioned: the pop-up just
    // shows the (higher) total.
    const sale = await this.sell(chatId, ctx.from, fish, STORE_CONFIG.RANDOM_SELL_BONUS);
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
  private async sell(chatId: number, from: { id: number; first_name: string }, fish: HeldFish, bonus = 0) {
    try {
      return await this.storage.sellFish(chatId, { userId: from.id, firstName: from.first_name, fish, bonus });
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
      lines.push(
        bucket.length === 0 ? `🪣 Your bucket's empty.` : `🪣 ${bucket.length} fish in your bucket.`,
        wormsLine(wallet.gear.worms),
        gearLine(wallet.gear)
      );
      if (bucket.some((fish) => fish.daysHeld >= OLD_FISH_DAYS)) {
        lines.push(`\nSome of those fish have been in there a while.`); // after a blank line
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
  return `${GEAR_LINES.rod.emoji} ${rod} · ${GEAR_LINES.boat.emoji} ${boat}`;
}

function wormsLine(worms: number): string {
  return worms === 0 ? `${WORMS.emoji} No worms.` : `${WORMS.emoji} ${worms} worm${worms === 1 ? "" : "s"}.`;
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

// The /store card's text (HTML), keyboard, and link preview. storeUrl null leaves out the Open store button; bannerUrl
// null leaves out the banner. Every send and edit of the card passes all three, since an edit without
// link_preview_options would drop the banner.
export function renderStoreCard(
  card: StoreCard,
  fishing: boolean,
  storeUrl: string | null,
  bannerUrl: string | null
): { text: string; reply_markup: InlineKeyboard; link_preview_options: LinkPreviewOptions } {
  const link_preview_options: LinkPreviewOptions =
    bannerUrl === null ? { is_disabled: true } : { url: bannerUrl, prefer_large_media: true, show_above_text: true };
  return { text: formatCard(card, fishing), reply_markup: cardKeyboard(fishing, storeUrl), link_preview_options };
}

// Title, today's price, and the latest activity, each separated by a blank line:
//   🏪 General Store
//
//   🐟 Fish: 🫘0.38/lb · ▲ 9%
//
//   💰 Galen sold an 8.1 lb koi for 🫘9.
function formatCard(card: StoreCard, fishing: boolean): string {
  const sections = [`🏪 <b>General Store</b>`];
  if (fishing) {
    const { perLb, yesterdayPerLb } = card.fish;
    sections.push(`🐟 Fish: ${formatBeanPrice(perLb)}/lb${priceChange(perLb, yesterdayPerLb)}`);
  } else {
    sections.push(`Nothing for sale right now.`);
  }
  const activity = card.lastActivity;
  if (activity?.kind === "sale") {
    const { firstName, label, amount } = activity;
    sections.push(`<i>💰 ${escapeHtml(firstName)} sold ${weightArticle(label)} ${escapeHtml(label)} for ${formatBeans(amount)}.</i>`);
  } else if (activity?.kind === "upgrade") {
    const { firstName, label, line } = activity;
    sections.push(`<i>${GEAR_LINES[line].emoji} ${escapeHtml(firstName)} upgraded to ${indefinite(label)} ${escapeHtml(label)}.</i>`);
  } else if (activity?.kind === "bottle") {
    // Anonymous on purpose: whoever threw it is never named anywhere (see bottles.ts).
    sections.push(`<i>🍾 Someone threw a bottle out to sea.</i>`);
  } else if (activity?.kind === "fund") {
    const { firstName, amount } = activity;
    sections.push(`<i>🐾 ${escapeHtml(firstName)} chipped in ${formatBeans(amount)} to the pet fund.</i>`);
  }
  return sections.join("\n\n");
}

// " · ▲ 12%" against yesterday's price, or nothing when it's flat.
function priceChange(today: number, yesterday: number): string {
  const pct = Math.round((today / yesterday - 1) * 100);
  if (pct === 0 || !Number.isFinite(pct)) {
    return "";
  }
  return ` · ${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}%`;
}

// Sell a fish (needs fishing on) and Open store (needs a link), each a full-width row. Buying and the wallet live in
// the store page.
function cardKeyboard(fishing: boolean, storeUrl: string | null): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (fishing) {
    keyboard.text("🐟 Sell a fish", "store:sellrandom").row();
  }
  if (storeUrl !== null) {
    keyboard.url("🛒 Open store", storeUrl);
  }
  return keyboard;
}
