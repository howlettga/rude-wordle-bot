import type { BeenCounter } from "./durable-objects/been-counter.js";
import type { BeanCounter } from "./durable-objects/bean-counter.js";
import type { SpankChain } from "./durable-objects/spank-chain.js";
import type {
  WordleGolf,
  WordleGolfGame,
  WordleGolfScorecard,
  WordleGolfLeaderboardEntry,
  WordleGolfSubmitResult,
} from "./durable-objects/wordle-golf.js";
import type { WordleGolfRegistry } from "./durable-objects/wordle-golf-registry.js";
import type { StockMarket, StockMarketPlayer, StockMarketPortfolio, StockMarketTradeResult } from "./durable-objects/stock-market.js";
import type { StockMarketRegistry } from "./durable-objects/stock-market-registry.js";

export class StorageService {
  constructor(
    private beenCounterNs: DurableObjectNamespace<BeenCounter>,
    private beanCounterNs: DurableObjectNamespace<BeanCounter>,
    private spankChainNs: DurableObjectNamespace<SpankChain>,
    private wordleGolfNs: DurableObjectNamespace<WordleGolf>,
    private wordleGolfRegistryNs: DurableObjectNamespace<WordleGolfRegistry>,
    private stockMarketNs: DurableObjectNamespace<StockMarket>,
    private stockMarketRegistryNs: DurableObjectNamespace<StockMarketRegistry>
  ) {}

  incrementBeenCounter(name: string, by: number = 1): Promise<number> {
    const stub = this.beenCounterNs.get(this.beenCounterNs.idFromName(name));
    return stub.increment(by);
  }

  incrementBeanCounter(name: string, by: number = 1): Promise<number> {
    const stub = this.beanCounterNs.get(this.beanCounterNs.idFromName(name));
    return stub.increment(by);
  }

  isSpankChainTail(chatId: number, messageId: number): Promise<boolean> {
    const stub = this.spankChainNs.get(this.spankChainNs.idFromName(`spank_chain_${chatId}`));
    return stub.isTail(messageId);
  }

  setSpankChainTail(chatId: number, messageId: number): Promise<void> {
    const stub = this.spankChainNs.get(this.spankChainNs.idFromName(`spank_chain_${chatId}`));
    return stub.setTail(messageId);
  }

  getActiveWordleGolfGame(chatId: number): Promise<WordleGolfGame | null> {
    return this.wordleGolfStub(chatId).getActiveGame();
  }

  async startWordleGolfGame(
    chatId: number,
    config: { threadId?: number; holes: number; mulligans: number; startDate: string; initialPuzzleNumber: number }
  ): Promise<WordleGolfGame> {
    const [game] = await Promise.all([this.wordleGolfStub(chatId).startGame(config), this.registerWordleGolfChat(chatId)]);
    return game;
  }

  registerWordleGolfChat(chatId: number): Promise<void> {
    const stub = this.wordleGolfRegistryNs.get(this.wordleGolfRegistryNs.idFromName("global"));
    return stub.register(chatId);
  }

  listWordleGolfChats(): Promise<number[]> {
    const stub = this.wordleGolfRegistryNs.get(this.wordleGolfRegistryNs.idFromName("global"));
    return stub.list();
  }

  submitWordleGolfScore(
    chatId: number,
    input: {
      userId: number;
      username?: string;
      firstName: string;
      puzzleNumber: number;
      scoreValue: number;
      scoreLabel: string;
      rawMessage?: string;
    }
  ): Promise<WordleGolfSubmitResult> {
    return this.wordleGolfStub(chatId).submitScore(input);
  }

  getWordleGolfScorecard(chatId: number, gameId: number): Promise<WordleGolfScorecard> {
    return this.wordleGolfStub(chatId).getScorecard(gameId);
  }

  finalizeWordleGolfGame(chatId: number, gameId: number): Promise<WordleGolfScorecard> {
    return this.wordleGolfStub(chatId).finalizeGame(gameId);
  }

