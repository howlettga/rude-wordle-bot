import { Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "./context.js";
import type { StorageService } from "./storage-service.js";
import type { FishSize, HeldFish } from "./durable-objects/fishing.js";
import type { StoreCard } from "./durable-objects/store.js";
import { formatBeans } from "./store-math.js";
import { escapeHtml } from "./util.js";

// The "store" feature (see features.ts): a shared General Store card, built like the pet card, so the
// chat only ever sees one message whose buttons update it in place. Everything personal (what you sold,
// your wallet) comes back as a pop-up only the tapper sees.
//   /store -> the card: today's fish price, the latest sale, and buttons to sell your small / medium /
//             large fish (same picks as feeding the pet), check your wallet, or buy (coming soon)
// /fish replies also get a Sell button for that exact fish (see fishingSellButton), which only its catcher
// can use. Selling needs fishing on too; with it off, the card has nothing to sell. Prices live in
// store-math.ts, and the money is beans.
const SELL_CAUGHT = /^store:sell:fish:(\d+)$/;
const SELL_SIZE = /^store:sellsize:([sml])$/;
const FISH_SIZES: Record<string, FishSize> = { s: "small", m: "medium", l: "large" };

// The button under a /fish reply, for selling that catch on the spot.
export function fishingSellButton(catchId: number, quote: number): InlineKeyboard {
  return new InlineKeyboard().text(`🫘 Sell for ${formatBeans(quote)}`, `store:sell:fish:${catchId}`);
}

export class StoreComposer extends Composer<MyContext> {
  constructor(private storage: StorageService) {
    super();
    this.command("store", (ctx) => this.sendCard(ctx));
    this.callbackQuery(SELL_CAUGHT, (ctx) => this.sellCaught(ctx));
    this.callbackQuery(SELL_SIZE, (ctx) => this.sellFromCard(ctx));
    this.callbackQuery("store:wallet", (ctx) => this.showWallet(ctx));
    this.callbackQuery("store:buy", (ctx) =>
      ctx.answerCallbackQuery({ text: "🛒 Nothing for sale yet. Gear's coming soon, so hang on to your beans.", show_alert: true })
    );
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
    const sold = `🫘 Sold for ${formatBeans(sale.amount)}.`;
    // Edit first, then the pop-up, same order as the pet card (see PetComposer.handleButton).
    await (original !== undefined ? ctx.editMessageText(`${original}\n${sold}`) : ctx.editMessageReplyMarkup()).catch((err) =>
      console.error(err)
    );
    await ctx.answerCallbackQuery({ text: `${sold} You have ${formatBeans(sale.balance)}.`, show_alert: true });
  }

  private async sellFromCard(ctx: MyContext) {
    const match = ctx.callbackQuery?.data?.match(SELL_SIZE);
    if (!match || !ctx.chat || !ctx.from) {
      return;
    }
    const chatId = ctx.chat.id;
    if (!(await this.fishingOn(chatId))) {
      await ctx.answerCallbackQuery({ text: "Fishing is turned off in this chat." });
      return;
    }
    const fish = await this.storage.takeFish(chatId, ctx.from.id, FISH_SIZES[match[1]!]!, "store", "sold");
    if (!fish) {
      await ctx.answerCallbackQuery({ text: "🪣 Your bucket's empty. Go /fish first.", show_alert: true });
      return;
    }

    const sale = await this.sell(chatId, ctx.from, fish);
    const card = await this.storage.getStoreCard(chatId);
    await ctx
      .editMessageText(formatCard(card, true), { parse_mode: "HTML", reply_markup: cardKeyboard(true) })
      .catch((err) => console.error(err)); // e.g. "message is not modified"
    await ctx.answerCallbackQuery({
      text: `🫘 Sold your ${fish.weight.toFixed(1)} lb ${fish.species} for ${formatBeans(sale.amount)}. You have ${formatBeans(sale.balance)}.`,
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

  private async showWallet(ctx: MyContext) {
    if (!ctx.chat || !ctx.from) {
      return;
    }
    const chatId = ctx.chat.id;
    const fishing = await this.fishingOn(chatId);
    const bucket = fishing ? await this.storage.getFishBucket(chatId, ctx.from.id) : [];
    const { balance, bucketValue } = await this.storage.getWallet(chatId, ctx.from.id, bucket);
    const lines = [`👛 You have ${formatBeans(balance)}.`];
    if (fishing) {
      lines.push(
        bucket.length === 0
          ? `🪣 Your bucket's empty.`
          : `🪣 ${bucket.length} fish in your bucket, worth about ${formatBeans(bucketValue)} today.`
      );
    }
    await ctx.answerCallbackQuery({ text: lines.join("\n"), show_alert: true });
  }
}

function formatCard(card: StoreCard, fishing: boolean): string {
  const lines = [`🏪 <b>General Store</b>`];
  if (fishing) {
    const { perLb, yesterdayPerLb } = card.fish;
    lines.push(`🐟 Fish: ${perLb.toFixed(2)} beans/lb${priceChange(perLb, yesterdayPerLb)}`);
  } else {
    lines.push(`Nothing to sell right now.`);
  }
  if (card.lastSale) {
    const { firstName, label, amount } = card.lastSale;
    lines.push(`<i>🫘 ${escapeHtml(firstName)} sold a ${escapeHtml(label)} for ${formatBeans(amount)}.</i>`);
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
      .text("🐟 Sell Small", "store:sellsize:s")
      .text("🐟 Sell Medium", "store:sellsize:m")
      .text("🐟 Sell Large", "store:sellsize:l")
      .row();
  }
  return keyboard.text("👛 Wallet", "store:wallet").text("🛒 Buy", "store:buy");
}
