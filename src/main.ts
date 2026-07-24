import { RudeBot } from "./bot.js";

interface Env {
  BOT_TOKEN: string;
  BOT_INFO: string;
  OWNER_CHAT_ID?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const ownerChatId = env.OWNER_CHAT_ID ? Number(env.OWNER_CHAT_ID) : undefined;
    const bot = new RudeBot(env.BOT_TOKEN, JSON.parse(env.BOT_INFO), ownerChatId);
    return bot.handleUpdate(request);
  },
};