import { DurableObject } from "cloudflare:workers";
import type { Env } from "../main.js";
import { PET_CONFIG, type PetRarity } from "../pet-config.js";
import { advanceMeters, petFate, type PetMeters } from "../pet-math.js";

export type PetDeathCause = "starved" | "ran_away" | "put_down";

export interface PetStatus {
  id: number;
  name: string;
  species: string;
  emoji: string;
  rarity: PetRarity;
  adoptedByName: string;
  adoptedAt: number; // epoch seconds
  food: number;
  mood: number;
  threadId: number | null;
}

export interface PetEulogy {
  name: string;
  species: string;
  emoji: string;
  adoptedAt: number;
  diedAt: number;
  cause: PetDeathCause;
  threadId: number | null;
  lastFedBy: string | null;
  lastFedAt: number | null;
  lastPettedBy: string | null;
  lastPettedAt: number | null;
  onlyPetted: string[]; // petted it, never fed it
  onlyFed: string[]; // fed it, never petted it
}

export type PetWarning = { type: "hungry" } | { type: "starving" } | { type: "dying"; hoursLeft: number } | { type: "miserable" };

// Anything that settles the pet can discover it died since the last look (the meters are lazy — see
// pet-math.ts). That call returns the eulogy exactly once, and whoever made it posts it.
export type PetLookup = { pet: PetStatus | null; eulogy?: PetEulogy };

export type PetAdoptResult = { ok: true; pet: PetStatus; eulogy?: PetEulogy } | { ok: false; type: "ALREADY_HAS_PET"; pet: PetStatus };

export type PetInteractResult =
  | { result: "OK" | "OVERFED"; pet: PetStatus }
  | { result: "COOLDOWN"; pet: PetStatus; retryInSeconds: number }
  | { result: "GONE"; eulogy: PetEulogy } // died right before this tap
  | { result: "STALE" }; // button from a card for a pet that's no longer around

export interface PetGraveyardEntry {
  name: string;
  species: string;
  emoji: string;
  adoptedAt: number;
  diedAt: number;
  cause: PetDeathCause;
}

type PetRow = {
  [column: string]: SqlStorageValue;
  id: number;
  name: string;
  species: string;
  emoji: string;
  rarity: PetRarity;
  adopted_by_id: number;
  adopted_by_name: string;
  adopted_at: number;
  thread_id: number | null;
  food: number;
  mood: number;
  updated_at: number;
  food_empty_since: number | null;
  mood_empty_since: number | null;
  frozen_at: number | null;
  warn_level: number;
  mood_warned: number;
  last_fed_by: string | null;
  last_fed_at: number | null;
  last_petted_by: string | null;
  last_petted_at: number | null;
  died_at: number | null;
  cause: PetDeathCause | null;
};

// Warning levels, in order of urgency. warn_level remembers the highest one already posted for the
// current hunger spell, so each posts once; feeding resets it.
const WARN_NONE = 0;
const WARN_HUNGRY = 1;
const WARN_STARVING = 2;
const WARN_DYING = 3;

const nowSec = () => Math.floor(Date.now() / 1000);

