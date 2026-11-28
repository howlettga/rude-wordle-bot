import type { BeenCounter } from "./durable-objects/been-counter.js";
import type { BeanCounter } from "./durable-objects/bean-counter.js";
import type { SpankChain } from "./durable-objects/spank-chain.js";
import type { ChatPause } from "./durable-objects/chat-pause.js";
import type { RudeMessages } from "./durable-objects/rude-messages.js";
import type {
  AnglerStatus,
  BottleListing,
  FishPick,
  FishUse,
  Fishing,
  FishingCastResult,
  BucketFish,
  FishingLeaderboard,
  HeldFish,
  TakeFishByIdResult,
  ThrowBottleResult,
} from "./durable-objects/fishing.js";
import type {
  Store,
  StoreBuyResult,
  StoreCard,
  StoreChargeResult,
  StoreItem,
  StoreSaleResult,
  StoreTapResult,
  TideChartBuyResult,
} from "./durable-objects/store.js";
import type { BottleDistance } from "./bottles.js";
import type { AnglerGear } from "./gear.js";
import type { CastGear } from "./fishing-math.js";
import type {
  Pet,
  PetAdoptResult,
  PetFundDonateResult,
  PetFundStatus,
  PetGraveyardEntry,
  PetInteractResult,
  PetKillResult,
  PetLookup,
  PetPeek,
  PetStatus,
  PetTickResult,
} from "./durable-objects/pet.js";
import type { PetRegistry } from "./durable-objects/pet-registry.js";
import { type FeatureKey, type FeatureFlags, resolveFeatures } from "./features.js";
import type {
  WordleGolf,
  WordleGolfGame,
  WordleGolfScorecard,
  WordleGolfLeaderboardEntry,
  WordleGolfSubmitResult,
} from "./durable-objects/wordle-golf.js";
import type { WordleGolfRegistry } from "./durable-objects/wordle-golf-registry.js";
import type {
  StockMarket,
  StockMarketPlayer,
  StockMarketPortfolio,
  StockMarketTradeResult,
  StockMarketSetTickerResult,
  StockMarketOptionStrikePct,
  StockMarketOptionDurationDays,
  StockMarketOptionQuote,
  StockMarketBuyOptionResult,
  StockMarketOptionSettlement,
} from "./durable-objects/stock-market.js";
import type { StockMarketRegistry } from "./durable-objects/stock-market-registry.js";

