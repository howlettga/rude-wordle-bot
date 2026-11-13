import { DurableObject } from "cloudflare:workers";
import type { Env } from "../main.js";

// Message ids of every reply the rude composers (rude.ts) have sent in this chat. Telegram gives us no way
// to tag a sent message with our own metadata, so this is how the fallback retort tells "someone replied
// to one of the bot's jokes" apart from "someone replied to a Wordle reminder or market announcement" —
// it only answers the former. Only written when the bot actually sends a rude reply, and only read when
// someone replies to a bot message, so it never touches the ordinary per-message path.
const RETENTION_DAYS = 30;

export class RudeMessages extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        message_id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  // Ages out old ids on the way in rather than via a cron — writes are rare (one per rude reply), and
  // nobody's replying to a month-old joke.
  async record(messageId: number): Promise<void> {
    this.ctx.storage.sql.exec(`INSERT INTO messages (message_id) VALUES (?) ON CONFLICT(message_id) DO NOTHING`, messageId);
    this.ctx.storage.sql.exec(`DELETE FROM messages WHERE created_at < datetime('now', '-${RETENTION_DAYS} days')`);
  }

  async has(messageId: number): Promise<boolean> {
    return this.ctx.storage.sql.exec(`SELECT 1 FROM messages WHERE message_id = ?`, messageId).toArray().length > 0;
  }
}
