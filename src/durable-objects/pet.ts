import { DurableObject } from "cloudflare:workers";
import type { Env } from "../main.js";
import {
  CAR_CRASH_CHANCE,
  CAR_TRICK,
  MAX_PET_SLOTS,
  PARK_TRICK,
  PARKING_LAWSUIT_MOOD,
  PET_CONFIG,
  PET_FOODS,
  PET_FUND,
  PET_TRICKS,
  rollPlayOutcome,
  type PetRarity,
  type PlayOutcome,
} from "../pet-config.js";
import { advanceMeters, petFate, type PetMeters } from "../pet-math.js";

// "overfed" is no longer caused by anything (it was briefly a 3% overfeed death), but a past pet may have it.
export type PetDeathCause = "starved" | "ran_away" | "put_down" | "overfed" | "car_crash";

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
  // The most recent feed, pet, or play outcome, for the card's "who did what" line. food is the random
  // PET_FOODS emoji a feed turned out to be, and trick the PET_TRICKS name a play learned or showed off —
  // both stored so the card shows the same thing every time.
  lastAction: { kind: PetAction; by: string; food: string | null; trick: string | null } | null;
  tricksKnown: number;
}

// What a button press turned into: a feed (or an overfeed), a pet, or one of the random Play outcomes.
// "botched" is a PARK_TRICK performance by a pet that learned it before it could drive.
export type PetAction = "fed" | "petted" | "overfed" | "botched" | PlayOutcome;
export type PetInput = "feed" | "pet" | "play";

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
  lastActionBy: string | null; // who did the last feed/pet/play — for a car crash, who was playing with it
  onlyPetted: string[]; // petted it, never fed it
  onlyFed: string[]; // fed it, never petted it
  tricksKnown: number;
}

// The only warning the hourly check posts on its own: food has hit 0 and the clock is running. Hunger and
// loneliness show up as the pet begging in /fish replies instead (see peek).
export type PetWarning = { type: "dying"; hoursLeft: number };

// How the neediest living pet is doing right now, for the begging line in /fish replies (see peek).
export interface PetPeek {
  name: string;
  species: string;
  emoji: string;
  food: number;
  mood: number;
}

// Anything that settles the pets can discover one died since the last look (the meters are lazy — see
// pet-math.ts). That call returns each eulogy exactly once, and whoever made it posts them.
export type PetLookup = { pets: PetStatus[]; eulogies: PetEulogy[] }; // living pets, oldest first

// How much room the chat has for pets, and how the fund toward the next slot is going (see PET_FUND).
export interface PetFundStatus {
  slots: number; // unlocked
  maxSlots: number; // MAX_PET_SLOTS
  livingPets: number;
  raised: number; // toward the next goal
  goal: number | null; // the next goal, or null once every slot is unlocked
}

// A slot a donation just unlocked, with who gave the most toward it (at most PET_FUND.TOP_DONORS).
export interface PetFundUnlock {
  slot: number;
  goal: number;
  topDonors: { firstName: string; amount: number }[];
}

export type PetFundDonateResult =
  | { ok: true; fund: PetFundStatus; unlocked: PetFundUnlock[] } // usually 0 or 1 unlocks; can be more
  | { ok: false; reason: "MAXED" } // every slot already unlocked
  | { ok: false; reason: "TOO_MUCH"; max: number }; // more than is left across all goals

export type PetAdoptResult =
  | { ok: true; pet: PetStatus; eulogies: PetEulogy[] }
  | { ok: false; type: "FULL"; pets: PetStatus[]; fund: PetFundStatus };

export type PetTickResult = { pets: PetStatus[]; eulogies: PetEulogy[]; warnings: { petId: number; warning: PetWarning }[] };

// eulogies: any deaths the kill's settle noticed on its own (posted like a lookup's), besides the one it caused.
export type PetKillResult = { eulogies: PetEulogy[] } & (
  | { eulogy: PetEulogy }
  | { needsName: true; pets: string[] } // several living pets and no name: these are their names
  | { notFound: true }
);

// livingPets on a successful tap is how many pets the chat has right now, so the card it turns into knows
// whether to offer the way back to the summary (see pet.ts).
export type PetInteractResult =
  | { result: "OK" | "OVERFED"; pet: PetStatus; livingPets: number }
  | { result: "COOLDOWN"; pet: PetStatus; retryInSeconds: number }
  | { result: "GONE"; eulogy: PetEulogy } // died right before this tap
  | { result: "KILLED"; eulogy: PetEulogy } // this tap killed it (performing CAR_TRICK — see CAR_CRASH_CHANCE)
  | { result: "STALE" }; // button from a card for a pet that's no longer around

