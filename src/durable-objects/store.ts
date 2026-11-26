import { DurableObject } from "cloudflare:workers";
import type { Env } from "../main.js";
import { easternParts } from "../eastern-time.js";
import { fishingDay, seededNormal, speciesTier } from "../fishing-math.js";
import { STORE_CONFIG, fishPriceIndex, fishPricePerLb, fishSalePrice } from "../store-math.js";
import { GEAR_LINES, STARTER_GEAR, WORMS, type AnglerGear, type GearLine } from "../gear.js";
import type { HeldFish } from "./fishing.js";

export interface StoreFishPrice {
  perLb: number;
  yesterdayPerLb: number;
}

// The card's latest-activity line: a sale, or someone upgrading their gear (worms aren't news).
export type StoreActivity =
  | { kind: "sale"; firstName: string; label: string; amount: number } // label e.g. "14.2 lb carp"
  | { kind: "upgrade"; firstName: string; label: string; line: GearLine }; // label e.g. "Carbon rod"

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

export const BUY_CONFIRM_SECONDS = 15;

export interface StoreSaleResult {
  amount: number;
  balance: number;
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
      // reason: 'sale' for now ('buy' next). source + item_id say what was sold: ('fish', catch id).
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
  }

  async card(chatId: number): Promise<StoreCard> {
    const row = this.ctx.storage.sql
      .exec<{ first_name: string; label: string; delta: number; reason: string; source: string }>(
        `SELECT first_name, label, delta, reason, source FROM ledger
         WHERE reason = 'sale' OR (reason = 'buy' AND source IN ('rod', 'boat'))
         ORDER BY id DESC LIMIT 1`
      )
      .toArray()[0];
    const lastActivity: StoreActivity | null = !row
      ? null
      : row.reason === "sale"
        ? { kind: "sale", firstName: row.first_name, label: row.label, amount: row.delta }
        : { kind: "upgrade", firstName: row.first_name, label: row.label, line: row.source as GearLine };
    return { fish: this.fishPrice(chatId), lastActivity };
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
  // spend beans it doesn't have.
  async tapGear(input: { userId: number; firstName: string; item: StoreItem }): Promise<StoreTapResult> {
    const now = Math.floor(Date.now() / 1000);
    const { userId, item } = input;
    const gear = this.gearOf(userId);

    let name: string;
    let price: number;
    if (item === "worms") {
      if (gear.worms >= WORMS.maxHeld) {
        return { kind: "FULL", item, worms: gear.worms };
      }
      name = "Worm";
      price = WORMS.price;
    } else {
      const tiers = GEAR_LINES[item].tiers;
      const next = tiers[gear[item] + 1];
      if (!next) {
        return { kind: "MAXED", item, name: tiers[gear[item]]!.name };
      }
      name = next.name;
      price = next.price;
    }

    const balance = this.balance(userId);
    const pending = this.ctx.storage.sql
      .exec<{ item: string; tapped_at: number }>(`SELECT item, tapped_at FROM pending_buys WHERE user_id = ?`, userId)
      .toArray()[0];
    const confirming = item === "worms" || (pending?.item === item && now - pending.tapped_at <= BUY_CONFIRM_SECONDS);
    if (balance < price) {
      this.ctx.storage.sql.exec(`DELETE FROM pending_buys WHERE user_id = ?`, userId);
      return { kind: "CANT_AFFORD", item, name, price, balance };
    }
    if (!confirming) {
      this.ctx.storage.sql.exec(
        `INSERT INTO pending_buys (user_id, item, tapped_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET item = excluded.item, tapped_at = excluded.tapped_at`,
        userId,
        item,
        now
      );
      return { kind: "CONFIRM", item, name, price, balance };
    }

    this.ctx.storage.sql.exec(`DELETE FROM pending_buys WHERE user_id = ?`, userId);
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

  // What this fish would sell for right now (the label on a /fish reply's Sell button).
  async quoteFish(chatId: number, fish: { species: string; weight: number }): Promise<number> {
    return fishSalePrice(fish.weight, speciesTier(fish.species), this.fishPrice(chatId).perLb);
  }

  // Pays for a fish the Fishing DO has already marked sold. No await in here, so the ledger check and the
  // payout can't interleave with another sale. Selling the same fish again (a retry after the caller lost
  // the reply) pays nothing more and reports the original sale.
  async sellFish(input: { chatId: number; userId: number; firstName: string; fish: HeldFish }): Promise<StoreSaleResult> {
    const { fish } = input;
    const previous = this.ctx.storage.sql
      .exec<{ delta: number }>(`SELECT delta FROM ledger WHERE reason = 'sale' AND source = 'fish' AND item_id = ?`, fish.id)
      .toArray()[0];
    if (previous) {
      return { amount: previous.delta, balance: this.balance(input.userId) };
    }

    const amount = fishSalePrice(fish.weight, speciesTier(fish.species), this.fishPrice(input.chatId).perLb);
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
    return { amount, balance };
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

  private fishPrice(chatId: number): StoreFishPrice {
    const { dayNumber } = fishingDay(easternParts(new Date()));
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
