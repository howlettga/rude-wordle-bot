import { DurableObject } from "cloudflare:workers";
import type { Env } from "./main.js";

export class BeenCounter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)`
    );
  }

  async increment(by: number = 1): Promise<number> {
    const row = this.ctx.storage.sql
      .exec<{ value: number }>(
        `INSERT INTO counter (id, value) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET value = value + ?
         RETURNING value`,
        by,
        by
      )
      .one();
    return row.value;
  }
}