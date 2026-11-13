import { DurableObject } from "cloudflare:workers";
import type { Env } from "../main.js";
import { easternParts } from "../eastern-time.js";
import {
  FIRST_CAST_WAIT_DAYS,
  OVERFISHED_WITHIN_DAYS,
  rollsForWait,
  rollTrash,
  rollWeight,
  speciesForWeight,
  tideFor,
  tideMultiplier,
} from "../fishing-math.js";

export interface FishingCatch {
  species: string;
  emoji: string;
  weight: number;
}

// highTide: today's tide in this chat is high or king (see tideFor) — reported as just "high tide", so a
// king tide stays a surprise.
export type FishingCastResult =
  | { ok: false; type: "ALREADY_FISHED" }
  // Junk instead of a fish (see rollTrash): not recorded anywhere, but the cast is still used up.
  // overfished: caught within OVERFISHED_WITHIN_DAYS of the angler's last cast.
  | { ok: true; kind: "trash"; item: string; emoji: string; overfished: boolean; highTide: boolean }
  | {
      ok: true;
      kind: "fish";
      highTide: boolean;
      catch: FishingCatch;
      // All three are judged within the current leaderboard (window + last reset), same as /fishing.
      // previousBest is null when this is the angler's first catch on the current leaderboard.
      previousBest: number | null;
      chatRecord: boolean;
      rank: number;
    };

export interface FishingLeaderboardEntry extends FishingCatch {
  userId: number;
  firstName: string;
}

export interface FishingLeaderboard {
  entries: FishingLeaderboardEntry[];
  windowDays: number | null; // null = forever
}

// Eastern date tides take effect (see cast). "YYYY-MM-DD" compares correctly as a plain string.
const TIDES_START_DATE = "2026-11-14";

type LeaderboardRow = {
  [column: string]: SqlStorageValue;
  user_id: number;
  first_name: string;
  species: string;
  emoji: string;
  weight: number;
};

// One per chat (idFromName(`fishing_${chatId}`)). Every catch is kept, not just each angler's best, so
// changing the leaderboard window applies retroactively in both directions. /resetfishing is a soft reset:
// it records the newest catch id at reset time, and the leaderboard only counts catches after it — so it
// never deletes anything, and catches made in the same second as the reset can't land on the wrong side.
export class Fishing extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
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
  }

  // One cast per Eastern calendar day (midnight ET, same as Wordle). Days waited since the last cast feed
  // the roll and the junk chance (see fishing-math.ts); a first-ever cast counts as FIRST_CAST_WAIT_DAYS,
  // a medium start. No await between the "already fished today?" check and the write, so two /fish sent
  // at once can't both get through.
  async cast(input: { chatId: number; userId: number; username?: string; firstName: string }): Promise<FishingCastResult> {
    const p = easternParts(new Date());
    const today = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
    // Without the secret, tides just stay normal rather than becoming predictable from the source code.
    // Same before TIDES_START_DATE, so nobody fishing on the day tides shipped got a different tide from
    // the people who'd already fished that day.
    const tide =
      this.env.TIDE_SECRET && today >= TIDES_START_DATE
        ? tideFor(this.env.TIDE_SECRET, input.chatId, Date.UTC(p.year, p.month - 1, p.day) / 86_400_000)
        : "normal";
    const highTide = tide === "high" || tide === "king";

    const angler = this.ctx.storage.sql
      .exec<{ last_cast_date: string }>(`SELECT last_cast_date FROM anglers WHERE user_id = ?`, input.userId)
      .toArray()[0];
    if (angler?.last_cast_date === today) {
      return { ok: false, type: "ALREADY_FISHED" };
    }
    const daysWaited = angler ? daysBetween(angler.last_cast_date, today) : FIRST_CAST_WAIT_DAYS;

    this.ctx.storage.sql.exec(
      `INSERT INTO anglers (user_id, username, first_name, last_cast_date) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name, last_cast_date = excluded.last_cast_date`,
      input.userId,
      input.username ?? null,
      input.firstName,
      today
    );

    const trash = rollTrash(daysWaited);
    if (trash) {
      return { ok: true, kind: "trash", ...trash, overfished: daysWaited <= OVERFISHED_WITHIN_DAYS, highTide };
    }

    const weight = rollWeight(rollsForWait(daysWaited) * tideMultiplier(tide));
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

    this.ctx.storage.sql.exec(
      `INSERT INTO catches (user_id, species, emoji, weight) VALUES (?, ?, ?, ?)`,
      input.userId,
      species,
      emoji,
      weight
    );

    const rank = this.leaderboardRows().findIndex((row) => row.user_id === input.userId) + 1;
    return {
      ok: true,
      kind: "fish",
      highTide,
      catch: { species, emoji, weight },
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