// One per chat (idFromName(`pet_${chatId}`)): the living pet (at most one — rows with died_at NULL),
// every past pet for /graveyard, and per-person caretaking history for cooldowns and eulogy blame.
export class Pet extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        species TEXT NOT NULL,
        emoji TEXT NOT NULL,
        rarity TEXT NOT NULL,
        adopted_by_id INTEGER NOT NULL,
        adopted_by_name TEXT NOT NULL,
        adopted_at INTEGER NOT NULL,
        thread_id INTEGER,
        food REAL NOT NULL,
        mood REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        food_empty_since INTEGER,
        mood_empty_since INTEGER,
        frozen_at INTEGER,
        warn_level INTEGER NOT NULL DEFAULT 0,
        mood_warned INTEGER NOT NULL DEFAULT 0,
        last_fed_by TEXT,
        last_fed_at INTEGER,
        last_petted_by TEXT,
        last_petted_at INTEGER,
        died_at INTEGER,
        cause TEXT
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS caretakers (
        pet_id INTEGER NOT NULL REFERENCES pets(id),
        user_id INTEGER NOT NULL,
        first_name TEXT NOT NULL,
        feeds INTEGER NOT NULL DEFAULT 0,
        pets INTEGER NOT NULL DEFAULT 0,
        last_fed_at INTEGER,
        last_petted_at INTEGER,
        PRIMARY KEY (pet_id, user_id)
      )
    `);
  }

  async lookup(): Promise<PetLookup> {
    const { row, eulogy } = this.settle(nowSec());
    return { pet: row ? toStatus(row) : null, ...(eulogy && { eulogy }) };
  }

  // Fails if a living pet already exists — two people finishing /adopt at once can't both get one.
  async adopt(input: {
    name: string;
    species: string;
    emoji: string;
    rarity: PetRarity;
    adoptedById: number;
    adoptedByName: string;
    threadId: number | null;
  }): Promise<PetAdoptResult> {
    const now = nowSec();
    const { row, eulogy } = this.settle(now);
    if (row) {
      return { ok: false, type: "ALREADY_HAS_PET", pet: toStatus(row) };
    }

    const inserted = this.ctx.storage.sql
      .exec<PetRow>(
        `INSERT INTO pets (name, species, emoji, rarity, adopted_by_id, adopted_by_name, adopted_at, thread_id, food, mood, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 100, 100, ?)
         RETURNING *`,
        input.name,
        input.species,
        input.emoji,
        input.rarity,
        input.adoptedById,
        input.adoptedByName,
        now,
        input.threadId,
        now
      )
      .one();
    return { ok: true, pet: toStatus(inserted), ...(eulogy && { eulogy }) };
  }

  async interact(input: { petId: number; action: "feed" | "pet"; userId: number; firstName: string }): Promise<PetInteractResult> {
    const now = nowSec();
    const { row, eulogy } = this.settle(now);
    if (eulogy) {
      return { result: "GONE", eulogy };
    }
    if (!row || row.id !== input.petId) {
      return { result: "STALE" };
    }

    const caretaker = this.ctx.storage.sql
      .exec<{ last_fed_at: number | null; last_petted_at: number | null }>(
        `SELECT last_fed_at, last_petted_at FROM caretakers WHERE pet_id = ? AND user_id = ?`,
        row.id,
        input.userId
      )
      .toArray()[0];
    const last = input.action === "feed" ? caretaker?.last_fed_at : caretaker?.last_petted_at;
    const cooldownHours = input.action === "feed" ? PET_CONFIG.FEED_COOLDOWN_HOURS : PET_CONFIG.PET_COOLDOWN_HOURS;
    if (last != null && now - last < cooldownHours * 3600) {
      return { result: "COOLDOWN", pet: toStatus(row), retryInSeconds: last + cooldownHours * 3600 - now };
    }

    let food = row.food;
    let mood = row.mood;
    let overfed = false;
    if (input.action === "feed") {
      if (food >= PET_CONFIG.OVERFED_AT) {
        overfed = true;
        mood = Math.max(0, mood - PET_CONFIG.OVERFED_MOOD_PENALTY);
      } else {
        food = Math.min(100, food + PET_CONFIG.FEED_AMOUNT);
      }
    } else {
      mood = Math.min(100, mood + PET_CONFIG.PET_AMOUNT);
    }

    const fed = input.action === "feed";
    const updated = this.ctx.storage.sql
      .exec<PetRow>(
        `UPDATE pets SET food = ?, mood = ?, updated_at = ?, food_empty_since = ?, mood_empty_since = ?, warn_level = ?,
           mood_warned = ?, last_fed_by = ?, last_fed_at = ?, last_petted_by = ?, last_petted_at = ?
         WHERE id = ?
         RETURNING *`,
        food,
        mood,
        now,
        food > 0 ? null : (row.food_empty_since ?? now),
        mood > 0 ? null : (row.mood_empty_since ?? now),
        // A feed resets the warnings to wherever food now sits, so the next hunger spell warns again.
        fed ? warnLevelFor(food) : row.warn_level,
        mood > PET_CONFIG.MISERABLE_WARNING_AT ? 0 : row.mood_warned,
        fed ? input.firstName : row.last_fed_by,
        fed ? now : row.last_fed_at,
        fed ? row.last_petted_by : input.firstName,
        fed ? row.last_petted_at : now,
        row.id
      )
      .one();

    this.ctx.storage.sql.exec(
      `INSERT INTO caretakers (pet_id, user_id, first_name, feeds, pets, last_fed_at, last_petted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pet_id, user_id) DO UPDATE SET
         first_name = excluded.first_name,
         feeds = feeds + excluded.feeds,
         pets = pets + excluded.pets,
         last_fed_at = COALESCE(excluded.last_fed_at, last_fed_at),
         last_petted_at = COALESCE(excluded.last_petted_at, last_petted_at)`,
      row.id,
      input.userId,
      input.firstName,
      fed ? 1 : 0,
      fed ? 0 : 1,
      fed ? now : null,
      fed ? null : now
    );

    return { result: overfed ? "OVERFED" : "OK", pet: toStatus(updated) };
  }

  // The hourly check (see PetComposer.runHourlyCheck). Settles the pet — which is where deaths get
  // noticed if nobody's looked in a while — and returns any warnings that are newly due. awake is
  // whether warnings may post right now; one that comes due overnight just waits for the morning.
  async tick(awake: boolean): Promise<{ pet: PetStatus | null; eulogy?: PetEulogy; warnings: PetWarning[] }> {
    const now = nowSec();
    const { row, eulogy } = this.settle(now);
    if (!row) {
      return { pet: null, ...(eulogy && { eulogy }), warnings: [] };
    }

    const warnings: PetWarning[] = [];
    let warnLevel = row.warn_level;
    let moodWarned = row.mood_warned;
    if (awake) {
      const level = warnLevelFor(row.food);
      if (level > warnLevel) {
        if (level === WARN_DYING) {
          const starveAt = (row.food_empty_since ?? now) + PET_CONFIG.STARVE_AFTER_EMPTY_HOURS * 3600;
          warnings.push({ type: "dying", hoursLeft: Math.max(1, Math.round((starveAt - now) / 3600)) });
        } else {
          warnings.push({ type: level === WARN_STARVING ? "starving" : "hungry" });
        }
        warnLevel = level;
      }
      if (row.mood <= PET_CONFIG.MISERABLE_WARNING_AT && !moodWarned) {
        warnings.push({ type: "miserable" });
        moodWarned = 1;
      }
    }
    if (warnLevel !== row.warn_level || moodWarned !== row.mood_warned) {
      this.ctx.storage.sql.exec(`UPDATE pets SET warn_level = ?, mood_warned = ? WHERE id = ?`, warnLevel, moodWarned, row.id);
    }
    return { pet: toStatus(row), warnings };
  }

  // Called by the hourly check while the "pet" feature is switched off in this chat: stops the clock, so
  // switching a feature off never quietly kills anything. The next settle (with the feature back on)
  // shifts every timestamp forward by however long it was frozen. Hourly granularity means up to an hour
  // of decay can slip in around the switch — not worth more machinery.
  async freeze(): Promise<void> {
    this.ctx.storage.sql.exec(`UPDATE pets SET frozen_at = ? WHERE died_at IS NULL AND frozen_at IS NULL`, nowSec());
  }

  async graveyard(limit: number): Promise<PetGraveyardEntry[]> {
    this.settle(nowSec());
    return this.ctx.storage.sql
      .exec<PetRow>(`SELECT * FROM pets WHERE died_at IS NOT NULL ORDER BY died_at DESC LIMIT ?`, limit)
      .toArray()
      .map((row) => ({
        name: row.name,
        species: row.species,
        emoji: row.emoji,
        adoptedAt: row.adopted_at,
        diedAt: row.died_at!,
        cause: row.cause!,
      }));
  }

  // Owner-only (see PetComposer): mercy, or testing.
  async kill(): Promise<PetLookup> {
    const now = nowSec();
    const { row, eulogy } = this.settle(now);
    if (eulogy || !row) {
      return { pet: null, ...(eulogy && { eulogy }) };
    }
    this.ctx.storage.sql.exec(`UPDATE pets SET died_at = ?, cause = 'put_down' WHERE id = ?`, now, row.id);
    return { pet: null, eulogy: this.eulogy(row.id) };
  }

  // Owner-only: brings the most recent dead pet back at full meters, in case a bug killed it. No-op if a
  // pet is alive.
  async revive(): Promise<PetStatus | null> {
    const now = nowSec();
    if (this.settle(now).row) {
      return null;
    }
    const revived = this.ctx.storage.sql
      .exec<PetRow>(
        `UPDATE pets SET died_at = NULL, cause = NULL, food = 100, mood = 100, updated_at = ?, food_empty_since = NULL,
           mood_empty_since = NULL, frozen_at = NULL, warn_level = 0, mood_warned = 0
         WHERE id = (SELECT id FROM pets WHERE died_at IS NOT NULL ORDER BY died_at DESC LIMIT 1)
         RETURNING *`,
        now
      )
      .toArray()[0];
    return revived ? toStatus(revived) : null;
  }

  // Brings the living pet's meters up to `now`, thawing it first if the hourly check froze it. If it
  // died in the meantime, records that (at the moment it actually happened, not now) and returns the
  // eulogy — this is the only place a pet dies on its own.
  private settle(now: number): { row: PetRow | null; eulogy?: PetEulogy } {
    let row = this.ctx.storage.sql.exec<PetRow>(`SELECT * FROM pets WHERE died_at IS NULL LIMIT 1`).toArray()[0];
    if (!row) {
      return { row: null };
    }

    if (row.frozen_at !== null) {
      const shift = now - row.frozen_at;
      row = {
        ...row,
        updated_at: row.updated_at + shift,
        food_empty_since: row.food_empty_since !== null ? row.food_empty_since + shift : null,
        mood_empty_since: row.mood_empty_since !== null ? row.mood_empty_since + shift : null,
        frozen_at: null,
      };
    }

    const meters: PetMeters = advanceMeters(
      { food: row.food, mood: row.mood, at: row.updated_at, foodEmptySince: row.food_empty_since, moodEmptySince: row.mood_empty_since },
      now
    );
    const fate = petFate(meters);

    this.ctx.storage.sql.exec(
      `UPDATE pets SET food = ?, mood = ?, updated_at = ?, food_empty_since = ?, mood_empty_since = ?, frozen_at = NULL,
         died_at = ?, cause = ?
       WHERE id = ?`,
      meters.food,
      meters.mood,
      meters.at,
      meters.foodEmptySince,
      meters.moodEmptySince,
      fate?.at ?? null,
      fate?.cause ?? null,
      row.id
    );

    if (fate) {
      return { row: null, eulogy: this.eulogy(row.id) };
    }
    return {
      row: {
        ...row,
        food: meters.food,
        mood: meters.mood,
        updated_at: meters.at,
        food_empty_since: meters.foodEmptySince,
        mood_empty_since: meters.moodEmptySince,
      },
    };
  }

  private eulogy(petId: number): PetEulogy {
    const row = this.ctx.storage.sql.exec<PetRow>(`SELECT * FROM pets WHERE id = ?`, petId).one();
    const caretakers = this.ctx.storage.sql
      .exec<{ first_name: string; feeds: number; pets: number }>(`SELECT first_name, feeds, pets FROM caretakers WHERE pet_id = ?`, petId)
      .toArray();
    return {
      name: row.name,
      species: row.species,
      emoji: row.emoji,
      adoptedAt: row.adopted_at,
      diedAt: row.died_at!,
      cause: row.cause!,
      threadId: row.thread_id,
      lastFedBy: row.last_fed_by,
      lastFedAt: row.last_fed_at,
      lastPettedBy: row.last_petted_by,
      lastPettedAt: row.last_petted_at,
      onlyPetted: caretakers.filter((c) => c.feeds === 0 && c.pets > 0).map((c) => c.first_name),
      onlyFed: caretakers.filter((c) => c.pets === 0 && c.feeds > 0).map((c) => c.first_name),
    };
  }
}

function warnLevelFor(food: number): number {
  if (food <= 0) {
    return WARN_DYING;
  }
  if (food <= PET_CONFIG.STARVING_WARNING_AT) {
    return WARN_STARVING;
  }
  if (food <= PET_CONFIG.HUNGRY_WARNING_AT) {
    return WARN_HUNGRY;
  }
  return WARN_NONE;
}

function toStatus(row: PetRow): PetStatus {
  return {
    id: row.id,
    name: row.name,
    species: row.species,
    emoji: row.emoji,
    rarity: row.rarity,
    adoptedByName: row.adopted_by_name,
    adoptedAt: row.adopted_at,
    food: row.food,
    mood: row.mood,
    threadId: row.thread_id,
  };
}
