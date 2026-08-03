import { Api } from "grammy";
import { RudeBot } from "./bot.js";
import { BeenCounter } from "./durable-objects/been-counter.js";
import { BeanCounter } from "./durable-objects/bean-counter.js";
import { SpankChain } from "./durable-objects/spank-chain.js";
import { WordleGolf } from "./durable-objects/wordle-golf.js";
import { WordleGolfRegistry } from "./durable-objects/wordle-golf-registry.js";
import { StockMarket } from "./durable-objects/stock-market.js";
import { StockMarketRegistry } from "./durable-objects/stock-market-registry.js";
import { StorageService } from "./storage-service.js";
import { WordleGolfComposer } from "./wordle-golf.js";
import { StockMarketComposer } from "./stock-market.js";

export { BeenCounter, BeanCounter, SpankChain, WordleGolf, WordleGolfRegistry, StockMarket, StockMarketRegistry };

// Must match wrangler.jsonc's triggers.crons exactly — that's what ScheduledController.cron is compared
// against below to tell the daily sweep apart from the weekly one.
const DAILY_CRON = "0 13 * * *";
const WEEKLY_CRON = "0 13 * * 1";

export interface Env {
  BOT_TOKEN: string;
  BOT_INFO: string;
  BEEN_COUNTER: DurableObjectNamespace<BeenCounter>;
  BEAN_COUNTER: DurableObjectNamespace<BeanCounter>;
  SPANK_CHAIN: DurableObjectNamespace<SpankChain>;
  WORDLE_GOLF: DurableObjectNamespace<WordleGolf>;
  WORDLE_GOLF_REGISTRY: DurableObjectNamespace<WordleGolfRegistry>;
  STOCK_MARKET: DurableObjectNamespace<StockMarket>;
  STOCK_MARKET_REGISTRY: DurableObjectNamespace<StockMarketRegistry>;
  OWNER_CHAT_ID?: string;
}

function buildStorage(env: Env): StorageService {
  return new StorageService(
    env.BEEN_COUNTER,
    env.BEAN_COUNTER,
    env.SPANK_CHAIN,
    env.WORDLE_GOLF,
    env.WORDLE_GOLF_REGISTRY,
    env.STOCK_MARKET,
    env.STOCK_MARKET_REGISTRY
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const ownerChatId = env.OWNER_CHAT_ID ? Number(env.OWNER_CHAT_ID) : undefined;
    const bot = new RudeBot(env.BOT_TOKEN, JSON.parse(env.BOT_INFO), buildStorage(env), ownerChatId);
    return bot.handleUpdate(request);
  },

  // Not triggered by a Telegram update, so there's no webhook request to build a RudeBot from — just the
  // pieces each job actually needs.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const storage = buildStorage(env);

    if (controller.cron === DAILY_CRON) {
      const api = new Api(env.BOT_TOKEN);
      await Promise.all([new WordleGolfComposer(storage).runDailyCheck(api), new StockMarketComposer(storage).runDailyDecay()]);
    } else if (controller.cron === WEEKLY_CRON) {
      await new StockMarketComposer(storage).runWeeklyAllowance();
    }
  },
};
