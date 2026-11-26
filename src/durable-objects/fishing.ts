import { DurableObject } from "cloudflare:workers";
import type { Env } from "../main.js";
import { easternParts } from "../eastern-time.js";
import {
  FISHING_CONFIG,
  castFactors,
  fishingDay,
  hintFor,
  lakeTier,
  rollTrash,
  rollWeight,
  speciesForWeight,
  tideFor,
  type CastGear,
  type CatchHint,
  type LakeTier,
} from "../fishing-math.js";

export interface FishingCatch {
  species: string;
  emoji: string;
  weight: number;
}

// Every cast also reports:
//   highTide: today's tide in this chat is high or king (see tideFor) — reported as just "high tide", so a
//             king tide stays a surprise.
//   lake:     how busy the lake was when this cast went in (see lakeTier).
//   hint:     on a poor catch, what dragged it down most, if anything worth naming (see hintFor).
//   date / castsToday: the Eastern date and how many casts the chat made before this one, so the reply's
//             flavor lines can rotate (see rotatingLine).
type CastReport = { highTide: boolean; lake: LakeTier; hint: CatchHint | null; date: string; castsToday: number };

export type FishingCastResult =
  | { ok: false; type: "ALREADY_FISHED" }
  // Junk instead of a fish (see rollTrash): not recorded anywhere, but the cast is still used up.
  | ({ ok: true; kind: "trash"; item: string; emoji: string } & CastReport)
  | ({
      ok: true;
      kind: "fish";
      catch: FishingCatch;
      catchId: number; // for the store's Sell button on the reply
      // All three are judged within the current leaderboard (window + last reset), same as /fishing.
      // previousBest is null when this is the angler's first catch on the current leaderboard.
      previousBest: number | null;
      chatRecord: boolean;
      rank: number;
    } & CastReport);

// Which of an angler's held fish to take: their lightest, their heaviest, or the one in the middle. Relative
// to their own bucket, so nobody has to see what's in it.
export type FishSize = "small" | "medium" | "large";
// What takeFish can be asked for: a size, or any fish at all (the store's Sell button).
export type FishPick = FishSize | "random";

export interface HeldFish extends FishingCatch {
  id: number;
}

// What takeFish / takeFishById marks a fish as: eaten by the pet, or sold at the store.
export type FishUse = "eaten" | "sold";

// A fish still in its catcher's bucket, and how long it's been there (for the store's freshness hints).
export interface BucketFish extends FishingCatch {
  daysHeld: number;
}

export type TakeFishByIdResult = { ok: true; fish: HeldFish } | { ok: false; reason: "NOT_YOURS" | "GONE" };

export interface FishingLeaderboardEntry extends FishingCatch {
  userId: number;
  firstName: string;
}

export interface FishingLeaderboard {
  entries: FishingLeaderboardEntry[];
  windowDays: number | null; // null = forever
}

type LeaderboardRow = {
  [column: string]: SqlStorageValue;
  user_id: number;
  first_name: string;
  species: string;
  emoji: string;
  weight: number;
};

