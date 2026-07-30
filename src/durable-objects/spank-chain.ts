import { DurableObject } from "cloudflare:workers";
import type { Env } from "../main.js";

export class SpankChain extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS chain (id INTEGER PRIMARY KEY, tail_message_id INTEGER)`
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO chain (id, tail_message_id) VALUES (1, NULL) ON CONFLICT(id) DO NOTHING`
    );
  }

  async isTail(messageId: number): Promise<boolean> {
    const row = this.ctx.storage.sql
      .exec<{ tail_message_id: number | null }>(`SELECT tail_message_id FROM chain WHERE id = 1`)
      .one();
    return row.tail_message_id === messageId;
  }

  async setTail(messageId: number): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO chain (id, tail_message_id) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET tail_message_id = ?`,
      messageId,
      messageId
    );
  }
}