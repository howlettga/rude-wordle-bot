import { RudeBot } from "./bot.js";
import { BeenCounter } from "./been-counter.js";
import { SpankChain } from "./spank-chain.js";
import { StorageService } from "./storage-service.js";

export { BeenCounter, SpankChain };

export interface Env {
  BOT_TOKEN: string;
  BOT_INFO: string;
  BEEN_COUNTER: DurableObjectNamespace<BeenCounter>;
  SPANK_CHAIN: DurableObjectNamespace<SpankChain>;
  OWNER_CHAT_ID?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const ownerChatId = env.OWNER_CHAT_ID ? Number(env.OWNER_CHAT_ID) : undefined;
    const storage = new StorageService(env.BEEN_COUNTER, env.SPANK_CHAIN);

    const bot = new RudeBot(env.BOT_TOKEN, JSON.parse(env.BOT_INFO), storage, ownerChatId);
    return bot.handleUpdate(request);
  },
};
