import { DurableObject } from "cloudflare:workers";
import type { Env } from "../main.js";
import { easternParts } from "../eastern-time.js";
import { fishingDay, seededNormal, speciesTier } from "../fishing-math.js";
import { STORE_CONFIG, fishPriceIndex, fishPricePerLb, fishSalePrice } from "../store-math.js";
import type { HeldFish } from "./fishing.js";

export interface StoreFishPrice {
  perLb: number;
  yesterdayPerLb: number;
}

export interface StoreSale {
  firstName: string;
  label: string; // e.g. "14.2 lb carp"
  amount: number;
}

export interface StoreCard {
  fish: StoreFishPrice;
  lastSale: StoreSale | null;
}

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
  }

  async card(chatId: number): Promise<StoreCard> {
    const sale = this.ctx.storage.sql
      .exec<{ first_name: string; label: string; delta: number }>(
        `SELECT first_name, label, delta FROM ledger WHERE reason = 'sale' ORDER BY id DESC LIMIT 1`
      )
      .toArray()[0];
    return {
      fish: this.fishPrice(chatId),
      lastSale: sale ? { firstName: sale.first_name, label: sale.label, amount: sale.delta } : null,
    };
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

  // A wallet's balance, for the private Wallet pop-up.
  async wallet(userId: number): Promise<number> {
    return this.balance(userId);
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
