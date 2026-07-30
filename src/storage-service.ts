import type { BeenCounter } from "./durable-objects/been-counter.js";
import type { SpankChain } from "./durable-objects/spank-chain.js";
import type {
  WordleGolf,
  WordleGolfGame,
  WordleGolfScorecard,
  WordleGolfLeaderboardEntry,
  WordleGolfSubmitResult,
} from "./durable-objects/wordle-golf.js";
import type { WordleGolfRegistry } from "./durable-objects/wordle-golf-registry.js";

export class StorageService {
  constructor(
    private beenCounterNs: DurableObjectNamespace<BeenCounter>,
    private spankChainNs: DurableObjectNamespace<SpankChain>,
    private wordleGolfNs: DurableObjectNamespace<WordleGolf>,
    private wordleGolfRegistryNs: DurableObjectNamespace<WordleGolfRegistry>
  ) {}

  incrementBeenCounter(name: string, by: number = 1): Promise<number> {
    const stub = this.beenCounterNs.get(this.beenCounterNs.idFromName(name));
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
}