export interface PetGraveyardEntry {
  name: string;
  species: string;
  emoji: string;
  adoptedAt: number;
  diedAt: number;
  cause: PetDeathCause;
  tricksKnown: number;
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
  last_action: PetAction | null;
  last_action_by: string | null;
  last_action_food: string | null;
  last_action_trick: string | null;
  died_at: number | null;
  cause: PetDeathCause | null;
};

// Hunger levels, in order of urgency. Only WARN_DYING is ever posted now (see tick); warn_level remembers
// whether it has been for the current hunger spell, so it posts once. Feeding resets it to wherever food
// lands. (The lower levels used to be posted too; they're kept so the stored values still mean the same.)
const WARN_NONE = 0;
const WARN_HUNGRY = 1;
const WARN_STARVING = 2;
const WARN_DYING = 3;

const nowSec = () => Math.floor(Date.now() / 1000);

// One per chat (idFromName(`pet_${chatId}`)): the living pets (rows with died_at NULL — at most as many as
// the chat has slots), every past pet for /graveyard, per-person caretaking history for cooldowns and
// eulogy blame, and the pet fund that buys more slots (see PET_FUND).
export class Pet extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.migrate();
  }

  // Same _schema_migrations approach as the StockMarket DO: CREATE TABLE IF NOT EXISTS is a no-op against
  // an already-existing table, so later columns need real migrations.
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
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (1)`);
    }

    if (version < 2) {
      // The most recent feed/pet, shown on the card so everyone can see who did what.
      this.ctx.storage.sql.exec(`ALTER TABLE pets ADD COLUMN last_action TEXT`);
      this.ctx.storage.sql.exec(`ALTER TABLE pets ADD COLUMN last_action_by TEXT`);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (2)`);
    }

    if (version < 3) {
      this.ctx.storage.sql.exec(`ALTER TABLE pets ADD COLUMN last_action_food TEXT`);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (3)`);
    }

    if (version < 4) {
      // 🎾 Play: its own per-person cooldown and count.
      this.ctx.storage.sql.exec(`ALTER TABLE caretakers ADD COLUMN plays INTEGER NOT NULL DEFAULT 0`);
      this.ctx.storage.sql.exec(`ALTER TABLE caretakers ADD COLUMN last_played_at INTEGER`);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (4)`);
    }

    if (version < 5) {
      // Tricks learned through 🎾 Play (see PET_TRICKS).
      this.ctx.storage.sql.exec(`
        CREATE TABLE pet_tricks (
          pet_id INTEGER NOT NULL REFERENCES pets(id),
          trick TEXT NOT NULL,
          taught_by TEXT NOT NULL,
          learned_at INTEGER NOT NULL,
          PRIMARY KEY (pet_id, trick)
        )
      `);
      this.ctx.storage.sql.exec(`ALTER TABLE pets ADD COLUMN last_action_trick TEXT`);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (5)`);
    }

    if (version < 6) {
      // The pet fund. slots is how many pets can be alive at once; raised counts toward the next goal, and
      // starts over at 0 each time one is reached. A chat's existing pet (if any) is its one pet in slot 1.
      this.ctx.storage.sql.exec(`
        CREATE TABLE pet_fund (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          slots INTEGER NOT NULL DEFAULT 1,
          raised INTEGER NOT NULL DEFAULT 0
        )
      `);
      this.ctx.storage.sql.exec(`INSERT INTO pet_fund (id) VALUES (1)`);
      // One row per donation per slot: a donation that crosses a goal is split, each part recorded against
      // the slot it went toward, so each unlock's thank-you names who actually paid for that one.
      this.ctx.storage.sql.exec(`
        CREATE TABLE fund_donations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          first_name TEXT NOT NULL,
          amount INTEGER NOT NULL,
          slot INTEGER NOT NULL,
          at INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (6)`);
    }
  }

  async lookup(): Promise<PetLookup> {
    const { rows, eulogies } = this.settle(nowSec());
    return { pets: rows.map((row) => this.status(row)), eulogies };
  }

  // Fails if every slot already has a living pet — two people finishing /adopt for the last slot at once
  // can't both get one.
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
    const { rows, eulogies } = this.settle(now);
    const fund = this.fund();
    if (rows.length >= fund.slots) {
      return { ok: false, type: "FULL", pets: rows.map((row) => this.status(row)), fund: fundStatus(fund, rows.length) };
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
    return { ok: true, pet: this.status(inserted), eulogies };
  }

  // feedAmount: how much food a feed adds — set by the caller, since it depends on the fish being fed
  // (see foodForFish), or PET_CONFIG.FEED_AMOUNT when the chat has fishing switched off. Settles only the
  // pet being tapped; any others are left for the next lookup to notice.
  async interact(input: {
    petId: number;
    action: PetInput;
    userId: number;
    firstName: string;
    feedAmount: number;
  }): Promise<PetInteractResult> {
    const now = nowSec();
    const living = this.ctx.storage.sql
      .exec<PetRow>(`SELECT * FROM pets WHERE id = ? AND died_at IS NULL`, input.petId)
      .toArray()[0];
    if (!living) {
      return { result: "STALE" };
    }
    const { row, eulogy } = this.settleOne(living, now);
    if (eulogy) {
      return { result: "GONE", eulogy };
    }
    if (!row) {
      return { result: "STALE" };
    }

    const caretaker = this.ctx.storage.sql
      .exec<{ last_fed_at: number | null; last_petted_at: number | null; last_played_at: number | null }>(
        `SELECT last_fed_at, last_petted_at, last_played_at FROM caretakers WHERE pet_id = ? AND user_id = ?`,
        row.id,
        input.userId
      )
      .toArray()[0];
    const last = { feed: caretaker?.last_fed_at, pet: caretaker?.last_petted_at, play: caretaker?.last_played_at }[input.action];
    const cooldownHours = {
      feed: PET_CONFIG.FEED_COOLDOWN_HOURS,
      pet: PET_CONFIG.PET_COOLDOWN_HOURS,
      play: PET_CONFIG.PLAY_COOLDOWN_HOURS,
    }[input.action];
    if (last != null && now - last < cooldownHours * 3600) {
      return { result: "COOLDOWN", pet: this.status(row), retryInSeconds: last + cooldownHours * 3600 - now };
    }

    let food = row.food;
    let mood = row.mood;
    let kind: PetAction;
    let trick: string | null = null;
    if (input.action === "feed") {
      if (food >= PET_CONFIG.OVERFED_AT) {
        kind = "overfed";
        mood -= PET_CONFIG.OVERFED_MOOD_PENALTY;
      } else {
        kind = "fed";
        food += input.feedAmount;
      }
    } else if (input.action === "pet") {
      kind = "petted";
      mood += PET_CONFIG.PET_AMOUNT;
    } else {
      const known = this.knownTricks(row.id);
      const outcome = rollPlayOutcome({ learn: known.length < PET_TRICKS.length, showOff: known.length > 0 });
      kind = outcome.kind;
      food += outcome.food;
      mood += outcome.mood;
      if (kind === "learned") {
        const unknown = PET_TRICKS.map((t) => t.name).filter((name) => !known.includes(name));
        trick = unknown[Math.floor(Math.random() * unknown.length)]!;
        this.ctx.storage.sql.exec(
          `INSERT INTO pet_tricks (pet_id, trick, taught_by, learned_at) VALUES (?, ?, ?, ?)`,
          row.id,
          trick,
          input.firstName,
          now
        );
      } else if (kind === "trick") {
        trick = known[Math.floor(Math.random() * known.length)]!;
        if (trick === PARK_TRICK && this.learnedParkingBeforeDriving(row.id)) {
          kind = "botched";
          mood = row.mood + PARKING_LAWSUIT_MOOD;
        }
      }
    }
    food = Math.max(0, Math.min(100, food));
    mood = Math.max(0, Math.min(100, mood));

    const fed = input.action === "feed";
    const petted = input.action === "pet";
    const updated = this.ctx.storage.sql
      .exec<PetRow>(
        `UPDATE pets SET food = ?, mood = ?, updated_at = ?, food_empty_since = ?, mood_empty_since = ?, warn_level = ?,
           mood_warned = ?, last_fed_by = ?, last_fed_at = ?, last_petted_by = ?, last_petted_at = ?, last_action = ?,
           last_action_by = ?, last_action_food = ?, last_action_trick = ?
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
        petted ? input.firstName : row.last_petted_by,
        petted ? now : row.last_petted_at,
        kind,
        input.firstName,
        fed ? PET_FOODS[Math.floor(Math.random() * PET_FOODS.length)]! : null,
        trick,
        row.id
      )
      .one();

    this.ctx.storage.sql.exec(
      `INSERT INTO caretakers (pet_id, user_id, first_name, feeds, pets, plays, last_fed_at, last_petted_at, last_played_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pet_id, user_id) DO UPDATE SET
         first_name = excluded.first_name,
         feeds = feeds + excluded.feeds,
         pets = pets + excluded.pets,
         plays = plays + excluded.plays,
         last_fed_at = COALESCE(excluded.last_fed_at, last_fed_at),
         last_petted_at = COALESCE(excluded.last_petted_at, last_petted_at),
         last_played_at = COALESCE(excluded.last_played_at, last_played_at)`,
      row.id,
      input.userId,
      input.firstName,
      fed ? 1 : 0,
      petted ? 1 : 0,
      input.action === "play" ? 1 : 0,
      fed ? now : null,
      petted ? now : null,
      input.action === "play" ? now : null
    );

    // Recorded after the play above, so the eulogy knows who it was with.
    if (kind === "trick" && trick === CAR_TRICK && Math.random() < CAR_CRASH_CHANCE) {
      this.ctx.storage.sql.exec(`UPDATE pets SET died_at = ?, cause = 'car_crash' WHERE id = ?`, now, row.id);
      return { result: "KILLED", eulogy: this.eulogy(row.id) };
    }

    return { result: kind === "overfed" ? "OVERFED" : "OK", pet: this.status(updated), livingPets: this.livingCount(now) };
  }

  // The hourly check (see PetComposer.runHourlyCheck). Settles every pet — which is where deaths get
  // noticed if nobody's looked in a while — and returns each one's "dying" warning if it's newly due (once
  // per hunger spell; a feed resets it). awake is whether it may post right now; one that comes due
  // overnight just waits for the morning.
  async tick(awake: boolean): Promise<PetTickResult> {
    const now = nowSec();
    const { rows, eulogies } = this.settle(now);
    const warnings: PetTickResult["warnings"] = [];
    for (const row of rows) {
      if (awake && warnLevelFor(row.food) === WARN_DYING && row.warn_level < WARN_DYING) {
        const starveAt = (row.food_empty_since ?? now) + PET_CONFIG.STARVE_AFTER_EMPTY_HOURS * 3600;
        warnings.push({ petId: row.id, warning: { type: "dying", hoursLeft: Math.max(1, Math.round((starveAt - now) / 3600)) } });
        this.ctx.storage.sql.exec(`UPDATE pets SET warn_level = ? WHERE id = ?`, WARN_DYING, row.id);
      }
    }
    return { pets: rows.map((row) => this.status(row)), eulogies, warnings };
  }

  // A read-only look at the neediest living pet as of now (lowest food, then lowest mood). Changes
  // nothing: a pet that has died since anyone last looked is skipped, and its death left for the next real
  // lookup (or the hourly check) to record and announce, so the eulogy is never lost.
  async peek(): Promise<PetPeek | null> {
    const now = nowSec();
    const alive = this.livingRows()
      .map((row) => ({ row, meters: projectMeters(row, now) }))
      .filter(({ meters }) => !petFate(meters))
      .sort((a, b) => a.meters.food - b.meters.food || a.meters.mood - b.meters.mood);
    const neediest = alive[0];
    if (!neediest) {
      return null;
    }
    const { row, meters } = neediest;
    return { name: row.name, species: row.species, emoji: row.emoji, food: meters.food, mood: meters.mood };
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
        tricksKnown: this.knownTricks(row.id).length,
      }));
  }

  // Owner-only (see PetComposer): mercy, or testing. With one living pet the name is optional; with
  // several it has to match one of them (ignoring case — the oldest, if two share it).
  async kill(name?: string): Promise<PetKillResult> {
    const now = nowSec();
    const { rows, eulogies } = this.settle(now);
    const wanted = name?.trim().toLowerCase();
    if (!wanted && rows.length > 1) {
      return { eulogies, needsName: true, pets: rows.map((row) => row.name) };
    }
    const row = wanted ? rows.find((r) => r.name.toLowerCase() === wanted) : rows[0];
    if (!row) {
      return { eulogies, notFound: true };
    }
    this.ctx.storage.sql.exec(`UPDATE pets SET died_at = ?, cause = 'put_down' WHERE id = ?`, now, row.id);
    return { eulogies, eulogy: this.eulogy(row.id) };
  }

  // Owner-only: brings the most recent dead pet back at full meters, in case a bug killed it. No-op if
  // every slot already has a living pet.
  async revive(): Promise<PetStatus | null> {
    const now = nowSec();
    if (this.settle(now).rows.length >= this.fund().slots) {
      return null;
    }
    const revived = this.ctx.storage.sql
      .exec<PetRow>(
        `UPDATE pets SET died_at = NULL, cause = NULL, food = 100, mood = 100, updated_at = ?, food_empty_since = NULL,
           mood_empty_since = NULL, frozen_at = NULL, warn_level = 0, mood_warned = 0, last_action = NULL, last_action_by = NULL,
           last_action_food = NULL, last_action_trick = NULL
         WHERE id = (SELECT id FROM pets WHERE died_at IS NOT NULL ORDER BY died_at DESC LIMIT 1)
         RETURNING *`,
        now
      )
      .toArray()[0];
    return revived ? this.status(revived) : null;
  }

  async fundStatus(): Promise<PetFundStatus> {
    return fundStatus(this.fund(), this.livingCount(nowSec()));
  }

  // A store-page donation (the beans are already charged — see the store API, which refunds them if this
  // refuses). Fills the current goal, and anything past it carries into the next, possibly unlocking more
  // than one slot at once; each part is recorded against the slot it went toward. Refuses outright once
  // every slot is unlocked, or if it's more than every remaining goal still needs.
  async donateToFund(input: { userId: number; firstName: string; amount: number }): Promise<PetFundDonateResult> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new Error(`Bad pet fund donation: ${input.amount}`);
    }
    const now = nowSec();
    let { slots, raised } = this.fund();
    if (slots >= MAX_PET_SLOTS) {
      return { ok: false, reason: "MAXED" };
    }
    const max = PET_FUND.SLOT_GOALS.slice(slots - 1).reduce((sum, goal) => sum + goal, 0) - raised;
    if (input.amount > max) {
      return { ok: false, reason: "TOO_MUCH", max };
    }

    const unlocked: PetFundUnlock[] = [];
    let left = input.amount;
    while (left > 0 && slots < MAX_PET_SLOTS) {
      const goal = PET_FUND.SLOT_GOALS[slots - 1]!;
      const part = Math.min(left, goal - raised);
      this.ctx.storage.sql.exec(
        `INSERT INTO fund_donations (user_id, first_name, amount, slot, at) VALUES (?, ?, ?, ?, ?)`,
        input.userId,
        input.firstName,
        part,
        slots + 1,
        now
      );
      left -= part;
      raised += part;
      if (raised >= goal) {
        slots += 1;
        raised = 0;
        unlocked.push({ slot: slots, goal, topDonors: this.topDonors(slots) });
      }
    }
    this.ctx.storage.sql.exec(`UPDATE pet_fund SET slots = ?, raised = ? WHERE id = 1`, slots, raised);
    return { ok: true, fund: fundStatus({ slots, raised }, this.livingCount(now)), unlocked };
  }

  // Who gave the most toward one slot, by total, under the name they last gave with. Ties go to whoever
  // gave first.
  private topDonors(slot: number): PetFundUnlock["topDonors"] {
    return this.ctx.storage.sql
      .exec<{ first_name: string; total: number }>(
        `SELECT
           (SELECT first_name FROM fund_donations AS latest WHERE latest.user_id = d.user_id ORDER BY latest.id DESC LIMIT 1) AS first_name,
           SUM(amount) AS total
         FROM fund_donations AS d
         WHERE slot = ?
         GROUP BY user_id
         ORDER BY total DESC, MIN(id)
         LIMIT ?`,
        slot,
        PET_FUND.TOP_DONORS
      )
      .toArray()
      .map((row) => ({ firstName: row.first_name, amount: row.total }));
  }

  private fund(): { slots: number; raised: number } {
    const row = this.ctx.storage.sql.exec<{ slots: number; raised: number }>(`SELECT slots, raised FROM pet_fund WHERE id = 1`).toArray()[0];
    return row ?? { slots: 1, raised: 0 };
  }

  private livingRows(): PetRow[] {
    return this.ctx.storage.sql.exec<PetRow>(`SELECT * FROM pets WHERE died_at IS NULL ORDER BY adopted_at, id`).toArray();
  }

  // How many pets are alive as of now, without settling anyone: one that has died unnoticed doesn't count,
  // but its death is left for the next settle to record and announce.
  private livingCount(now: number): number {
    return this.livingRows().filter((row) => !petFate(projectMeters(row, now))).length;
  }

  // Settles every living pet (see settleOne), oldest first, collecting the eulogies of any that died (in
  // the order they died).
  private settle(now: number): { rows: PetRow[]; eulogies: PetEulogy[] } {
    const rows: PetRow[] = [];
    const eulogies: PetEulogy[] = [];
    for (const living of this.livingRows()) {
      const { row, eulogy } = this.settleOne(living, now);
      if (row) {
        rows.push(row);
      }
      if (eulogy) {
        eulogies.push(eulogy);
      }
    }
    return { rows, eulogies: eulogies.sort((a, b) => a.diedAt - b.diedAt) };
  }

  // Brings one living pet's meters up to `now`, thawing it first if the hourly check froze it. If it died
  // in the meantime, records that (at the moment it actually happened, not now) and returns the eulogy —
  // this is the only place a pet dies on its own. It only ever sees pets with died_at NULL, so each death
  // is recorded, and its eulogy returned, once.
  private settleOne(row: PetRow, now: number): { row: PetRow | null; eulogy?: PetEulogy } {
    const meters = projectMeters(row, now);
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
        frozen_at: null,
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
      lastActionBy: row.last_action_by,
      onlyPetted: caretakers.filter((c) => c.feeds === 0 && c.pets > 0).map((c) => c.first_name),
      onlyFed: caretakers.filter((c) => c.pets === 0 && c.feeds > 0).map((c) => c.first_name),
      tricksKnown: this.knownTricks(petId).length,
    };
  }

  // True if it knows PARK_TRICK and either can't drive (CAR_TRICK) or learned to drive afterwards.
  private learnedParkingBeforeDriving(petId: number): boolean {
    const learnedAt = (trick: string) =>
      this.ctx.storage.sql
        .exec<{ learned_at: number }>(`SELECT learned_at FROM pet_tricks WHERE pet_id = ? AND trick = ?`, petId, trick)
        .toArray()[0]?.learned_at;
    const park = learnedAt(PARK_TRICK);
    const drive = learnedAt(CAR_TRICK);
    return park !== undefined && (drive === undefined || drive > park);
  }

  private knownTricks(petId: number): string[] {
    return this.ctx.storage.sql
      .exec<{ trick: string }>(`SELECT trick FROM pet_tricks WHERE pet_id = ?`, petId)
      .toArray()
      .map((row) => row.trick);
  }

  private status(row: PetRow): PetStatus {
    return toStatusRow(row, this.knownTricks(row.id).length);
  }
}

