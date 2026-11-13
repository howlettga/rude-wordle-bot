import { Api } from "grammy";
import { RudeBot } from "./bot.js";
import { BeenCounter } from "./durable-objects/been-counter.js";
import { BeanCounter } from "./durable-objects/bean-counter.js";
import { SpankChain } from "./durable-objects/spank-chain.js";
import { WordleGolf } from "./durable-objects/wordle-golf.js";
import { WordleGolfRegistry } from "./durable-objects/wordle-golf-registry.js";
import { StockMarket } from "./durable-objects/stock-market.js";
import { StockMarketRegistry } from "./durable-objects/stock-market-registry.js";
import { ChatPause } from "./durable-objects/chat-pause.js";
import { RudeMessages } from "./durable-objects/rude-messages.js";
import { StorageService } from "./storage-service.js";
import { WordleGolfComposer } from "./wordle-golf.js";
import { StockMarketComposer } from "./stock-market.js";
import { easternParts } from "./eastern-time.js";

export { BeenCounter, BeanCounter, SpankChain, WordleGolf, WordleGolfRegistry, StockMarket, StockMarketRegistry, ChatPause, RudeMessages };

// Cron Triggers are UTC-only, and every job here is scheduled in Eastern time, which shifts an hour
// against UTC across DST. So wrangler.jsonc runs a single hourly trigger, and scheduled() below works out
// the Eastern hour itself and runs whichever jobs are due. The 20-odd idle runs a day exit before touching
// any storage.
const MIDNIGHT_ET = 0;
// Split out from midnight — nobody's awake to see a halt announcement land at midnight.
const MORNING_ET = 8;
// The exact boundary tradingDayStart computes in the stock market DO, and the only time long-call
// options ever settle.
const OPTIONS_SETTLEMENT_ET = 17;

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
  CHAT_PAUSE: DurableObjectNamespace<ChatPause>;
  RUDE_MESSAGES: DurableObjectNamespace<RudeMessages>;
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
    env.STOCK_MARKET_REGISTRY,
    env.CHAT_PAUSE,
    env.RUDE_MESSAGES
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
  // scheduledTime (not the current time) so a trigger delivered a few seconds late still reads as the
  // hour it was scheduled for.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const { hour, weekday } = easternParts(new Date(controller.scheduledTime));
    if (hour !== MIDNIGHT_ET && hour !== MORNING_ET && hour !== OPTIONS_SETTLEMENT_ET) {
      return;
    }

    const storage = buildStorage(env);
    const api = new Api(env.BOT_TOKEN);
    const composer = new StockMarketComposer(storage);

    if (hour === MIDNIGHT_ET) {
      // Wordle Golf's reminder/finalize sweep has to run after NYT's midnight-ET puzzle rollover, so it
      // sees the new day's puzzle and counts yesterday as a completed hole. Monday's run also pays out
      // the weekly cash allowance.
      await Promise.all([
        new WordleGolfComposer(storage).runDailyCheck(api),
        composer.runDailyDecay(),
        ...(weekday === "Mon" ? [composer.runWeeklyAllowance()] : []),
      ]);
    } else if (hour === MORNING_ET) {
      // By 8am, midnight's decay run has already settled, so the halt check naturally picks its leader
      // off the day's post-decay standings for free. The daily data purge rides along since it's pure
      // storage mutation with nothing to announce.
      await Promise.all([composer.runDailyHaltCheck(api), composer.runDailyCleanup()]);
    } else {
      await composer.runOptionsSettlement(api);
    }
  },
};
