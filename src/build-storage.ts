import type { Env } from "./main.js";
import { StorageService } from "./storage-service.js";

// One StorageService over every Durable Object binding. Shared by main.ts (the webhook and the cron jobs) and the
// store page's API (webapp/api.ts), so both reach the same per-chat objects.
export function buildStorage(env: Env): StorageService {
  return new StorageService(
    env.BEEN_COUNTER,
    env.BEAN_COUNTER,
    env.SPANK_CHAIN,
    env.WORDLE_GOLF,
    env.WORDLE_GOLF_REGISTRY,
    env.STOCK_MARKET,
    env.STOCK_MARKET_REGISTRY,
    env.CHAT_PAUSE,
    env.RUDE_MESSAGES,
    env.FISHING,
    env.PET,
    env.PET_REGISTRY,
    env.STORE
  );
}
