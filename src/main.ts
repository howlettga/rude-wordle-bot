import { Api } from "grammy";
import { RudeBot } from "./bot.js";
import { BeenCounter } from "./durable-objects/been-counter.js";
import { SpankChain } from "./durable-objects/spank-chain.js";
import { WordleGolf } from "./durable-objects/wordle-golf.js";
import { WordleGolfRegistry } from "./durable-objects/wordle-golf-registry.js";
import { StorageService } from "./storage-service.js";
import { WordleGolfComposer } from "./wordle-golf.js";

export { BeenCounter, SpankChain, WordleGolf, WordleGolfRegistry };

export interface Env {
  BOT_TOKEN: string;
  BOT_INFO: string;
  BEEN_COUNTER: DurableObjectNamespace<BeenCounter>;
  SPANK_CHAIN: DurableObjectNamespace<SpankChain>;
  WORDLE_GOLF: DurableObjectNamespace<WordleGolf>;
  WORDLE_GOLF_REGISTRY: DurableObjectNamespace<WordleGolfRegistry>;
  OWNER_CHAT_ID?: string;
}

function buildStorage(env: Env): StorageService {
  return new StorageService(env.BEEN_COUNTER, env.SPANK_CHAIN, env.WORDLE_GOLF, env.WORDLE_GOLF_REGISTRY);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const ownerChatId = env.OWNER_CHAT_ID ? Number(env.OWNER_CHAT_ID) : undefined;
    const bot = new RudeBot(env.BOT_TOKEN, JSON.parse(env.BOT_INFO), buildStorage(env), ownerChatId);
    return bot.handleUpdate(request);
  },

  // Not triggered by a Telegram update, so there's no webhook request to build a RudeBot from — just the
  // pieces this actually needs: an Api client to send messages with, and the Wordle Golf domain logic.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const api = new Api(env.BOT_TOKEN);
    await new WordleGolfComposer(buildStorage(env)).runDailyCheck(api);
  },
};
