import { DurableObject } from "cloudflare:workers";
import type { Env } from "../main.js";

export type WordleGolfGameStatus = "active" | "completed" | "archived";

export interface WordleGolfGame {
  id: number;
  threadId: number | null;
  holes: number;
  mulligans: number;
  startDate: string;
  initialPuzzleNumber: number;
  status: WordleGolfGameStatus;
  createdAt: string;
  completedAt: string | null;
}

export interface WordleGolfScorecardHole {
  puzzleNumber: number;
  value: number;
  label: string;
  isMulligan: boolean;
}

export interface WordleGolfScorecardEntry {
  userId: number;
  username: string | null;
  firstName: string;
  total: number;
  holes: WordleGolfScorecardHole[];
}

export interface WordleGolfScorecard {
  game: WordleGolfGame;
  players: WordleGolfScorecardEntry[];
}

export interface WordleGolfLeaderboardEntry {
  userId: number;
  username: string | null;
  firstName: string;
  gamesPlayed: number;
  totalScore: number;
  averageScore: number;
}

export type WordleGolfSubmitErrorType = "NO_ACTIVE_GAME" | "GAME_NOT_STARTED" | "GAME_OVER" | "ALREADY_SCORED";

// A discriminated result rather than a thrown custom error: Workers RPC only preserves the bare
// `message` of a thrown Error across the DO boundary (not its class or any custom fields — see
// https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/), so a typed error
// class here would silently lose its `.type` by the time the caller catches it.
export type WordleGolfSubmitResult = { ok: true } | { ok: false; type: WordleGolfSubmitErrorType };

interface GameRow {
  [column: string]: SqlStorageValue;
  id: number;
  thread_id: number | null;
  holes: number;
  mulligans: number;
  start_date: string;
  initial_puzzle_number: number;
  status: WordleGolfGameStatus;
  created_at: string;
  completed_at: string | null;
}

interface ScoreWithPlayerRow {
  [column: string]: SqlStorageValue;
  user_id: number;
  username: string | null;
  first_name: string;
  puzzle_number: number;
  score_value: number;
  score_label: string;
  is_mulligan: number;
}

interface LeaderboardRow {
  [column: string]: SqlStorageValue;
  user_id: number;
  username: string | null;
  first_name: string;
  games_played: number;
  total_score: number;
}

