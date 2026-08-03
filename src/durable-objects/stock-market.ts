import { DurableObject } from "cloudflare:workers";
import type { Env } from "../main.js";

const STARTING_PRICE = 100;
const STARTING_CASH = 500;
const WEEKLY_ALLOWANCE = 100;

// Your own messages move your price a little; replies you get from someone else move it a lot more, since
// that's an external signal rather than something you can just spam your way to. Both decay per-occurrence
// today so neither can be pumped by volume alone — replies (and reactions, below) decay per (actor, recipient)
// pair specifically, so two people can't just farm each other all day.
const MESSAGE_BASE_IMPACT = 0.5;
const REPLY_BASE_IMPACT = 2.0;
const IMPACT_DECAY = 0.85;

// Anyone with zero price-moving activity on a given day drifts toward the chat's average price instead of
// holding a stale pump (or a stale crash) forever.
const DAILY_DECAY_GRAVITY = 0.05;

// message_authors only exists to resolve a reaction back to who wrote the reacted-to message, and
// price_events doubles as an audit trail (only "today"'s rows are ever queried for the decay math above) —
// storage cost here is negligible either way, so both windows are generous rather than tight.
const MESSAGE_AUTHOR_RETENTION_DAYS = 60;
const PRICE_EVENT_RETENTION_DAYS = 180;

// Emoji with unambiguous sentiment get a fixed weight; everything else (🗿🌚🍌 etc. — anything not listed
// below) still moves price, just unpredictably — see randomMemeWeight.
const REACTION_WEIGHTS: Record<string, number> = {
  // Strong positive
  "🔥": 1.5,
  "❤": 1.5,
  "🥰": 1.5,
  "😍": 1.5,
  "🏆": 1.5,
  "💯": 1.5,
  "🤩": 1.5,
  "😘": 1.5,
  "💘": 1.5,
  "🎉": 1.5,
  // Mild positive
  "👍": 0.75,
  "👏": 0.75,
  "🤝": 0.75,
  "🙏": 0.75,
  "😁": 0.75,
  "🤗": 0.75,
  "🫡": 0.75,
  "✍": 0.75,
  "👌": 0.75,
  "😎": 0.75,
  // Mild negative
  "👎": -0.75,
  "😢": -0.75,
  "😭": -0.75,
  "💔": -0.75,
  "😱": -0.75,
  // Strong negative
  "🤡": -1.5,
  "🤮": -1.5,
  "💩": -1.5,
  "🖕": -1.5,
  "😡": -1.5,
  "🤬": -1.5,
};

export interface StockMarketPlayer {
  userId: number;
  username: string | null;
  ticker: string | null;
  firstName: string;
  price: number;
  cash: number;
  dailyChange: number; // sum of today's (since UTC midnight) price_events deltas — can be negative
}

export interface StockMarketHolding {
  stockUserId: number;
  username: string | null;
  ticker: string | null;
  firstName: string;
  shares: number;
  price: number;
  value: number;
  dailyChange: number; // the held stock's own daily change, same meaning as StockMarketPlayer.dailyChange
}

export type StockMarketSetTickerResult = "OK" | "NOT_A_PLAYER" | "TAKEN";

export interface StockMarketPortfolio extends StockMarketPlayer {
  holdings: StockMarketHolding[];
}

export type StockMarketTradeErrorType =
  | "INVALID_AMOUNT"
  | "CANNOT_TRADE_SELF"
  | "UNKNOWN_STOCK"
  | "INSUFFICIENT_CASH"
  | "INSUFFICIENT_SHARES";

export type StockMarketTradeResult =
  | { ok: true; shares: number; price: number; total: number; totalShares: number }
  | { ok: false; type: StockMarketTradeErrorType };

interface PlayerRow {
  [column: string]: SqlStorageValue;
  user_id: number;
  username: string | null;
  ticker: string | null;
  first_name: string;
  price: number;
  cash: number;
}