export class StorageService {
  constructor(
    private beenCounterNs: DurableObjectNamespace<BeenCounter>,
    private beanCounterNs: DurableObjectNamespace<BeanCounter>,
    private spankChainNs: DurableObjectNamespace<SpankChain>,
    private wordleGolfNs: DurableObjectNamespace<WordleGolf>,
    private wordleGolfRegistryNs: DurableObjectNamespace<WordleGolfRegistry>,
    private stockMarketNs: DurableObjectNamespace<StockMarket>,
    private stockMarketRegistryNs: DurableObjectNamespace<StockMarketRegistry>,
    private chatPauseNs: DurableObjectNamespace<ChatPause>,
    private rudeMessagesNs: DurableObjectNamespace<RudeMessages>,
    private fishingNs: DurableObjectNamespace<Fishing>,
    private petNs: DurableObjectNamespace<Pet>,
    private petRegistryNs: DurableObjectNamespace<PetRegistry>,
    private storeNs: DurableObjectNamespace<Store>
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
    input: { messageId: number; userId: number; username?: string; firstName: string; threadId?: number }
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

  findStockMarketPlayerByTicker(chatId: number, ticker: string): Promise<StockMarketPlayer | null> {
    return this.stockMarketStub(chatId).findPlayerByTicker(ticker);
  }

  setStockMarketTicker(chatId: number, userId: number, ticker: string): Promise<StockMarketSetTickerResult> {
    return this.stockMarketStub(chatId).setTicker(userId, ticker);
  }

  getStockMarketPlayer(chatId: number, userId: number): Promise<StockMarketPlayer | null> {
    return this.stockMarketStub(chatId).getPlayer(userId);
  }

  delistStockMarketPlayer(chatId: number, userId: number): Promise<boolean> {
    return this.stockMarketStub(chatId).delist(userId);
  }

  resetStockMarketPlayer(chatId: number, userId: number): Promise<boolean> {
    return this.stockMarketStub(chatId).reset(userId);
  }

  restartStockMarket(chatId: number): Promise<void> {
    return this.stockMarketStub(chatId).restart();
  }

  setStockMarketAnnouncementThread(chatId: number, threadId: number | null): Promise<void> {
    return this.stockMarketStub(chatId).setAnnouncementThread(threadId);
  }

  getStockMarketAnnouncementThread(chatId: number): Promise<number | null> {
    return this.stockMarketStub(chatId).getAnnouncementThread();
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

  quoteStockMarketOption(
    chatId: number,
    underlyingUserId: number,
    strikePct: StockMarketOptionStrikePct,
    durationDays: StockMarketOptionDurationDays
  ): Promise<StockMarketOptionQuote | null> {
    return this.stockMarketStub(chatId).quoteOption(underlyingUserId, strikePct, durationDays);
  }

  buyStockMarketOption(
    chatId: number,
    input: {
      buyerUserId: number;
      buyerUsername?: string;
      buyerFirstName: string;
      underlyingUserId: number;
      strikePct: StockMarketOptionStrikePct;
      durationDays: StockMarketOptionDurationDays;
    }
  ): Promise<StockMarketBuyOptionResult> {
    return this.stockMarketStub(chatId).buyOption(input);
  }

  settleStockMarketOptions(chatId: number): Promise<StockMarketOptionSettlement[]> {
    return this.stockMarketStub(chatId).settleExpiredOptions();
  }

  setStockMarketOptionsGuard(chatId: number, enabled: boolean): Promise<void> {
    return this.stockMarketStub(chatId).setOptionsSelfPumpGuard(enabled);
  }

  getStockMarketOptionsGuard(chatId: number): Promise<boolean> {
    return this.stockMarketStub(chatId).getOptionsSelfPumpGuard();
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

  awardStockMarketCash(chatId: number, userId: number, amount: number): Promise<void> {
    return this.stockMarketStub(chatId).awardCash(userId, amount);
  }

  stimulusStockMarket(chatId: number, amount: number): Promise<number> {
    return this.stockMarketStub(chatId).stimulus(amount);
  }

  getStockMarketThreadSilenceGap(
    chatId: number,
    threadId: number | null
  ): Promise<
    | {
        userId: number;
        firstName: string;
        ticker: string | null;
        messageId: number;
        lastEpochSec: number;
        nowEpochSec: number;
        hasReaction: boolean;
      }
    | null
  > {
    return this.stockMarketStub(chatId).getThreadSilenceGap(threadId);
  }

  getStockMarketChatSilenceGap(chatId: number): Promise<{ userId: number; lastEpochSec: number; nowEpochSec: number } | null> {
    return this.stockMarketStub(chatId).getChatSilenceGap();
  }

  claimStockMarketNecromancy(chatId: number, messageId: number): Promise<boolean> {
    return this.stockMarketStub(chatId).claimNecromancy(messageId);
  }

  applyStockMarketDailyDecay(chatId: number): Promise<void> {
    return this.stockMarketStub(chatId).applyDailyDecay();
  }

  rollStockMarketHalt(chatId: number): Promise<{ userId: number; firstName: string; ticker: string | null } | null> {
    return this.stockMarketStub(chatId).rollHalt();
  }

  purgeStockMarketOldData(chatId: number): Promise<void> {
    return this.stockMarketStub(chatId).purgeOldData();
  }

  private stockMarketStub(chatId: number) {
    return this.stockMarketNs.get(this.stockMarketNs.idFromName(`stock_market_${chatId}`));
  }

  // Every feature's switch for this chat, defaults filled in — one Durable Object call no matter how many
  // features there are.
  async getChatFeatures(chatId: number): Promise<FeatureFlags> {
    return resolveFeatures(await this.chatPauseStub(chatId).getFeatureOverrides());
  }

  setChatFeature(chatId: number, key: FeatureKey, enabled: boolean): Promise<void> {
    return this.chatPauseStub(chatId).setFeature(key, enabled);
  }

  // The `chat_pause_` id prefix predates feature switches — changing it would orphan every chat's
  // existing switches, so it stays.
  private chatPauseStub(chatId: number) {
    return this.chatPauseNs.get(this.chatPauseNs.idFromName(`chat_pause_${chatId}`));
  }

  recordRudeMessage(chatId: number, messageId: number): Promise<void> {
    return this.rudeMessagesStub(chatId).record(messageId);
  }

  isRudeMessage(chatId: number, messageId: number): Promise<boolean> {
    return this.rudeMessagesStub(chatId).has(messageId);
  }

  private rudeMessagesStub(chatId: number) {
    return this.rudeMessagesNs.get(this.rudeMessagesNs.idFromName(`rude_messages_${chatId}`));
  }

  castFishing(chatId: number, input: { userId: number; username?: string; firstName: string; gear?: CastGear }): Promise<FishingCastResult> {
    return this.fishingStub(chatId).cast({ ...input, chatId });
  }

  getFishingLeaderboard(chatId: number): Promise<FishingLeaderboard> {
    return this.fishingStub(chatId).getLeaderboard();
  }

  setFishingWindow(chatId: number, days: number | null): Promise<void> {
    return this.fishingStub(chatId).setWindow(days);
  }

  resetFishing(chatId: number): Promise<void> {
    return this.fishingStub(chatId).reset();
  }

  takeFish(chatId: number, userId: number, size: FishPick, usedFor: string, use: FishUse = "eaten"): Promise<HeldFish | null> {
    return this.fishingStub(chatId).takeFish(userId, size, usedFor, use);
  }

  takeFishById(chatId: number, userId: number, fishId: number, usedFor: string, use: FishUse): Promise<TakeFishByIdResult> {
    return this.fishingStub(chatId).takeFishById(userId, fishId, usedFor, use);
  }

  getFishBucket(chatId: number, userId: number): Promise<BucketFish[]> {
    return this.fishingStub(chatId).bucket(userId);
  }

  returnFish(chatId: number, fishId: number): Promise<void> {
    return this.fishingStub(chatId).returnFish(fishId);
  }

  throwBottle(
    chatId: number,
    input: { authorId: number; authorName: string; text: string; distance: BottleDistance }
  ): Promise<ThrowBottleResult> {
    return this.fishingStub(chatId).throwBottle(input);
  }

  countBottlesInWater(chatId: number, authorId: number): Promise<number> {
    return this.fishingStub(chatId).bottlesInWater(authorId);
  }

  listBottles(chatId: number): Promise<BottleListing> {
    return this.fishingStub(chatId).listBottles();
  }

  removeBottle(chatId: number, bottleId: number): Promise<boolean> {
    return this.fishingStub(chatId).removeBottle(bottleId);
  }

  getBottleAuthor(chatId: number, bottleId: number): Promise<{ authorName: string; authorId: number } | null> {
    return this.fishingStub(chatId).bottleAuthor(bottleId);
  }

  getAnglerStatus(chatId: number, userId: number): Promise<AnglerStatus> {
    return this.fishingStub(chatId).anglerStatus(userId);
  }

  private fishingStub(chatId: number) {
    return this.fishingNs.get(this.fishingNs.idFromName(`fishing_${chatId}`));
  }

  getStoreCard(chatId: number): Promise<StoreCard> {
    return this.storeStub(chatId).card(chatId);
  }

  quoteFish(chatId: number, fish: { species: string; weight: number }): Promise<number> {
    return this.storeStub(chatId).quoteFish(chatId, fish);
  }

  quoteFishes(chatId: number, fish: { species: string; weight: number }[]): Promise<number[]> {
    return this.storeStub(chatId).quoteFishes(chatId, fish);
  }

  sellFish(chatId: number, input: { userId: number; firstName: string; fish: HeldFish; bonus?: number }): Promise<StoreSaleResult> {
    return this.storeStub(chatId).sellFish({ ...input, chatId });
  }

  getWallet(chatId: number, userId: number): Promise<{ balance: number; gear: AnglerGear }> {
    return this.storeStub(chatId).wallet(userId);
  }

  getGear(chatId: number, userId: number): Promise<AnglerGear> {
    return this.storeStub(chatId).gear(userId);
  }

  useWorm(chatId: number, userId: number): Promise<void> {
    return this.storeStub(chatId).useWorm(userId);
  }

  tapStoreGear(chatId: number, input: { userId: number; firstName: string; item: StoreItem }): Promise<StoreTapResult> {
    return this.storeStub(chatId).tapGear(input);
  }

  buyStoreGear(chatId: number, input: { userId: number; firstName: string; item: StoreItem }): Promise<StoreBuyResult> {
    return this.storeStub(chatId).buyGear(input);
  }

  chargeWallet(
    chatId: number,
    input: { userId: number; firstName: string; amount: number; source: string; label: string }
  ): Promise<StoreChargeResult> {
    return this.storeStub(chatId).charge(input);
  }

  refundWallet(chatId: number, input: { userId: number; firstName: string; amount: number; source: string; label: string }): Promise<number> {
    return this.storeStub(chatId).refund(input);
  }

  buyTideChart(chatId: number, input: { userId: number; firstName: string }): Promise<TideChartBuyResult> {
    return this.storeStub(chatId).buyTideChart(input);
  }

  getChartUntil(chatId: number, userId: number): Promise<number | null> {
    return this.storeStub(chatId).chartUntil(userId);
  }

  recordStoreCard(chatId: number, messageId: number, threadId: number | null): Promise<void> {
    return this.storeStub(chatId).recordCard(messageId, threadId);
  }

  getLatestStoreCard(chatId: number): Promise<{ messageId: number; threadId: number | null } | null> {
    return this.storeStub(chatId).latestCard();
  }

  private storeStub(chatId: number) {
    return this.storeNs.get(this.storeNs.idFromName(`store_${chatId}`));
  }

  getPet(chatId: number): Promise<PetLookup> {
    return this.petStub(chatId).lookup();
  }

  adoptPet(chatId: number, input: Parameters<Pet["adopt"]>[0]): Promise<PetAdoptResult> {
    return this.petStub(chatId).adopt(input);
  }

  peekPet(chatId: number): Promise<PetPeek | null> {
    return this.petStub(chatId).peek();
  }

  interactWithPet(chatId: number, input: Parameters<Pet["interact"]>[0]): Promise<PetInteractResult> {
    return this.petStub(chatId).interact(input);
  }

  tickPet(chatId: number, awake: boolean): Promise<PetTickResult> {
    return this.petStub(chatId).tick(awake);
  }

  freezePet(chatId: number): Promise<void> {
    return this.petStub(chatId).freeze();
  }

  getPetGraveyard(chatId: number, limit: number): Promise<PetGraveyardEntry[]> {
    return this.petStub(chatId).graveyard(limit);
  }

  killPet(chatId: number, name?: string): Promise<PetKillResult> {
    return this.petStub(chatId).kill(name);
  }

  revivePet(chatId: number): Promise<PetStatus | null> {
    return this.petStub(chatId).revive();
  }

  getPetFund(chatId: number): Promise<PetFundStatus> {
    return this.petStub(chatId).fundStatus();
  }

  donateToPetFund(chatId: number, input: { userId: number; firstName: string; amount: number }): Promise<PetFundDonateResult> {
    return this.petStub(chatId).donateToFund(input);
  }

  private petStub(chatId: number) {
    return this.petNs.get(this.petNs.idFromName(`pet_${chatId}`));
  }

  registerPetChat(chatId: number): Promise<void> {
    return this.petRegistryNs.get(this.petRegistryNs.idFromName("global")).register(chatId);
  }

  listPetChats(): Promise<number[]> {
    return this.petRegistryNs.get(this.petRegistryNs.idFromName("global")).list();
  }
}