  backfillMissedWordleGolfDays(chatId: number, closedHoles: number): Promise<void> {
    return this.wordleGolfStub(chatId).backfillMissedDays(closedHoles);
  }

  getWordleGolfLeaderboard(chatId: number): Promise<WordleGolfLeaderboardEntry[]> {
    return this.wordleGolfStub(chatId).getLeaderboard();
  }

  readWordleGolfSession(chatId: number): Promise<unknown> {
    return this.wordleGolfStub(chatId).readSession();
  }

  writeWordleGolfSession(chatId: number, state: unknown): Promise<void> {
    return this.wordleGolfStub(chatId).writeSession(state);
  }

  deleteWordleGolfSession(chatId: number): Promise<void> {
    return this.wordleGolfStub(chatId).deleteSession();
  }

  private wordleGolfStub(chatId: number) {
    return this.wordleGolfNs.get(this.wordleGolfNs.idFromName(`wordle_golf_${chatId}`));
  }

  async recordStockMarketMessage(
    chatId: number,
    input: { messageId: number; userId: number; username?: string; firstName: string }
  ): Promise<void> {
    await Promise.all([this.stockMarketStub(chatId).recordMessage(input), this.registerStockMarketChat(chatId)]);
  }

  recordStockMarketReply(
    chatId: number,
    input: { recipientUserId: number; recipientUsername?: string; recipientFirstName: string; replierUserId: number }
  ): Promise<void> {
    return this.stockMarketStub(chatId).recordReply(input);
  }

  recordStockMarketReaction(chatId: number, input: { messageId: number; reactorUserId: number; emoji: string }): Promise<void> {
    return this.stockMarketStub(chatId).recordReaction(input);
  }

  getStockMarketPortfolio(chatId: number, userId: number): Promise<StockMarketPortfolio | null> {
    return this.stockMarketStub(chatId).getPortfolio(userId);
  }

  getStockMarket(chatId: number): Promise<StockMarketPlayer[]> {
    return this.stockMarketStub(chatId).getMarket();
  }

  findStockMarketPlayerByUsername(chatId: number, username: string): Promise<StockMarketPlayer | null> {
    return this.stockMarketStub(chatId).findPlayerByUsername(username);
  }

  getStockMarketPlayer(chatId: number, userId: number): Promise<StockMarketPlayer | null> {
    return this.stockMarketStub(chatId).getPlayer(userId);
  }

  purgeStockMarketGhostPlayers(chatId: number): Promise<void> {
    return this.stockMarketStub(chatId).purgeGhostPlayers();
  }

  buyStock(
    chatId: number,
    input: { buyerUserId: number; buyerUsername?: string; buyerFirstName: string; targetUserId: number; shares: number }
  ): Promise<StockMarketTradeResult> {
    return this.stockMarketStub(chatId).buy(input);
  }

  sellStock(chatId: number, input: { sellerUserId: number; targetUserId: number; shares: number }): Promise<StockMarketTradeResult> {
    return this.stockMarketStub(chatId).sell(input);
  }

  registerStockMarketChat(chatId: number): Promise<void> {
    const stub = this.stockMarketRegistryNs.get(this.stockMarketRegistryNs.idFromName("global"));
    return stub.register(chatId);
  }

  listStockMarketChats(): Promise<number[]> {
    const stub = this.stockMarketRegistryNs.get(this.stockMarketRegistryNs.idFromName("global"));
    return stub.list();
  }

  applyStockMarketWeeklyAllowance(chatId: number): Promise<void> {
    return this.stockMarketStub(chatId).applyWeeklyAllowance();
  }

  applyStockMarketDailyDecay(chatId: number): Promise<void> {
    return this.stockMarketStub(chatId).applyDailyDecay();
  }

  purgeStockMarketOldData(chatId: number): Promise<void> {
    return this.stockMarketStub(chatId).purgeOldData();
  }

  private stockMarketStub(chatId: number) {
    return this.stockMarketNs.get(this.stockMarketNs.idFromName(`stock_market_${chatId}`));
  }
}