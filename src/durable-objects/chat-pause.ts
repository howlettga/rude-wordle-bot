import { DurableObject } from "cloudflare:workers";
import type { Env } from "../main.js";

export class ChatPause extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS pause (id INTEGER PRIMARY KEY, paused INTEGER NOT NULL)`
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO pause (id, paused) VALUES (1, 0) ON CONFLICT(id) DO NOTHING`
    );
  }

  async isPaused(): Promise<boolean> {
    const row = this.ctx.storage.sql
      .exec<{ paused: number }>(`SELECT paused FROM pause WHERE id = 1`)
      .one();
    return row.paused === 1;
  }

  async setPaused(paused: boolean): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO pause (id, paused) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET paused = ?`,
      paused ? 1 : 0,
      paused ? 1 : 0
    );
  }
}
