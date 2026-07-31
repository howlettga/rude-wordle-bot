import { DurableObject } from "cloudflare:workers";
import type { Env } from "../main.js";

// A single global instance (always addressed via idFromName("global")). Same problem as WordleGolfRegistry:
// Durable Object namespaces have no "list all instances" API, so the daily decay / weekly allowance jobs
// need some way to know which chats have a StockMarket. Kept separate from WordleGolfRegistry rather than
// shared, since the two features register a chat at different moments (round start vs. first message ever).
export class StockMarketRegistry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS chats (chat_id INTEGER PRIMARY KEY)`);
  }

  async register(chatId: number): Promise<void> {
    this.ctx.storage.sql.exec(`INSERT INTO chats (chat_id) VALUES (?) ON CONFLICT(chat_id) DO NOTHING`, chatId);
  }

  async list(): Promise<number[]> {
    return this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; chat_id: number }>(`SELECT chat_id FROM chats`)
      .toArray()
      .map((row) => row.chat_id);
  }
}
