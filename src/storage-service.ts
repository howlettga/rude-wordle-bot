import type { BeenCounter } from "./been-counter.js";
import type { SpankChain } from "./spank-chain.js";

export class StorageService {
  constructor(
    private beenCounterNs: DurableObjectNamespace<BeenCounter>,
    private spankChainNs: DurableObjectNamespace<SpankChain>
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
}