// A living pet's meters as of `now`. A frozen pet (see freeze) has every timestamp shifted forward by how
// long it's been frozen first, so the time it spent frozen doesn't count.
function projectMeters(row: PetRow, now: number): PetMeters {
  const shift = row.frozen_at !== null ? now - row.frozen_at : 0;
  return advanceMeters(
    {
      food: row.food,
      mood: row.mood,
      at: row.updated_at + shift,
      foodEmptySince: row.food_empty_since !== null ? row.food_empty_since + shift : null,
      moodEmptySince: row.mood_empty_since !== null ? row.mood_empty_since + shift : null,
    },
    now
  );
}

function fundStatus(fund: { slots: number; raised: number }, livingPets: number): PetFundStatus {
  return {
    slots: fund.slots,
    maxSlots: MAX_PET_SLOTS,
    livingPets,
    raised: fund.raised,
    goal: fund.slots < MAX_PET_SLOTS ? (PET_FUND.SLOT_GOALS[fund.slots - 1] ?? null) : null,
  };
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

function toStatusRow(row: PetRow, tricksKnown: number): PetStatus {
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
    lastAction:
      row.last_action && row.last_action_by
        ? { kind: row.last_action, by: row.last_action_by, food: row.last_action_food, trick: row.last_action_trick }
        : null,
    tricksKnown,
  };
}
