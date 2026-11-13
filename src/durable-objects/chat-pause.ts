import { DurableObject } from "cloudflare:workers";
import type { Env } from "../main.js";

export interface ChatPauseState {
  paused: boolean;
  // When /startmarket last actually unpaused this chat (null if it never has) — epoch seconds via
  // SQLite's own strftime, never a JS parse of its space-separated UTC string. See runDailyCleanup's
  // grace period for why this is tracked.
  resumedAtEpochSec: number | null;
}

export class ChatPause extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.migrate();
  }

  // Same _schema_migrations approach as the StockMarket DO: CREATE TABLE IF NOT EXISTS is a no-op against
  // the already-deployed table, so the resumed_at column needs a real migration.
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
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS pause (id INTEGER PRIMARY KEY, paused INTEGER NOT NULL)`);
      this.ctx.storage.sql.exec(`INSERT INTO pause (id, paused) VALUES (1, 0) ON CONFLICT(id) DO NOTHING`);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (1)`);
    }

    if (version < 2) {
      this.ctx.storage.sql.exec(`ALTER TABLE pause ADD COLUMN resumed_at TEXT`);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (2)`);
    }
  }

  async isPaused(): Promise<boolean> {
    return (await this.getState()).paused;
  }

  async getState(): Promise<ChatPauseState> {
    const row = this.ctx.storage.sql
      .exec<{ paused: number; resumed_at_epoch_sec: number | null }>(
        `SELECT paused, CAST(strftime('%s', resumed_at) AS INTEGER) as resumed_at_epoch_sec FROM pause WHERE id = 1`
      )
      .one();
    return { paused: row.paused === 1, resumedAtEpochSec: row.resumed_at_epoch_sec };
  }

  // resumed_at only moves on a real paused -> unpaused transition, so a redundant /startmarket on an
  // already-running chat doesn't restart the grace period. SQLite evaluates every SET expression against
  // the row's pre-update values, so the CASE still sees the old paused flag.
  async setPaused(paused: boolean): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE pause
       SET resumed_at = CASE WHEN paused = 1 AND ? = 0 THEN datetime('now') ELSE resumed_at END,
           paused = ?
       WHERE id = 1`,
      paused ? 1 : 0,
      paused ? 1 : 0
    );
  }
}
