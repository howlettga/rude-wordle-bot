import { DurableObject } from "cloudflare:workers";
import type { Env } from "../main.js";
import { easternParts } from "../eastern-time.js";
import { defaultLocation, fishingDay, seededNormal, speciesTier, type GeoLocation } from "../fishing-math.js";
import { STORE_CONFIG, fishPriceIndex, fishPricePerLb, fishSalePrice, saleBonus } from "../store-math.js";
import { GEAR_LINES, STARTER_GEAR, TIDE_CHART_ITEM, WORMS, type AnglerGear, type GearLine } from "../gear.js";
import type { HeldFish } from "./fishing.js";

export interface StoreFishPrice {
  perLb: number;
  yesterdayPerLb: number;
}

// The card's latest-activity line: a sale, someone upgrading their gear (worms aren't news), a message in a
// bottle going out to sea, which stays anonymous, so it carries no name, or someone chipping in to the pet fund.
export type StoreActivity =
  | { kind: "sale"; firstName: string; label: string; amount: number } // label e.g. "14.2 lb carp"
  | { kind: "upgrade"; firstName: string; label: string; line: GearLine } // label e.g. "Carbon rod"
  | { kind: "bottle" }
  | { kind: "fund"; firstName: string; amount: number };

export interface StoreCard {
  fish: StoreFishPrice;
  lastActivity: StoreActivity | null;
}

export type StoreItem = GearLine | "worms";

// A tap on one of the card's gear buttons. For a rod or boat, the first tap only quotes (CONFIRM), and a
// second tap on the same button within BUY_CONFIRM_SECONDS buys (BOUGHT), so nobody spends hundreds of
// beans by accident and no confirmation message is ever posted. Worms are cheap: one tap buys one.
export type StoreTapResult =
  | { kind: "CONFIRM"; item: StoreItem; name: string; price: number; balance: number }
  | { kind: "BOUGHT"; item: StoreItem; name: string; price: number; balance: number; gear: AnglerGear }
  | { kind: "CANT_AFFORD"; item: StoreItem; name: string; price: number; balance: number }
  | { kind: "MAXED"; item: StoreItem; name: string } // already has the top tier, or a full worm can
  | { kind: "FULL"; item: "worms"; worms: number };

// A buy from the store page (see buyGear), which has its own confirm step, so it never asks for a second tap.
export type StoreBuyResult = Exclude<StoreTapResult, { kind: "CONFIRM" }>;

export const BUY_CONFIRM_SECONDS = 15;

// A purchase that isn't gear (a message in a bottle, a pet fund donation), from charge.
export type StoreChargeResult = { ok: true; balance: number } | { ok: false; balance: number };

// A tide chart bought on the store page (see buyTideChart). until is epoch seconds.
export type TideChartBuyResult = { ok: true; until: number; balance: number } | { ok: false; reason: "CANT_AFFORD"; balance: number };

export interface StoreSaleResult {
  amount: number; // everything paid, bonus included
  balance: number;
  bonus: number; // the part of amount a sale bonus added (0 for a plain sale)
}