function toGame(row: GameRow): WordleGolfGame {
  return {
    id: row.id,
    threadId: row.thread_id,
    holes: row.holes,
    mulligans: row.mulligans,
    startDate: row.start_date,
    initialPuzzleNumber: row.initial_puzzle_number,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

// One instance per Telegram chat — holds every round (and every player) that chat has ever played,
// so leaderboard queries are a single local join instead of a fan-out across DOs.
export class WordleGolf extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS players (
        user_id INTEGER PRIMARY KEY,
        username TEXT,
        first_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER,
        holes INTEGER NOT NULL,
        mulligans INTEGER NOT NULL DEFAULT 0,
        start_date TEXT NOT NULL,
        initial_puzzle_number INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','archived')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id INTEGER NOT NULL REFERENCES games(id),
        user_id INTEGER NOT NULL REFERENCES players(user_id),
        puzzle_number INTEGER NOT NULL,
        score_value REAL NOT NULL,
        score_label TEXT NOT NULL,
        is_mulligan INTEGER NOT NULL DEFAULT 0,
        raw_message TEXT,
        submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (game_id, user_id, puzzle_number)
      )
    `);
  }

  async getActiveGame(): Promise<WordleGolfGame | null> {
    const row = this.ctx.storage.sql.exec<GameRow>(`SELECT * FROM games WHERE status = 'active' LIMIT 1`).toArray()[0];
    return row ? toGame(row) : null;
  }

  // Archives any existing active game (rather than the sheets version's rename-with-timestamp hack)
  // and starts a new one in its place.
  async startGame(config: {
    threadId?: number;
    holes: number;
    mulligans: number;
    startDate: string;
    initialPuzzleNumber: number;
  }): Promise<WordleGolfGame> {
    this.ctx.storage.sql.exec(`UPDATE games SET status = 'archived' WHERE status = 'active'`);
    const row = this.ctx.storage.sql
      .exec<GameRow>(
        `INSERT INTO games (thread_id, holes, mulligans, start_date, initial_puzzle_number)
         VALUES (?, ?, ?, ?, ?)
         RETURNING *`,
        config.threadId ?? null,
        config.holes,
        config.mulligans,
        config.startDate,
        config.initialPuzzleNumber
      )
      .one();
    return toGame(row);
  }

  async submitScore(input: {
    userId: number;
    username?: string;
    firstName: string;
    puzzleNumber: number;
    scoreValue: number;
    scoreLabel: string;
    rawMessage?: string;
  }): Promise<WordleGolfSubmitResult> {
    const game = await this.getActiveGame();
    if (!game) {
      return { ok: false, type: "NO_ACTIVE_GAME" };
    }

    const holeIndex = input.puzzleNumber - game.initialPuzzleNumber;
    if (holeIndex < 0) {
      return { ok: false, type: "GAME_NOT_STARTED" };
    }
    if (holeIndex >= game.holes) {
      return { ok: false, type: "GAME_OVER" };
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO players (user_id, username, first_name) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name, updated_at = datetime('now')`,
      input.userId,
      input.username ?? null,
      input.firstName
    );

    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO scores (game_id, user_id, puzzle_number, score_value, score_label, raw_message)
         VALUES (?, ?, ?, ?, ?, ?)`,
        game.id,
        input.userId,
        input.puzzleNumber,
        input.scoreValue,
        input.scoreLabel,
        input.rawMessage ?? null
      );
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE")) {
        return { ok: false, type: "ALREADY_SCORED" };
      }
      throw err;
    }

    // Backfill any earlier closed holes this player skipped — most commonly from joining the round late.
    // Without this, waiting to join would dodge the missed-day penalty for every day before their first
    // submission. Idempotent no-op for holes they already have a real score for.
    for (let i = 0; i < holeIndex; i++) {
      this.ctx.storage.sql.exec(
        `INSERT INTO scores (game_id, user_id, puzzle_number, score_value, score_label)
         VALUES (?, ?, ?, 7, 'Missed')
         ON CONFLICT(game_id, user_id, puzzle_number) DO NOTHING`,
        game.id,
        input.userId,
        game.initialPuzzleNumber + i
      );
    }

    return { ok: true };
  }

  async getScorecard(gameId: number): Promise<WordleGolfScorecard> {
    const gameRow = this.ctx.storage.sql.exec<GameRow>(`SELECT * FROM games WHERE id = ?`, gameId).toArray()[0];
    if (!gameRow) {
      throw new Error(`Round ${gameId} does not exist.`);
    }

    const rows = this.ctx.storage.sql
      .exec<ScoreWithPlayerRow>(
        `SELECT s.user_id, p.username, p.first_name, s.puzzle_number, s.score_value, s.score_label, s.is_mulligan
         FROM scores s
         JOIN players p ON p.user_id = s.user_id
         WHERE s.game_id = ?
         ORDER BY s.puzzle_number ASC`,
        gameId
      )
      .toArray();

    const byPlayer = new Map<number, WordleGolfScorecardEntry>();
    for (const row of rows) {
      let entry = byPlayer.get(row.user_id);
      if (!entry) {
        entry = { userId: row.user_id, username: row.username, firstName: row.first_name, total: 0, holes: [] };
        byPlayer.set(row.user_id, entry);
      }
      entry.holes.push({
        puzzleNumber: row.puzzle_number,
        value: row.score_value,
        label: row.score_label,
        isMulligan: !!row.is_mulligan,
      });
      if (!row.is_mulligan) {
        entry.total += row.score_value;
      }
    }

    return { game: toGame(gameRow), players: [...byPlayer.values()] };
  }

  // Fills in a 7-point "Missed" score for every already-participating player (anyone with at least one
  // score in this game) for any hole below `closedHoles` that they never submitted for. Safe to call
  // repeatedly for the same game — the scores UNIQUE constraint makes each insert a no-op once it exists,
  // so the caller doesn't need to track which holes were already backfilled.
  async backfillMissedDays(closedHoles: number): Promise<void> {
    const game = await this.getActiveGame();
    if (!game) {
      return;
    }

    const players = this.ctx.storage.sql
      .exec<{ user_id: number }>(`SELECT DISTINCT user_id FROM scores WHERE game_id = ?`, game.id)
      .toArray();

    for (const { user_id } of players) {
      for (let holeIndex = 0; holeIndex < closedHoles; holeIndex++) {
        this.ctx.storage.sql.exec(
          `INSERT INTO scores (game_id, user_id, puzzle_number, score_value, score_label)
           VALUES (?, ?, ?, 7, 'Missed')
           ON CONFLICT(game_id, user_id, puzzle_number) DO NOTHING`,
          game.id,
          user_id,
          game.initialPuzzleNumber + holeIndex
        );
      }
    }
  }

  // Marks a game's top `mulligans` scores per player as excluded, then closes it out. Scores themselves are
  // never overwritten — only flagged — so totals stay fully recomputable/auditable after the fact.
  async finalizeGame(gameId: number): Promise<WordleGolfScorecard> {
    const gameRow = this.ctx.storage.sql.exec<GameRow>(`SELECT * FROM games WHERE id = ?`, gameId).toArray()[0];
    if (!gameRow) {
      throw new Error(`Round ${gameId} does not exist.`);
    }

    const players = this.ctx.storage.sql
      .exec<{ user_id: number }>(`SELECT DISTINCT user_id FROM scores WHERE game_id = ?`, gameId)
      .toArray();

    for (const { user_id } of players) {
      // "Missed" (backfilled, didn't-play) scores are excluded — mulligans forgive a bad round you actually
      // played, not skipping the round entirely. Without this, a late joiner's missed-day penalty would
      // just get erased by their own mulligans, since a 7 is usually among the worst scores anyway.
      const topScores = this.ctx.storage.sql
        .exec<{ id: number }>(
          `SELECT id FROM scores WHERE game_id = ? AND user_id = ? AND score_label != 'Missed' ORDER BY score_value DESC LIMIT ?`,
          gameId,
          user_id,
          gameRow.mulligans
        )
        .toArray();
      for (const { id } of topScores) {
        this.ctx.storage.sql.exec(`UPDATE scores SET is_mulligan = 1 WHERE id = ?`, id);
      }
    }

    this.ctx.storage.sql.exec(`UPDATE games SET status = 'completed', completed_at = datetime('now') WHERE id = ?`, gameId);

    return this.getScorecard(gameId);
  }

  // Career stats across every completed game in this chat. Active (unfinished, un-mulliganed) games are
  // excluded so an in-progress round can't skew the totals.
  async getLeaderboard(): Promise<WordleGolfLeaderboardEntry[]> {
    const rows = this.ctx.storage.sql
      .exec<LeaderboardRow>(
        `SELECT p.user_id, p.username, p.first_name,
                COUNT(DISTINCT s.game_id) as games_played,
                SUM(CASE WHEN s.is_mulligan THEN 0 ELSE s.score_value END) as total_score
         FROM scores s
         JOIN players p ON p.user_id = s.user_id
         JOIN games g ON g.id = s.game_id
         WHERE g.status = 'completed'
         GROUP BY p.user_id
         ORDER BY total_score ASC`
      )
      .toArray();

    return rows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      firstName: row.first_name,
      gamesPlayed: row.games_played,
      totalScore: row.total_score,
      averageScore: row.total_score / row.games_played,
    }));
  }

  // Backs grammY's conversations() persistent storage for this chat, using the DO's plain KV storage
  // (separate from the SQL tables above). The Worker rebuilds itself on every request, so without this
  // the "someone else confirms" step in the new-round conversation would silently lose its place between
  // one person's message and the next.
  async readSession(): Promise<unknown> {
    return await this.ctx.storage.get("session");
  }

  async writeSession(state: unknown): Promise<void> {
    await this.ctx.storage.put("session", state);
  }

  async deleteSession(): Promise<void> {
    await this.ctx.storage.delete("session");
  }
}