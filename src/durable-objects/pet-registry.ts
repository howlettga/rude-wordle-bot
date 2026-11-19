import { DurableObject } from "cloudflare:workers";
import type { Env } from "../main.js";

// A single global instance (always addressed via idFromName("global")), same pattern as
// WordleGolfRegistry: Durable Object namespaces can't list their instances, so the hourly pet check needs
// this index of which chats have ever adopted a pet.
export class PetRegistry extends DurableObject<Env> {
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