// One per chat (idFromName(`store_${chatId}`)): everyone's wallet, and a ledger of every bean in or out.
// Things to sell live with whatever game produced them (fish stay in the Fishing DO, which marks them
// sold); this DO only prices them and pays out. The ledger has one row per sale of a given item (see the
// unique index), so a retried sale can't pay twice. Callers pass chatId because a DO doesn't know the
// name it was created from, and the chat's prices are seeded from it.
export class Store extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.migrate();
  }

  // Same _schema_migrations approach as the Pet and Fishing DOs.
  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    const version = this.ctx.storage.sql
      .exec<{ version: number }>(`SELECT COALESCE(MAX(id), 0) as version FROM _schema_migrations`)
      .one().version;

    if (version < 1) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE wallets (
          user_id INTEGER PRIMARY KEY,
          first_name TEXT NOT NULL,
          balance INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      // reason: 'sale', 'buy', or 'refund'. source + item_id say what was sold: ('fish', catch id). A refund's
      // item_id is the ledger id of the buy it gives back (see refund).
      this.ctx.storage.sql.exec(`
        CREATE TABLE ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          first_name TEXT NOT NULL,
          delta INTEGER NOT NULL,
          reason TEXT NOT NULL,
          source TEXT,
          item_id INTEGER,
          label TEXT,
          at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      this.ctx.storage.sql.exec(`CREATE UNIQUE INDEX idx_ledger_one_sale ON ledger(source, item_id) WHERE reason = 'sale'`);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (1)`);
    }

    if (version < 2) {
      // Gear (see gear.ts): rod and boat tiers by number, and how many worms are left. No row means
      // starter gear. pending_buys holds a first tap on a gear button until the confirming second tap.
      this.ctx.storage.sql.exec(`
        CREATE TABLE gear (
          user_id INTEGER PRIMARY KEY,
          rod INTEGER NOT NULL DEFAULT 0,
          boat INTEGER NOT NULL DEFAULT 0,
          worms INTEGER NOT NULL DEFAULT 0
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE pending_buys (
          user_id INTEGER PRIMARY KEY,
          item TEXT NOT NULL,
          tapped_at INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (2)`);
    }

    if (version < 3) {
      // The chat's most recent /store card (one row, replaced by each new card), so a sale or upgrade made in
      // the store page can update that card's activity line. thread_id is NULL outside forum topics.
      this.ctx.storage.sql.exec(`
        CREATE TABLE cards (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          message_id INTEGER NOT NULL,
          thread_id INTEGER,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (3)`);
    }

    if (version < 4) {
      // The tide chart (see TIDE_CHART_ITEM in gear.ts): epoch seconds it's good until, NULL if never bought. Kept
      // with the gear, so a chart bought by someone with starter gear gets a gear row with the starter tiers.
      this.ctx.storage.sql.exec(`ALTER TABLE gear ADD COLUMN chart_until INTEGER`);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (4)`);
    }

    if (version < 5) {
      // This chat's location for its sunrise, so the fish price turns over with the fishing day (see fishingDay).
      // A copy of the Fishing DO's: the owner's /setlocation writes both. NULL means the default.
      this.ctx.storage.sql.exec(`
        CREATE TABLE store_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          lat REAL,
          lon REAL
        )
      `);
      this.ctx.storage.sql.exec(`INSERT INTO store_settings (id) VALUES (1)`);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (5)`);
    }
  }

  // A bottle or pet fund donation that was refunded (it never went in the water, or the fund refused it; see refund)
  // isn't news.
  async card(chatId: number): Promise<StoreCard> {
    const row = this.ctx.storage.sql
      .exec<{ first_name: string; label: string; delta: number; reason: string; source: string }>(
        `SELECT first_name, label, delta, reason, source FROM ledger l
         WHERE reason = 'sale'
            OR (reason = 'buy' AND source IN ('rod', 'boat'))
            OR (reason = 'buy' AND source IN ('bottle', 'fund')
                AND NOT EXISTS (SELECT 1 FROM ledger r WHERE r.reason = 'refund' AND r.item_id = l.id))
         ORDER BY id DESC LIMIT 1`
      )
      .toArray()[0];
    const lastActivity: StoreActivity | null = !row
      ? null
      : row.reason === "sale"
        ? { kind: "sale", firstName: row.first_name, label: row.label, amount: row.delta }
        : row.source === "bottle"
          ? { kind: "bottle" }
          : row.source === "fund"
            ? { kind: "fund", firstName: row.first_name, amount: -row.delta } // a buy's delta is negative
            : { kind: "upgrade", firstName: row.first_name, label: row.label, line: row.source as GearLine };
    return { fish: this.fishPrice(chatId), lastActivity };
  }

  // Remembers a newly posted /store card, replacing the last one (older cards are left as they are).
  async recordCard(messageId: number, threadId: number | null): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO cards (id, message_id, thread_id) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET message_id = excluded.message_id, thread_id = excluded.thread_id, updated_at = datetime('now')`,
      messageId,
      threadId
    );
  }

  // The chat's most recent /store card, or null if none has been posted since cards were recorded.
  async latestCard(): Promise<{ messageId: number; threadId: number | null } | null> {
    const row = this.ctx.storage.sql
      .exec<{ message_id: number; thread_id: number | null }>(`SELECT message_id, thread_id FROM cards WHERE id = 1`)
      .toArray()[0];
    return row ? { messageId: row.message_id, threadId: row.thread_id } : null;
  }

  async gear(userId: number): Promise<AnglerGear> {
    return this.gearOf(userId);
  }

  private gearOf(userId: number): AnglerGear {
    const row = this.ctx.storage.sql
      .exec<{ rod: number; boat: number; worms: number }>(`SELECT rod, boat, worms FROM gear WHERE user_id = ?`, userId)
      .toArray()[0];
    return row ? { rod: row.rod, boat: row.boat, worms: row.worms } : { ...STARTER_GEAR };
  }

  // Called after a cast that used a worm went through (not before, so a cast that never happens, like a
  // second /fish today, never costs one).
  async useWorm(userId: number): Promise<void> {
    this.ctx.storage.sql.exec(`UPDATE gear SET worms = worms - 1 WHERE user_id = ? AND worms > 0`, userId);
  }

  // A tap on a gear button (see StoreTapResult). No await in here, so a double tap can't buy twice or
  // spend beans it doesn't have. A rod or boat tap that isn't confirming a recent first tap only quotes;
  // everything else goes to purchase, which checks the price and balance again, still with no await between.
  async tapGear(input: { userId: number; firstName: string; item: StoreItem }): Promise<StoreTapResult> {
    const now = Math.floor(Date.now() / 1000);
    const { userId, item } = input;

    if (item !== "worms") {
      const offer = this.offer(this.gearOf(userId), item);
      if (offer.kind !== "OFFER") {
        return offer;
      }
      const { name, price } = offer;
      const balance = this.balance(userId);
      if (balance < price) {
        this.ctx.storage.sql.exec(`DELETE FROM pending_buys WHERE user_id = ?`, userId);
        return { kind: "CANT_AFFORD", item, name, price, balance };
      }
      const pending = this.ctx.storage.sql
        .exec<{ item: string; tapped_at: number }>(`SELECT item, tapped_at FROM pending_buys WHERE user_id = ?`, userId)
        .toArray()[0];
      if (!(pending?.item === item && now - pending.tapped_at <= BUY_CONFIRM_SECONDS)) {
        this.ctx.storage.sql.exec(
          `INSERT INTO pending_buys (user_id, item, tapped_at) VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET item = excluded.item, tapped_at = excluded.tapped_at`,
          userId,
          item,
          now
        );
        return { kind: "CONFIRM", item, name, price, balance };
      }
    }

    return this.purchase(input);
  }

  // A buy from the store page: no second tap, since the page asks before it calls this.
  async buyGear(input: { userId: number; firstName: string; item: StoreItem }): Promise<StoreBuyResult> {
    return this.purchase(input);
  }

  // What the next one of item costs this angler, or why there isn't one (top tier, or a full worm can).
  private offer(
    gear: AnglerGear,
    item: StoreItem
  ): { kind: "OFFER"; name: string; price: number } | Extract<StoreTapResult, { kind: "MAXED" | "FULL" }> {
    if (item === "worms") {
      return gear.worms >= WORMS.maxHeld
        ? { kind: "FULL", item, worms: gear.worms }
        : { kind: "OFFER", name: "Worm", price: WORMS.price };
    }
    const tiers = GEAR_LINES[item].tiers;
    const next = tiers[gear[item] + 1];
    return next ? { kind: "OFFER", name: next.name, price: next.price } : { kind: "MAXED", item, name: tiers[gear[item]]!.name };
  }

  // Buys item now, for tapGear (once confirmed) and buyGear. Synchronous, so nothing can run between reading
  // the gear and balance and writing the purchase. Any half-finished tap on the card is cleared either way.
  private purchase(input: { userId: number; firstName: string; item: StoreItem }): StoreBuyResult {
    const { userId, item } = input;
    const gear = this.gearOf(userId);
    const offer = this.offer(gear, item);
    if (offer.kind !== "OFFER") {
      return offer;
    }
    const { name, price } = offer;

    const balance = this.balance(userId);
    this.ctx.storage.sql.exec(`DELETE FROM pending_buys WHERE user_id = ?`, userId);
    if (balance < price) {
      return { kind: "CANT_AFFORD", item, name, price, balance };
    }
    const newBalance = this.ctx.storage.sql
      .exec<{ balance: number }>(
        `UPDATE wallets SET balance = balance - ?, first_name = ?, updated_at = datetime('now') WHERE user_id = ? RETURNING balance`,
        price,
        input.firstName,
        userId
      )
      .one().balance;
    this.ctx.storage.sql.exec(
      `INSERT INTO ledger (user_id, first_name, delta, reason, source, label) VALUES (?, ?, ?, 'buy', ?, ?)`,
      userId,
      input.firstName,
      -price,
      item === "worms" ? "bait" : item,
      name
    );
    const updated: AnglerGear =
      item === "worms" ? { ...gear, worms: gear.worms + 1 } : { ...gear, [item]: gear[item] + 1 };
    this.ctx.storage.sql.exec(
      `INSERT INTO gear (user_id, rod, boat, worms) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET rod = excluded.rod, boat = excluded.boat, worms = excluded.worms`,
      userId,
      updated.rod,
      updated.boat,
      updated.worms
    );
    return { kind: "BOUGHT", item, name, price, balance: newBalance, gear: updated };
  }

  // Takes amount out of the wallet for something that isn't gear (source says what, e.g. 'bottle'), or refuses if
  // the balance is short. Synchronous inside, so nothing can spend the same beans between the check and the debit.
  async charge(input: { userId: number; firstName: string; amount: number; source: string; label: string }): Promise<StoreChargeResult> {
    return this.debit(input);
  }

  // A tide chart (see TIDE_CHART_ITEM): charges for it and pushes chart_until out by its days, from now or from
  // when the current one runs out, whichever is later. One synchronous step, so a double tap can't pay once and
  // extend twice. Its ledger rows (source 'chart') never show on the card's activity line (see card).
  async buyTideChart(input: { userId: number; firstName: string }): Promise<TideChartBuyResult> {
    const now = Math.floor(Date.now() / 1000);
    const charged = this.debit({ ...input, amount: TIDE_CHART_ITEM.price, source: "chart", label: "Tide chart" });
    if (!charged.ok) {
      return { ok: false, reason: "CANT_AFFORD", balance: charged.balance };
    }
    const until = Math.max(now, this.chartUntilOf(input.userId) ?? 0) + TIDE_CHART_ITEM.days * 24 * 60 * 60;
    this.ctx.storage.sql.exec(
      `INSERT INTO gear (user_id, chart_until) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET chart_until = excluded.chart_until`,
      input.userId,
      until
    );
    return { ok: true, until, balance: charged.balance };
  }

  // When this angler's tide chart runs out (epoch seconds, maybe already past), or null if they never bought one.
  async chartUntil(userId: number): Promise<number | null> {
    return this.chartUntilOf(userId);
  }

  private chartUntilOf(userId: number): number | null {
    return (
      this.ctx.storage.sql
        .exec<{ chart_until: number | null }>(`SELECT chart_until FROM gear WHERE user_id = ?`, userId)
        .toArray()[0]?.chart_until ?? null
    );
  }

  // charge's body, synchronous so buyTideChart can debit and write in the same step.
  private debit(input: { userId: number; firstName: string; amount: number; source: string; label: string }): StoreChargeResult {
    const { userId, amount } = input;
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error(`charge amount must be a positive integer, got ${amount}`);
    }
    const balance = this.balance(userId);
    if (balance < amount) {
      return { ok: false, balance };
    }
    const newBalance = this.ctx.storage.sql
      .exec<{ balance: number }>(
        `UPDATE wallets SET balance = balance - ?, first_name = ?, updated_at = datetime('now') WHERE user_id = ? RETURNING balance`,
        amount,
        input.firstName,
        userId
      )
      .one().balance;
    this.ctx.storage.sql.exec(
      `INSERT INTO ledger (user_id, first_name, delta, reason, source, label) VALUES (?, ?, ?, 'buy', ?, ?)`,
      userId,
      input.firstName,
      -amount,
      input.source,
      input.label
    );
    return { ok: true, balance: newBalance };
  }

  // Gives back a charge whose purchase didn't go through (e.g. the bottle limit was hit after paying). The refund's
  // item_id points at the most recent matching buy that hasn't been refunded yet, so the card can tell that buy never
  // really happened. Returns the new balance.
  async refund(input: { userId: number; firstName: string; amount: number; source: string; label: string }): Promise<number> {
    const { userId, amount } = input;
    const buy = this.ctx.storage.sql
      .exec<{ id: number }>(
        `SELECT id FROM ledger l
         WHERE user_id = ? AND reason = 'buy' AND source = ? AND delta = ?
           AND NOT EXISTS (SELECT 1 FROM ledger r WHERE r.reason = 'refund' AND r.item_id = l.id)
         ORDER BY id DESC LIMIT 1`,
        userId,
        input.source,
        -amount
      )
      .toArray()[0];
    this.ctx.storage.sql.exec(
      `INSERT INTO ledger (user_id, first_name, delta, reason, source, item_id, label) VALUES (?, ?, ?, 'refund', ?, ?, ?)`,
      userId,
      input.firstName,
      amount,
      input.source,
      buy?.id ?? null,
      input.label
    );
    return this.ctx.storage.sql
      .exec<{ balance: number }>(
        `INSERT INTO wallets (user_id, first_name, balance) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET first_name = excluded.first_name, balance = balance + excluded.balance,
           updated_at = datetime('now')
         RETURNING balance`,
        userId,
        input.firstName,
        amount
      )
      .one().balance;
  }

  // What this fish would sell for right now (the label on a /fish reply's Sell button).
  async quoteFish(chatId: number, fish: { species: string; weight: number }): Promise<number> {
    return fishSalePrice(fish.weight, speciesTier(fish.species), this.fishPrice(chatId).perLb);
  }

  // quoteFish for a whole bucket (the store page), in the same order, from one look at today's price.
  async quoteFishes(chatId: number, fish: { species: string; weight: number }[]): Promise<number[]> {
    const { perLb } = this.fishPrice(chatId);
    return fish.map((one) => fishSalePrice(one.weight, speciesTier(one.species), perLb));
  }

  // Pays for a fish the Fishing DO has already marked sold. No await in here, so the ledger check and the
  // payout can't interleave with another sale. Selling the same fish again (a retry after the caller lost
  // the reply) pays nothing more and reports the original sale. bonus is an extra share of the price (the card's
  // random sell passes RANDOM_SELL_BONUS); the result's bonus is how many of the beans it added.
  async sellFish(input: { chatId: number; userId: number; firstName: string; fish: HeldFish; bonus?: number }): Promise<StoreSaleResult> {
    const { fish } = input;
    const previous = this.ctx.storage.sql
      .exec<{ delta: number }>(`SELECT delta FROM ledger WHERE reason = 'sale' AND source = 'fish' AND item_id = ?`, fish.id)
      .toArray()[0];
    if (previous) {
      return { amount: previous.delta, balance: this.balance(input.userId), bonus: 0 };
    }

    const price = fishSalePrice(fish.weight, speciesTier(fish.species), this.fishPrice(input.chatId).perLb);
    const bonus = saleBonus(price, input.bonus ?? 0);
    const amount = price + bonus;
    this.ctx.storage.sql.exec(
      `INSERT INTO ledger (user_id, first_name, delta, reason, source, item_id, label) VALUES (?, ?, ?, 'sale', 'fish', ?, ?)`,
      input.userId,
      input.firstName,
      amount,
      fish.id,
      `${fish.weight.toFixed(1)} lb ${fish.species}`
    );
    const balance = this.ctx.storage.sql
      .exec<{ balance: number }>(
        `INSERT INTO wallets (user_id, first_name, balance) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET first_name = excluded.first_name, balance = balance + excluded.balance,
           updated_at = datetime('now')
         RETURNING balance`,
        input.userId,
        input.firstName,
        amount
      )
      .one().balance;
    return { amount, balance, bonus };
  }

  // A wallet's balance and gear, for the private Wallet pop-up.
  async wallet(userId: number): Promise<{ balance: number; gear: AnglerGear }> {
    return { balance: this.balance(userId), gear: this.gearOf(userId) };
  }

  private balance(userId: number): number {
    return (
      this.ctx.storage.sql.exec<{ balance: number }>(`SELECT balance FROM wallets WHERE user_id = ?`, userId).toArray()[0]?.balance ?? 0
    );
  }

  // The owner's /setlocation (see the Fishing DO's, which it mirrors). null goes back to the default.
  async setLocation(location: GeoLocation | null): Promise<void> {
    this.ctx.storage.sql.exec(`UPDATE store_settings SET lat = ?, lon = ? WHERE id = 1`, location?.lat ?? null, location?.lon ?? null);
  }

  private fishPrice(chatId: number): StoreFishPrice {
    const row = this.ctx.storage.sql.exec<{ lat: number | null; lon: number | null }>(`SELECT lat, lon FROM store_settings WHERE id = 1`).one();
    const location = row.lat !== null && row.lon !== null ? { lat: row.lat, lon: row.lon } : defaultLocation(this.env);
    const now = new Date();
    const { dayNumber } = fishingDay(easternParts(now), Math.floor(now.getTime() / 1000), location);
    return {
      perLb: fishPricePerLb(this.fishPriceIndex(chatId, dayNumber)),
      yesterdayPerLb: fishPricePerLb(this.fishPriceIndex(chatId, dayNumber - 1)),
    };
  }

  // Nothing stored: a day's index is just PRICE_WINDOW_DAYS hashes, like the tide. Without the secret,
  // prices stay flat rather than becoming predictable from the source code.
  private fishPriceIndex(chatId: number, dayNumber: number): number {
    const secret = this.env.TIDE_SECRET;
    if (!secret) {
      return 1;
    }
    const normals: number[] = [];
    for (let day = dayNumber - STORE_CONFIG.PRICE_WINDOW_DAYS + 1; day <= dayNumber; day++) {
      normals.push(seededNormal(`${secret}:fish-price:${chatId}:${day}`));
    }
    return fishPriceIndex(normals);
  }
}