function toPlayer(row: PlayerRow, dailyChange: number): StockMarketPlayer {
  return {
    userId: row.user_id,
    username: row.username,
    ticker: row.ticker,
    firstName: row.first_name,
    price: row.price,
    cash: row.cash,
    dailyChange,
  };
}

// A fresh coin flip every time, not a fixed weight per emoji — 🗿 doesn't become "the cursed one", it's just
// unpredictable, matching the joke spirit of reactions with no clear sentiment.
function randomMemeWeight(): number {
  return (Math.random() * 2 - 1) * 1.5;
}

// One instance per chat, same pattern as WordleGolf — every member's stock, holdings, and price-moving
// activity for this chat lives in one place so leaderboard/portfolio queries are a single local join.
export class StockMarket extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.migrate();
  }

  // DO SQLite has no PRAGMA user_version, so schema version is tracked in its own table instead. Needed
  // because CREATE TABLE IF NOT EXISTS is a no-op against an already-existing table — changing a column's
  // CHECK constraint (like adding 'reaction' below) requires an actual migration, not just editing the DDL
  // string, or every already-running instance keeps enforcing the old constraint forever.
  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    const version = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; version: number }>(`SELECT COALESCE(MAX(id), 0) as version FROM _schema_migrations`)
      .one().version;

    if (version < 1) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS players (
          user_id INTEGER PRIMARY KEY,
          username TEXT,
          first_name TEXT NOT NULL,
          price REAL NOT NULL DEFAULT ${STARTING_PRICE},
          cash REAL NOT NULL DEFAULT ${STARTING_CASH},
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS holdings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          owner_user_id INTEGER NOT NULL REFERENCES players(user_id),
          stock_user_id INTEGER NOT NULL REFERENCES players(user_id),
          shares INTEGER NOT NULL DEFAULT 0,
          UNIQUE(owner_user_id, stock_user_id)
        )
      `);
      // reason: 'message' (own post) or 'decay' (daily gravity) at this version — 'reply'/'reaction' land in
      // migration 2 below. counterparty_user_id is the other person for those, used for pairwise decay.
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS price_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES players(user_id),
          counterparty_user_id INTEGER,
          reason TEXT NOT NULL CHECK (reason IN ('message', 'reply', 'decay')),
          delta REAL NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (1)`);
    }

    if (version < 2) {
      // SQLite can't alter a CHECK constraint in place — rebuild the table with 'reaction' added.
      this.ctx.storage.sql.exec(`
        CREATE TABLE price_events_v2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES players(user_id),
          counterparty_user_id INTEGER,
          reason TEXT NOT NULL CHECK (reason IN ('message', 'reply', 'reaction', 'decay')),
          delta REAL NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      this.ctx.storage.sql.exec(`INSERT INTO price_events_v2 SELECT * FROM price_events`);
      this.ctx.storage.sql.exec(`DROP TABLE price_events`);
      this.ctx.storage.sql.exec(`ALTER TABLE price_events_v2 RENAME TO price_events`);

      // Telegram's message_reaction updates only give a message_id, never who wrote it — this is how we
      // resolve a reaction back to whose stock it should move.
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS message_authors (
          message_id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES players(user_id)
        )
      `);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (2)`);
    }

    if (version < 3) {
      // Adds created_at so purgeOldData (below) can age out rows. Existing rows backfill to "now" via the
      // column default — harmless, it just delays their purge eligibility rather than losing anything.
      this.ctx.storage.sql.exec(`
        CREATE TABLE message_authors_v3 (
          message_id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES players(user_id),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      this.ctx.storage.sql.exec(`INSERT INTO message_authors_v3 (message_id, user_id) SELECT message_id, user_id FROM message_authors`);
      this.ctx.storage.sql.exec(`DROP TABLE message_authors`);
      this.ctx.storage.sql.exec(`ALTER TABLE message_authors_v3 RENAME TO message_authors`);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (3)`);
    }

    if (version < 4) {
      // Plain ADD COLUMN is enough here (unlike the price_events rebuilds above) since there's no CHECK
      // constraint involved. SQLite won't let ADD COLUMN declare UNIQUE directly, so that's enforced via
      // a separate index instead — which also means multiple NULL tickers (the common case: nobody's set
      // one yet) are allowed side by side, since SQL treats NULLs as distinct for uniqueness purposes.
      this.ctx.storage.sql.exec(`ALTER TABLE players ADD COLUMN ticker TEXT`);
      this.ctx.storage.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_players_ticker ON players(ticker)`);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (4)`);
    }
  }

  async recordMessage(input: { messageId: number; userId: number; username?: string; firstName: string }): Promise<void> {
    this.upsertPlayer(input);
    this.ctx.storage.sql.exec(
      `INSERT INTO message_authors (message_id, user_id) VALUES (?, ?) ON CONFLICT(message_id) DO NOTHING`,
      input.messageId,
      input.userId
    );

    const countToday = this.ctx.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) as count FROM price_events
         WHERE user_id = ? AND reason = 'message' AND created_at >= datetime('now', 'start of day')`,
        input.userId
      )
      .one().count;

    this.applyPriceChange(input.userId, MESSAGE_BASE_IMPACT * Math.pow(IMPACT_DECAY, countToday), "message", null);
  }

  // Telegram tells us the message_id that was reacted to and who reacted, but never who wrote the original
  // message — resolved via message_authors, populated in recordMessage above. No-ops for self-reactions or
  // messages we never saw (sent before this feature existed, for instance).
  async recordReaction(input: { messageId: number; reactorUserId: number; emoji: string }): Promise<void> {
    const weight = REACTION_WEIGHTS[input.emoji] ?? randomMemeWeight();

    const author = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; user_id: number }>(
        `SELECT user_id FROM message_authors WHERE message_id = ?`,
        input.messageId
      )
      .toArray()[0];
    if (!author || author.user_id === input.reactorUserId) {
      return;
    }

    const countToday = this.ctx.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) as count FROM price_events
         WHERE user_id = ? AND counterparty_user_id = ? AND reason = 'reaction' AND created_at >= datetime('now', 'start of day')`,
        author.user_id,
        input.reactorUserId
      )
      .one().count;

    this.applyPriceChange(author.user_id, weight * Math.pow(IMPACT_DECAY, countToday), "reaction", input.reactorUserId);
  }

  async recordReply(input: {
    recipientUserId: number;
    recipientUsername?: string;
    recipientFirstName: string;
    replierUserId: number;
  }): Promise<void> {
    // Only bumps an existing stock — never creates one. Telegram still resolves reply_to_message.from
    // for a reply to someone's old message even after they've left the chat (or if they've simply never
    // posted since this feature launched), so without this check a stale reply alone could conjure up a
    // stock for someone who never generated any activity of their own.
    const recipientExists = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; user_id: number }>(`SELECT user_id FROM players WHERE user_id = ?`, input.recipientUserId)
      .toArray().length > 0;
    if (!recipientExists) {
      return;
    }

    this.upsertPlayer({
      userId: input.recipientUserId,
      ...(input.recipientUsername !== undefined && { username: input.recipientUsername }),
      firstName: input.recipientFirstName,
    });

    const countToday = this.ctx.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) as count FROM price_events
         WHERE user_id = ? AND counterparty_user_id = ? AND reason = 'reply' AND created_at >= datetime('now', 'start of day')`,
        input.recipientUserId,
        input.replierUserId
      )
      .one().count;

    this.applyPriceChange(
      input.recipientUserId,
      REPLY_BASE_IMPACT * Math.pow(IMPACT_DECAY, countToday),
      "reply",
      input.replierUserId
    );
  }

  async getPortfolio(userId: number): Promise<StockMarketPortfolio | null> {
    const row = this.ctx.storage.sql.exec<PlayerRow>(`SELECT * FROM players WHERE user_id = ?`, userId).toArray()[0];
    if (!row) {
      return null;
    }

    const holdings = this.ctx.storage.sql
      .exec<{
        [column: string]: SqlStorageValue;
        stock_user_id: number;
        shares: number;
        username: string | null;
        ticker: string | null;
        first_name: string;
        price: number;
      }>(
        `SELECT h.stock_user_id, h.shares, p.username, p.ticker, p.first_name, p.price
         FROM holdings h
         JOIN players p ON p.user_id = h.stock_user_id
         WHERE h.owner_user_id = ? AND h.shares > 0
         ORDER BY (h.shares * p.price) DESC`,
        userId
      )
      .toArray();

    const changes = this.getDailyChanges();

    return {
      ...toPlayer(row, changes.get(row.user_id) ?? 0),
      holdings: holdings.map((h) => ({
        stockUserId: h.stock_user_id,
        username: h.username,
        ticker: h.ticker,
        firstName: h.first_name,
        shares: h.shares,
        price: h.price,
        value: h.shares * h.price,
        dailyChange: changes.get(h.stock_user_id) ?? 0,
      })),
    };
  }

  async getMarket(): Promise<StockMarketPlayer[]> {
    const changes = this.getDailyChanges();
    return this.ctx.storage.sql
      .exec<PlayerRow>(`SELECT * FROM players ORDER BY price DESC`)
      .toArray()
      .map((row) => toPlayer(row, changes.get(row.user_id) ?? 0));
  }

  // For /buy $TICKER <n> and /sell $TICKER <n> — tickers are opt-in (see setTicker) and only reachable
  // once set. Not everyone has a Telegram username, which was confusing people when username lookup was
  // the fallback for targeting, so there's no username-based lookup anymore — /value is reply-only, and
  // /buy and /sell use tickers.
  async findPlayerByTicker(ticker: string): Promise<StockMarketPlayer | null> {
    const row = this.ctx.storage.sql.exec<PlayerRow>(`SELECT * FROM players WHERE ticker = ? COLLATE NOCASE`, ticker).toArray()[0];
    return row ? toPlayer(row, this.getDailyChange(row.user_id)) : null;
  }

  async getPlayer(userId: number): Promise<StockMarketPlayer | null> {
    const row = this.ctx.storage.sql.exec<PlayerRow>(`SELECT * FROM players WHERE user_id = ?`, userId).toArray()[0];
    return row ? toPlayer(row, this.getDailyChange(userId)) : null;
  }

  // Requires the caller to already be a player (i.e. have posted a real message) — otherwise a ticker
  // could be assigned to someone who'd just get swept up by purgeGhostPlayers's weekly sweep anyway.
  // Enforced case-insensitively even though the composer already uppercases before calling, since the
  // unique index below is itself case-sensitive (TEXT compares byte-for-byte by default in SQLite).
  async setTicker(userId: number, ticker: string): Promise<StockMarketSetTickerResult> {
    const exists = this.ctx.storage.sql.exec<PlayerRow>(`SELECT user_id FROM players WHERE user_id = ?`, userId).toArray().length > 0;
    if (!exists) {
      return "NOT_A_PLAYER";
    }

    const takenBy = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; user_id: number }>(
        `SELECT user_id FROM players WHERE ticker = ? COLLATE NOCASE AND user_id != ?`,
        ticker,
        userId
      )
      .toArray()[0];
    if (takenBy) {
      return "TAKEN";
    }

    this.ctx.storage.sql.exec(`UPDATE players SET ticker = ?, updated_at = datetime('now') WHERE user_id = ?`, ticker, userId);
    return "OK";
  }

  // Today's (since UTC midnight) net price movement for one player — every price mutation already
  // inserts a timestamped price_events row (see applyPriceChange), so this needs no separate snapshot.
  private getDailyChange(userId: number): number {
    return this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; change: number }>(
        `SELECT COALESCE(SUM(delta), 0) as change FROM price_events
         WHERE user_id = ? AND created_at >= datetime('now', 'start of day')`,
        userId
      )
      .one().change;
  }

  // Same as getDailyChange, but for every player in this chat at once — used wherever a whole roster's
  // worth of changes are needed in one call (getMarket, getPortfolio's owner + all holdings).
  private getDailyChanges(): Map<number, number> {
    const rows = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; user_id: number; change: number }>(
        `SELECT user_id, SUM(delta) as change FROM price_events
         WHERE created_at >= datetime('now', 'start of day')
         GROUP BY user_id`
      )
      .toArray();
    return new Map(rows.map((r) => [r.user_id, r.change]));
  }

  // Runs weekly alongside the allowance/purge sweep. Removes anyone who's never authored a genuine
  // message themselves — a player only ever gets a 'message' reason event by posting, so this catches
  // ghosts (e.g. someone who left before the feature launched but still got upserted via a stale reply)
  // without punishing anyone who's actually participated, no matter how long ago.
  async purgeGhostPlayers(): Promise<void> {
    const ghosts = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; user_id: number }>(
        `SELECT user_id FROM players WHERE user_id NOT IN (SELECT DISTINCT user_id FROM price_events WHERE reason = 'message')`
      )
      .toArray();

    for (const { user_id: userId } of ghosts) {
      this.ctx.storage.sql.exec(`DELETE FROM holdings WHERE owner_user_id = ? OR stock_user_id = ?`, userId, userId);
      this.ctx.storage.sql.exec(`DELETE FROM price_events WHERE user_id = ?`, userId);
      this.ctx.storage.sql.exec(`DELETE FROM message_authors WHERE user_id = ?`, userId);
      this.ctx.storage.sql.exec(`DELETE FROM players WHERE user_id = ?`, userId);
    }
  }

  // Trades always clear against the house at the current listed price — never peer-to-peer, and never
  // affecting the stock's price. If trading volume moved price too, buying someone's stock would become a
  // second pump vector on top of message/reply spam.
  async buy(input: { buyerUserId: number; buyerUsername?: string; buyerFirstName: string; targetUserId: number; shares: number }): Promise<StockMarketTradeResult> {
    if (input.shares <= 0) {
      return { ok: false, type: "INVALID_AMOUNT" };
    }
    if (input.buyerUserId === input.targetUserId) {
      return { ok: false, type: "CANNOT_TRADE_SELF" };
    }

    this.upsertPlayer({
      userId: input.buyerUserId,
      ...(input.buyerUsername !== undefined && { username: input.buyerUsername }),
      firstName: input.buyerFirstName,
    });

    const target = this.ctx.storage.sql.exec<PlayerRow>(`SELECT * FROM players WHERE user_id = ?`, input.targetUserId).toArray()[0];
    if (!target) {
      return { ok: false, type: "UNKNOWN_STOCK" };
    }

    const buyer = this.ctx.storage.sql.exec<PlayerRow>(`SELECT * FROM players WHERE user_id = ?`, input.buyerUserId).one();
    const cost = target.price * input.shares;
    if (buyer.cash < cost) {
      return { ok: false, type: "INSUFFICIENT_CASH" };
    }

    this.ctx.storage.sql.exec(`UPDATE players SET cash = cash - ?, updated_at = datetime('now') WHERE user_id = ?`, cost, input.buyerUserId);
    this.ctx.storage.sql.exec(
      `INSERT INTO holdings (owner_user_id, stock_user_id, shares) VALUES (?, ?, ?)
       ON CONFLICT(owner_user_id, stock_user_id) DO UPDATE SET shares = shares + excluded.shares`,
      input.buyerUserId,
      input.targetUserId,
      input.shares
    );

    const totalShares = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; shares: number }>(
        `SELECT shares FROM holdings WHERE owner_user_id = ? AND stock_user_id = ?`,
        input.buyerUserId,
        input.targetUserId
      )
      .one().shares;

    return { ok: true, shares: input.shares, price: target.price, total: cost, totalShares };
  }

  async sell(input: { sellerUserId: number; targetUserId: number; shares: number }): Promise<StockMarketTradeResult> {
    if (input.shares <= 0) {
      return { ok: false, type: "INVALID_AMOUNT" };
    }

    const target = this.ctx.storage.sql.exec<PlayerRow>(`SELECT * FROM players WHERE user_id = ?`, input.targetUserId).toArray()[0];
    if (!target) {
      return { ok: false, type: "UNKNOWN_STOCK" };
    }

    const holding = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; shares: number }>(
        `SELECT shares FROM holdings WHERE owner_user_id = ? AND stock_user_id = ?`,
        input.sellerUserId,
        input.targetUserId
      )
      .toArray()[0];
    if (!holding || holding.shares < input.shares) {
      return { ok: false, type: "INSUFFICIENT_SHARES" };
    }

    const proceeds = target.price * input.shares;
    this.ctx.storage.sql.exec(
      `UPDATE holdings SET shares = shares - ? WHERE owner_user_id = ? AND stock_user_id = ?`,
      input.shares,
      input.sellerUserId,
      input.targetUserId
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM holdings WHERE owner_user_id = ? AND stock_user_id = ? AND shares <= 0`,
      input.sellerUserId,
      input.targetUserId
    );
    this.ctx.storage.sql.exec(`UPDATE players SET cash = cash + ?, updated_at = datetime('now') WHERE user_id = ?`, proceeds, input.sellerUserId);

    return { ok: true, shares: input.shares, price: target.price, total: proceeds, totalShares: holding.shares - input.shares };
  }

  async applyWeeklyAllowance(): Promise<void> {
    this.ctx.storage.sql.exec(`UPDATE players SET cash = cash + ?, updated_at = datetime('now')`, WEEKLY_ALLOWANCE);
  }

  async applyDailyDecay(): Promise<void> {
    const players = this.ctx.storage.sql.exec<PlayerRow>(`SELECT * FROM players`).toArray();
    if (players.length === 0) {
      return;
    }

    const average = players.reduce((sum, p) => sum + p.price, 0) / players.length;

    for (const player of players) {
      const hadActivityToday = this.ctx.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) as count FROM price_events
           WHERE user_id = ? AND reason != 'decay' AND created_at >= datetime('now', 'start of day')`,
          player.user_id
        )
        .one().count;
      if (hadActivityToday > 0) {
        continue;
      }

      const delta = (average - player.price) * DAILY_DECAY_GRAVITY;
      if (Math.abs(delta) < 0.01) {
        continue;
      }
      this.applyPriceChange(player.user_id, delta, "decay", null);
    }
  }

  async purgeOldData(): Promise<void> {
    this.ctx.storage.sql.exec(`DELETE FROM message_authors WHERE created_at < datetime('now', '-${MESSAGE_AUTHOR_RETENTION_DAYS} days')`);
    this.ctx.storage.sql.exec(`DELETE FROM price_events WHERE created_at < datetime('now', '-${PRICE_EVENT_RETENTION_DAYS} days')`);
  }

  private upsertPlayer(input: { userId: number; username?: string; firstName: string }): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO players (user_id, username, first_name) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name, updated_at = datetime('now')`,
      input.userId,
      input.username ?? null,
      input.firstName
    );
  }

  private applyPriceChange(userId: number, delta: number, reason: "message" | "reply" | "reaction" | "decay", counterpartyUserId: number | null): void {
    this.ctx.storage.sql.exec(`UPDATE players SET price = MAX(0, price + ?), updated_at = datetime('now') WHERE user_id = ?`, delta, userId);
    this.ctx.storage.sql.exec(
      `INSERT INTO price_events (user_id, counterparty_user_id, reason, delta) VALUES (?, ?, ?, ?)`,
      userId,
      counterpartyUserId,
      reason,
      delta
    );
  }
}