// One per chat (idFromName(`fishing_${chatId}`)). Every catch is kept, not just each angler's best, so
// changing the leaderboard window applies retroactively in both directions — and every catch is also an
// item in its owner's bucket (see the version 2 migration), which the leaderboard ignores. /resetfishing is a soft reset:
// it records the newest catch id at reset time, and the leaderboard only counts catches after it — so it
// never deletes anything, and catches made in the same second as the reset can't land on the wrong side.
export class Fishing extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.migrate();
  }

  // Same _schema_migrations approach as the Pet DO: CREATE TABLE IF NOT EXISTS is a no-op against an
  // already-existing table, so later columns need real migrations. Version 1 is the original schema, which
  // every chat that has fished already has.
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
        CREATE TABLE IF NOT EXISTS anglers (
          user_id INTEGER PRIMARY KEY,
          username TEXT,
          first_name TEXT NOT NULL,
          last_cast_date TEXT NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS catches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES anglers(user_id),
          species TEXT NOT NULL,
          emoji TEXT NOT NULL,
          weight REAL NOT NULL,
          caught_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_catches_user_weight ON catches(user_id, weight)`);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          id INTEGER PRIMARY KEY,
          window_days INTEGER,
          reset_after_catch_id INTEGER NOT NULL DEFAULT 0
        )
      `);
      this.ctx.storage.sql.exec(`INSERT INTO settings (id) VALUES (1) ON CONFLICT(id) DO NOTHING`);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (1)`);
    }

    if (version < 2) {
      // Every catch becomes an inventory item. user_id stays "who caught it" forever, so the leaderboard
      // never changes when a fish is eaten, gifted, or sold; owner_id is who holds it now, and status says
      // whether it's still in their bucket. Everything caught before this goes into its catcher's bucket.
      // The cast context columns are for tuning (and maybe a future sell price); NULL on older catches.
      this.ctx.storage.sql.exec(`ALTER TABLE catches ADD COLUMN owner_id INTEGER`);
      this.ctx.storage.sql.exec(`ALTER TABLE catches ADD COLUMN status TEXT NOT NULL DEFAULT 'held'`); // 'held' | 'eaten' | 'sold'
      this.ctx.storage.sql.exec(`ALTER TABLE catches ADD COLUMN used_at TEXT`);
      this.ctx.storage.sql.exec(`ALTER TABLE catches ADD COLUMN used_for TEXT`); // e.g. 'pet:3'
      this.ctx.storage.sql.exec(`ALTER TABLE catches ADD COLUMN quality REAL`);
      this.ctx.storage.sql.exec(`ALTER TABLE catches ADD COLUMN tide TEXT`);
      this.ctx.storage.sql.exec(`ALTER TABLE catches ADD COLUMN days_waited INTEGER`);
      this.ctx.storage.sql.exec(`ALTER TABLE catches ADD COLUMN lake_casts INTEGER`);
      this.ctx.storage.sql.exec(`UPDATE catches SET owner_id = user_id`);
      this.ctx.storage.sql.exec(`CREATE INDEX idx_catches_owner ON catches(owner_id, status, weight)`);
      // The lake: how many casts the whole chat has made each Eastern day. A new day is just a new row.
      // Seeded with today's casts so far (one per angler who's cast today), so a deploy mid-day doesn't
      // hand out first-cast bonuses to people casting after it.
      this.ctx.storage.sql.exec(`
        CREATE TABLE lake_days (
          date TEXT PRIMARY KEY,
          casts INTEGER NOT NULL
        )
      `);
      const today = fishingDay(easternParts(new Date())).date;
      this.ctx.storage.sql.exec(
        `INSERT INTO lake_days (date, casts) SELECT ?, COUNT(*) FROM anglers WHERE last_cast_date = ?`,
        today,
        today
      );
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (2)`);
    }
  }

  // One cast per fishing day (starting DAY_STARTS_HOUR_ET, not midnight). Days waited since the angler's last
  // cast, today's tide, and how many casts the chat has already made today set the cast's quality (see
  // fishing-math.ts); a first-ever cast counts as FIRST_CAST_WAIT_DAYS. No await anywhere in here, so two
  // /fish sent at once can't both get through, or both see the same lake count.
  // gear: what the angler's store gear does to this cast (see gear.ts); none when the store is off.
  async cast(input: { chatId: number; userId: number; username?: string; firstName: string; gear?: CastGear }): Promise<FishingCastResult> {
    const { date: today, dayNumber } = fishingDay(easternParts(new Date()));
    // Without the secret, tides just stay normal rather than becoming predictable from the source code.
    const tide = this.env.TIDE_SECRET ? tideFor(this.env.TIDE_SECRET, input.chatId, dayNumber) : "normal";
    const highTide = tide === "high" || tide === "king";

    const angler = this.ctx.storage.sql
      .exec<{ last_cast_date: string }>(`SELECT last_cast_date FROM anglers WHERE user_id = ?`, input.userId)
      .toArray()[0];
    // >= rather than ===: a cast made between midnight and the day's start, before the start moved off
    // midnight, is stamped with what is now tomorrow's date.
    if (angler && angler.last_cast_date >= today) {
      return { ok: false, type: "ALREADY_FISHED" };
    }
    const daysWaited = angler ? daysBetween(angler.last_cast_date, today) : FISHING_CONFIG.FIRST_CAST_WAIT_DAYS;
    const castsToday =
      this.ctx.storage.sql.exec<{ casts: number }>(`SELECT casts FROM lake_days WHERE date = ?`, today).toArray()[0]?.casts ?? 0;

    this.ctx.storage.sql.exec(
      `INSERT INTO anglers (user_id, username, first_name, last_cast_date) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name, last_cast_date = excluded.last_cast_date`,
      input.userId,
      input.username ?? null,
      input.firstName,
      today
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO lake_days (date, casts) VALUES (?, 1) ON CONFLICT(date) DO UPDATE SET casts = casts + 1`,
      today
    );

    const factors = castFactors({ daysWaited, tide, castsToday, ...(input.gear && { gear: input.gear }) });
    const lake = lakeTier(castsToday);
    const trash = rollTrash(factors.quality, input.gear?.junk);
    if (trash) {
      return { ok: true, kind: "trash", ...trash, highTide, lake, hint: hintFor(factors), date: today, castsToday };
    }

    const weight = rollWeight(factors.quality);
    const { species, emoji } = speciesForWeight(weight);

    // Judged against the leaderboard as it stood before this catch.
    const { afterId, since } = this.leaderboardScope();
    const previousBest = this.ctx.storage.sql
      .exec<{ best: number | null }>(
        `SELECT MAX(weight) as best FROM catches WHERE user_id = ? AND id > ? AND caught_at >= ?`,
        input.userId,
        afterId,
        since
      )
      .one().best;
    const previousRecord = this.ctx.storage.sql
      .exec<{ best: number | null }>(`SELECT MAX(weight) as best FROM catches WHERE id > ? AND caught_at >= ?`, afterId, since)
      .one().best;

    const catchId = this.ctx.storage.sql
      .exec<{ id: number }>(
        `INSERT INTO catches (user_id, owner_id, species, emoji, weight, quality, tide, days_waited, lake_casts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
        input.userId,
        input.userId,
        species,
        emoji,
        weight,
        factors.quality,
        tide,
        daysWaited,
        castsToday
      )
      .one().id;

    const rank = this.leaderboardRows().findIndex((row) => row.user_id === input.userId) + 1;
    return {
      ok: true,
      kind: "fish",
      highTide,
      lake,
      hint: weight < FISHING_CONFIG.POOR_CATCH_LB ? hintFor(factors) : null,
      date: today,
      castsToday,
      catch: { species, emoji, weight },
      catchId,
      previousBest,
      chatRecord: weight > (previousRecord ?? 0),
      rank,
    };
  }

  async getLeaderboard(): Promise<FishingLeaderboard> {
    return {
      entries: this.leaderboardRows().map((row) => ({
        userId: row.user_id,
        firstName: row.first_name,
        species: row.species,
        emoji: row.emoji,
        weight: row.weight,
      })),
      windowDays: this.settings().window_days,
    };
  }

  // Takes one of the angler's held fish out of their bucket (marks it eaten or sold, with usedFor saying
  // what for, e.g. "pet:3"), or null if their bucket is empty. Single-statement reads and writes with no
  // await, so two taps at once each get a different fish.
  async takeFish(userId: number, size: FishPick, usedFor: string, use: FishUse = "eaten"): Promise<HeldFish | null> {
    const held = this.ctx.storage.sql
      .exec<{ count: number }>(`SELECT COUNT(*) as count FROM catches WHERE owner_id = ? AND status = 'held'`, userId)
      .one().count;
    if (held === 0) {
      return null;
    }
    const offset =
      size === "random"
        ? Math.floor(Math.random() * held)
        : size === "small"
          ? 0
          : size === "large"
            ? held - 1
            : Math.floor((held - 1) / 2);
    const fish = this.ctx.storage.sql
      .exec<{ id: number; species: string; emoji: string; weight: number }>(
        `SELECT id, species, emoji, weight FROM catches WHERE owner_id = ? AND status = 'held'
         ORDER BY weight ASC, id ASC LIMIT 1 OFFSET ?`,
        userId,
        offset
      )
      .one();
    this.ctx.storage.sql.exec(
      `UPDATE catches SET status = ?, used_at = datetime('now'), used_for = ? WHERE id = ?`,
      use,
      usedFor,
      fish.id
    );
    return fish;
  }

  // One specific fish (the one a /fish reply's Sell button is for), if it's still in this angler's bucket.
  async takeFishById(userId: number, id: number, usedFor: string, use: FishUse): Promise<TakeFishByIdResult> {
    const fish = this.ctx.storage.sql
      .exec<{ id: number; species: string; emoji: string; weight: number; owner_id: number; status: string }>(
        `SELECT id, species, emoji, weight, owner_id, status FROM catches WHERE id = ?`,
        id
      )
      .toArray()[0];
    if (!fish || fish.owner_id !== userId) {
      return { ok: false, reason: "NOT_YOURS" };
    }
    if (fish.status !== "held") {
      return { ok: false, reason: "GONE" };
    }
    this.ctx.storage.sql.exec(
      `UPDATE catches SET status = ?, used_at = datetime('now'), used_for = ? WHERE id = ?`,
      use,
      usedFor,
      id
    );
    return { ok: true, fish: { id: fish.id, species: fish.species, emoji: fish.emoji, weight: fish.weight } };
  }

  // Puts a fish taken by takeFish / takeFishById back, when whatever it was for didn't happen (e.g. the pet
  // was on cooldown, or the store's write failed).
  async returnFish(id: number): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE catches SET status = 'held', used_at = NULL, used_for = NULL WHERE id = ? AND status IN ('eaten', 'sold')`,
      id
    );
  }

  // Everything in this angler's bucket, for the store's private Wallet pop-up.
  async bucket(userId: number): Promise<BucketFish[]> {
    return this.ctx.storage.sql
      .exec<{ species: string; emoji: string; weight: number; days_held: number }>(
        `SELECT species, emoji, weight, julianday('now') - julianday(caught_at) AS days_held
         FROM catches WHERE owner_id = ? AND status = 'held'`,
        userId
      )
      .toArray()
      .map((row) => ({ species: row.species, emoji: row.emoji, weight: row.weight, daysHeld: row.days_held }));
  }

  async setWindow(days: number | null): Promise<void> {
    this.ctx.storage.sql.exec(`UPDATE settings SET window_days = ? WHERE id = 1`, days);
  }

  async reset(): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE settings SET reset_after_catch_id = (SELECT COALESCE(MAX(id), 0) FROM catches) WHERE id = 1`
    );
  }

  // Each angler's single best catch on the current leaderboard, ranked by weight; ties go to whoever
  // caught theirs first (lower id).
  private leaderboardRows(): LeaderboardRow[] {
    const { afterId, since } = this.leaderboardScope();
    return this.ctx.storage.sql
      .exec<LeaderboardRow>(
        `SELECT c.user_id, a.first_name, c.species, c.emoji, c.weight
         FROM catches c JOIN anglers a ON a.user_id = c.user_id
         WHERE c.id = (
           SELECT c2.id FROM catches c2
           WHERE c2.user_id = c.user_id AND c2.id > ? AND c2.caught_at >= ?
           ORDER BY c2.weight DESC, c2.id ASC
           LIMIT 1
         )
         ORDER BY c.weight DESC, c.id ASC`,
        afterId,
        since
      )
      .toArray();
  }

  // Which catches count right now: after the last reset, and inside the window. since is a SQLite
  // datetime string ("" when the window is forever — sorts before every real timestamp).
  private leaderboardScope(): { afterId: number; since: string } {
    const settings = this.settings();
    const since =
      settings.window_days === null
        ? ""
        : this.ctx.storage.sql
            .exec<{ since: string }>(`SELECT datetime('now', ?) as since`, `-${settings.window_days} days`)
            .one().since;
    return { afterId: settings.reset_after_catch_id, since };
  }

  private settings() {
    return this.ctx.storage.sql
      .exec<{ window_days: number | null; reset_after_catch_id: number }>(
        `SELECT window_days, reset_after_catch_id FROM settings WHERE id = 1`
      )
      .one();
  }
}

// Whole calendar days between two "YYYY-MM-DD" dates.
function daysBetween(from: string, to: string): number {
  const toUtc = (date: string) => {
    const [year, month, day] = date.split("-").map(Number);
    return Date.UTC(year!, month! - 1, day!);
  };
  return Math.round((toUtc(to) - toUtc(from)) / (24 * 60 * 60 * 1000));
}
