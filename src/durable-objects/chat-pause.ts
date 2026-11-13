import { DurableObject } from "cloudflare:workers";
import type { Env } from "../main.js";
import type { FeatureOverride } from "../features.js";

// Per-chat feature switches (see features.ts). Named ChatPause for history: it started as a single
// on/off pause flag, and renaming a Durable Object class takes a multi-deploy migration on Cloudflare's
// side, which isn't worth it for a name. Read once per incoming update (memoized in bot.ts), so it's kept
// to one tiny table and one SELECT.
export class ChatPause extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.migrate();
  }

  // Same _schema_migrations approach as the StockMarket DO: CREATE TABLE IF NOT EXISTS is a no-op against
  // an already-deployed table, so schema changes need real migrations.
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

    if (version < 3) {
      // The single pause flag becomes per-feature switches. A paused chat had the market and every rude
      // reply silenced, with Wordle and the been/bean counter still running — carried over as exactly
      // those switches off. A chat resumed via /startmarket keeps its resume time as market's
      // changed_at, so the ghost purge grace period it started carries over too.
      this.ctx.storage.sql.exec(`
        CREATE TABLE features (
          key TEXT PRIMARY KEY,
          enabled INTEGER NOT NULL,
          changed_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      const pause = this.ctx.storage.sql
        .exec<{ paused: number; resumed_at: string | null }>(`SELECT paused, resumed_at FROM pause WHERE id = 1`)
        .toArray()[0];
      if (pause?.paused === 1) {
        for (const key of ["market", "replies", "eastereggs", "spicy"]) {
          this.ctx.storage.sql.exec(`INSERT INTO features (key, enabled) VALUES (?, 0)`, key);
        }
      } else if (pause?.resumed_at) {
        this.ctx.storage.sql.exec(`INSERT INTO features (key, enabled, changed_at) VALUES ('market', 1, ?)`, pause.resumed_at);
      }
      this.ctx.storage.sql.exec(`DROP TABLE pause`);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (3)`);
    }
  }

  async getFeatureOverrides(): Promise<FeatureOverride[]> {
    return this.ctx.storage.sql
      .exec<{ key: string; enabled: number; changed_at_epoch_sec: number }>(
        `SELECT key, enabled, CAST(strftime('%s', changed_at) AS INTEGER) as changed_at_epoch_sec FROM features`
      )
      .toArray()
      .map((row) => ({ key: row.key, enabled: row.enabled === 1, changedAtEpochSec: row.changed_at_epoch_sec }));
  }

  // changed_at only moves when the switch actually flips, so re-sending the same value doesn't restart
  // anything keyed off it (the market's ghost purge grace period).
  async setFeature(key: string, enabled: boolean): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO features (key, enabled) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET
         changed_at = CASE WHEN enabled != excluded.enabled THEN datetime('now') ELSE changed_at END,
         enabled = excluded.enabled`,
      key,
      enabled ? 1 : 0
    );
  }
}
