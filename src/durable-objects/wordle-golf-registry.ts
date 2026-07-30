import { DurableObject } from "cloudflare:workers";
import type { Env } from "../main.js";

// A single global instance (always addressed via idFromName("global")). Durable Object namespaces have no
// "list all instances" API, so the daily scheduled check needs some way to know which chats have ever
// started a round — this is that index, separate from any one chat's own WordleGolf data.
export class WordleGolfRegistry extends DurableObject<Env> {
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
