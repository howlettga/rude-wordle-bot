import { Composer, InlineKeyboard } from "grammy";
import type { Api, Context } from "grammy";
import { createConversation } from "@grammyjs/conversations";
import type { Conversation } from "@grammyjs/conversations";
import { type MyContext, replyToMessage, replyHTML, isNotCommand, CONVERSATION_TIMEOUT_MS } from "./context.js";
import type { StorageService } from "./storage-service.js";
import type { PetAction, PetEulogy, PetFundStatus, PetInput, PetPeek, PetStatus, PetWarning } from "./durable-objects/pet.js";
import type { FishSize, HeldFish } from "./durable-objects/fishing.js";
import { PET_CONFIG, PET_TRICKS, foodForFish, rollSpecies } from "./pet-config.js";
import { easternParts, formatEasternDate } from "./eastern-time.js";
import { escapeHtml, random } from "./util.js";

// The "pet" feature (see features.ts): shared pets, kept alive by everyone. A chat starts with room for one;
// the pet fund on the store page buys room for more (see PET_FUND).
//   /adopt      -> when there's a free slot: reveals a random animal, then asks the adopter to name it
//   /pet        -> status card (food, mood) with Feed / Pet / Play buttons that update the card in place.
//                  With two or more pets, a summary of them all with a "check on" button each, which turns
//                  the same message into that pet's card (and "◀ All pets" turns it back)
//   /graveyard  -> past pets, how long they lived, and how they went
//   /petkill    -> owner-only: puts a pet down (mercy, or testing); needs its name if there are several
//   /petrevive  -> owner-only: brings the last dead pet back at full meters (in case a bug killed it)
// While the chat has fishing on, feeding costs one of the feeder's own fish: the card's Feed button is
// three — small, medium, large — each taking that size from the tapper's bucket (see Fishing.takeFish),
// with bigger fish worth more food (foodForFish). Nobody sees anyone else's bucket.
// The hourly check (runHourlyCheck) posts only the "it's dying" warning and announces deaths; hunger and
// loneliness show up as the pet begging in /fish replies instead (petDesireLine). Every number lives in
// pet-config.ts.
type ConversationContext = Context;
type MyConversation = Conversation<MyContext, ConversationContext>;

const ADOPT_CONVERSATION = "pet-adopt";
const EXIT_KEYWORDS = new Set(["stop", "quit", "exit", "end", "cancel"]);
const MAX_NAME_LENGTH = 24;
const GRAVEYARD_SIZE = 10;
// Callback data: pet:<action>:<petId>, plus :s / :m / :l for which size of fish a feed takes. Cards posted
// before fish feeding have plain pet:feed:<id> buttons, which count as medium.
const BUTTON_DATA = /^pet:(feed|pet|play):(\d+)(?::([sml]))?$/;
// The switcher: pet:view:<petId> turns the summary into that pet's card, and pet:all turns it back.
const VIEW_DATA = /^pet:view:(\d+)$/;
const ALL_DATA = "pet:all";
const FISH_SIZES: Record<string, FishSize> = { s: "small", m: "medium", l: "large" };

export class PetComposer extends Composer<MyContext> {
  constructor(
    private storage: StorageService,
    private ownerChatId: number | undefined
  ) {
    super();
    this.use(createConversation(this.adoptDialogue.bind(this), { id: ADOPT_CONVERSATION, maxMillisecondsToWait: CONVERSATION_TIMEOUT_MS }));
    this.command("adopt", (ctx) => this.handleAdopt(ctx));
    this.command("pet", (ctx) => this.sendCard(ctx));
    this.command("graveyard", (ctx) => this.sendGraveyard(ctx));
    this.command("petkill", (ctx) => this.handleKill(ctx));
    this.command("petrevive", (ctx) => this.handleRevive(ctx));
    this.callbackQuery(BUTTON_DATA, (ctx) => this.handleButton(ctx));
    this.callbackQuery(VIEW_DATA, (ctx) => this.handleView(ctx));
    this.callbackQuery(ALL_DATA, (ctx) => this.handleAll(ctx));
  }

  private isOwner(ctx: MyContext): boolean {
    return this.ownerChatId !== undefined && ctx.from?.id === this.ownerChatId;
  }

  // Whether feeding costs a fish in this chat: only while fishing is on, or nobody could ever feed it.
  private async feedsOnFish(chatId: number): Promise<boolean> {
    return (await this.storage.getChatFeatures(chatId)).fishing.enabled;
  }

  private async handleAdopt(ctx: MyContext) {
    if (!ctx.chat || !ctx.from) {
      return;
    }
    const { pets, eulogies } = await this.storage.getPet(ctx.chat.id);
    await this.postEulogies(ctx.api, ctx.chat.id, eulogies);
    if (pets.length > 0) {
      const fund = await this.storage.getPetFund(ctx.chat.id);
      if (pets.length >= fund.slots) {
        await replyHTML(ctx, `You already have ${joinList(pets.map(petTitle))}. ${await this.noRoomLine(ctx.chat.id, fund)}`);
        return;
      }
    }
    await ctx.conversation.enter(ADOPT_CONVERSATION);
  }

  // Why /adopt won't: a nudge toward the pet fund while there's one to chip in to (and the store's on to
  // do it in), otherwise just no.
  private async noRoomLine(chatId: number, fund: PetFundStatus): Promise<string> {
    if (fund.goal !== null && (await this.storage.getChatFeatures(chatId)).store.enabled) {
      return "No room for another pet. Chip in to the pet fund in /store.";
    }
    return fund.slots === 1 ? "One pet at a time." : "No room for another pet.";
  }

  // The species is rolled (inside external(), so the conversation's replays keep the same animal) and
  // revealed before naming, so the name can fit the animal. Only the adopter's reply counts; everyone
  // else's messages pass straight through to the rest of the bot while this waits.
  private async adoptDialogue(conversation: MyConversation, ctx: ConversationContext) {
    if (!ctx.chat || !ctx.from) {
      return;
    }
    const chatId = ctx.chat.id;
    const adopter = ctx.from;
    const threadId = ctx.message?.message_thread_id ?? null;
    const species = await conversation.external(() => rollSpecies());

    const rarityTag = species.rarity === "ultra" ? "🌟 ULTRA RARE! " : species.rarity === "rare" ? "✨ Rare! " : "";
    await ctx.reply(`📦 The box is rustling... ${rarityTag}It's a ${species.species}! ${species.emoji}\nWhat should we name it?`, {
      reply_markup: { force_reply: true, selective: true },
      ...(ctx.message?.message_id !== undefined && { reply_to_message_id: ctx.message.message_id }),
      ...(threadId !== null && { message_thread_id: threadId }),
    });

    for (;;) {
      const response = await conversation
        .waitFor("message:text", { next: true })
        .andFrom(adopter.id, { next: true })
        .and(isNotCommand, { next: true });
      const name = response.message.text.trim().replace(/\s+/g, " ");

      if (EXIT_KEYWORDS.has(name.toLowerCase())) {
        await replyToMessage(response, "Adoption cancelled. The box goes back to the shelter.");
        return;
      }
      if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
        await replyToMessage(response, `Names can be up to ${MAX_NAME_LENGTH} characters. Try again, or send "cancel".`);
        continue;
      }

      const { result, fishFeeding, livingPets } = await conversation.external(async () => {
        const adopted = await this.storage.adoptPet(chatId, {
          name,
          species: species.species,
          emoji: species.emoji,
          rarity: species.rarity,
          adoptedById: adopter.id,
          adoptedByName: adopter.first_name,
          threadId,
        });
        if (adopted.ok) {
          await this.storage.registerPetChat(chatId);
        }
        const living = adopted.ok ? (await this.storage.getPetFund(chatId)).livingPets : adopted.pets.length;
        return { result: adopted, fishFeeding: await this.feedsOnFish(chatId), livingPets: living };
      });

      if (!result.ok) {
        const titles = result.pets.map(petTitle);
        await replyHTML(
          response,
          titles.length === 1 ? `Too slow — ${titles[0]} already lives here.` : `Too slow — ${joinList(titles)} took the last spot.`
        );
        return;
      }
      await this.postEulogies(response.api, chatId, result.eulogies);
      await response.reply(`🎉 Welcome home, ${petTitle(result.pet)}!\n\n${formatCard(result.pet)}`, {
        parse_mode: "HTML",
        reply_markup: cardKeyboard(result.pet, fishFeeding, livingPets >= 2),
        ...(threadId !== null && { message_thread_id: threadId }),
      });
      return;
    }
  }

  private async sendCard(ctx: MyContext) {
    if (!ctx.chat) {
      return;
    }
    const { pets, eulogies } = await this.storage.getPet(ctx.chat.id);
    await this.postEulogies(ctx.api, ctx.chat.id, eulogies);
    if (pets.length === 0) {
      // A eulogy just posted already says so.
      if (eulogies.length === 0) {
        await replyToMessage(ctx, NO_PET_MESSAGE);
      }
      return;
    }
    const view = petsView(pets, await this.feedsOnFish(ctx.chat.id));
    await ctx.reply(view.text, {
      parse_mode: "HTML",
      ...(view.keyboard && { reply_markup: view.keyboard }),
      ...(ctx.message?.message_thread_id !== undefined && { message_thread_id: ctx.message.message_thread_id }),
    });
  }

  // "🔍 Check on Bingo": turns the summary into Bingo's card. If Bingo has died since, a pop-up says so and
  // the message shows the summary of whoever's left instead.
  private async handleView(ctx: MyContext) {
    const match = ctx.callbackQuery?.data?.match(VIEW_DATA);
    if (!match || !ctx.chat) {
      return;
    }
    const petId = Number(match[1]);
    const { pets, eulogies } = await this.storage.getPet(ctx.chat.id);
    const fishFeeding = await this.feedsOnFish(ctx.chat.id);
    const pet = pets.find((p) => p.id === petId);
    if (pet) {
      await this.editInto(ctx, { text: formatCard(pet), keyboard: cardKeyboard(pet, fishFeeding, pets.length >= 2) });
      await ctx.answerCallbackQuery();
    } else {
      // Edit first, then the pop-up (see handleButton for why).
      await this.editInto(ctx, petsView(pets, fishFeeding));
      await ctx.answerCallbackQuery({ text: "That pet is no longer with us.", show_alert: true });
    }
    await this.postEulogies(ctx.api, ctx.chat.id, eulogies);
  }

  // "◀ All pets": back to the summary (or, if only one pet is left, its card).
  private async handleAll(ctx: MyContext) {
    if (!ctx.chat) {
      return;
    }
    const { pets, eulogies } = await this.storage.getPet(ctx.chat.id);
    await this.editInto(ctx, petsView(pets, await this.feedsOnFish(ctx.chat.id)));
    await ctx.answerCallbackQuery();
    await this.postEulogies(ctx.api, ctx.chat.id, eulogies);
  }

  private async editInto(ctx: MyContext, view: { text: string; keyboard: InlineKeyboard | null }) {
    await ctx
      .editMessageText(view.text, { parse_mode: "HTML", ...(view.keyboard && { reply_markup: view.keyboard }) })
      .catch((err) => console.error(err)); // e.g. "message is not modified"
  }

  // Feed / Pet buttons work on any message that carries them (the card, warnings) and turn it into an
  // up-to-date card. Everything else is a private toast, so caring for the pet doesn't flood the chat.
  //
  // A feed (with fishing on) takes the fish first, then asks the pet, and puts the fish back if the feed
  // didn't happen (cooldown, stale card, pet just died). Doing it in that order here, rather than inside
  // the Pet DO, keeps the pet's cooldown check and its write free of any await, so a double tap can't get
  // two feeds through; each tap takes its own fish, and the one that hits the cooldown gets it back.
  private async handleButton(ctx: MyContext) {
    const match = ctx.callbackQuery?.data?.match(BUTTON_DATA);
    if (!match || !ctx.chat || !ctx.from) {
      return;
    }
    const chatId = ctx.chat.id;
    const action = match[1] as PetInput;
    const petId = Number(match[2]);
    const fishFeeding = await this.feedsOnFish(chatId);

    let fish: HeldFish | null = null;
    if (action === "feed" && fishFeeding) {
      fish = await this.storage.takeFish(chatId, ctx.from.id, FISH_SIZES[match[3] ?? "m"] ?? "medium", `pet:${petId}`);
      if (!fish) {
        const { pets, eulogies } = await this.storage.getPet(chatId);
        const pet = pets.find((p) => p.id === petId);
        await ctx.answerCallbackQuery({ text: emptyBucketMessage(pet?.name ?? "The pet"), show_alert: true });
        await this.postEulogies(ctx.api, chatId, eulogies);
        return;
      }
    }

    let result: Awaited<ReturnType<StorageService["interactWithPet"]>>;
    try {
      result = await this.storage.interactWithPet(chatId, {
        petId,
        action,
        userId: ctx.from.id,
        firstName: ctx.from.first_name,
        feedAmount: fish ? foodForFish(fish.weight) : PET_CONFIG.FEED_AMOUNT,
      });
    } catch (err) {
      if (fish) {
        await this.refundFish(chatId, fish);
      }
      throw err;
    }
    if (fish && result.result !== "OK" && result.result !== "OVERFED") {
      await this.refundFish(chatId, fish);
    }

    switch (result.result) {
      case "STALE":
        await ctx.answerCallbackQuery({ text: "That pet is no longer with us." });
        return;
      case "GONE":
        await ctx.answerCallbackQuery({ text: "Too late." });
        await this.postEulogy(ctx.api, ctx.chat.id, result.eulogy);
        return;
      case "KILLED":
        await ctx.answerCallbackQuery({
          text: `🚗💥 ${result.eulogy.name} crashed the car and died. The car curse is real.`,
          show_alert: true,
        });
        await this.postEulogy(ctx.api, ctx.chat.id, result.eulogy);
        return;
      case "COOLDOWN":
        // Deliberately vague about when: it's a nudge to share, not a timer to watch. show_alert keeps it up
        // until dismissed — Telegram gives bots no control over how long a normal toast stays.
        await ctx.answerCallbackQuery({ text: cooldownMessage(result.pet.name, action), show_alert: true });
        return;
      case "OVERFED":
      case "OK": {
        // Card first, then the pop-up (one that stays until dismissed, since a toast vanishes before anyone
        // can read it). The other order edits the card's buttons while the alert is open, and Telegram's
        // mobile apps then leave those buttons dead after the alert is dismissed.
        await ctx
          .editMessageText(formatCard(result.pet), {
            parse_mode: "HTML",
            reply_markup: cardKeyboard(result.pet, fishFeeding, result.livingPets >= 2),
          })
          .catch((err) => console.error(err)); // e.g. "message is not modified"
        await ctx.answerCallbackQuery({ text: actionPopup(result.pet), show_alert: true });
        // Everything else stays on the card, but throwing up, biting, and learning a trick go public.
        const kind = result.pet.lastAction!.kind;
        const shout =
          kind === "overfed"
            ? overfedMessage(result.pet, ctx.from.first_name)
            : kind === "bit"
              ? bitMessage(result.pet, ctx.from.first_name)
              : kind === "botched"
                ? parkingMessage(result.pet, ctx.from.first_name)
                : kind === "learned"
                  ? `🎓 ${escapeHtml(ctx.from.first_name)} taught <b>${escapeHtml(result.pet.name)}</b> a new trick: <b>${trickTitle(result.pet.lastAction!.trick)}</b>!`
                  : null;
        if (shout) {
          await this.postShout(ctx, result.pet, shout);
        }
        return;
      }
    }
  }

  // A lost fish is better than a broken tap, so a failed refund is only logged.
  private async refundFish(chatId: number, fish: HeldFish) {
    await this.storage.returnFish(chatId, fish.id).catch((err) => console.error("returnFish failed", fish, err));
  }

  // Replies to the card the button was on, quoting just the pet's title, so the reply preview shows
  // "Bingo the rabbit 🐇" rather than however much of the whole card fits on a wide screen. Telegram
  // rejects a quote that isn't exact text from that message; if it ever does, post plainly into the same
  // topic instead, so the message itself never gets lost.
  private async postShout(ctx: MyContext, pet: PetStatus, text: string) {
    const card = ctx.callbackQuery?.message;
    if (!ctx.chat || !card) {
      return;
    }
    const thread = card.message_thread_id !== undefined ? { message_thread_id: card.message_thread_id } : {};
    try {
      await ctx.api.sendMessage(ctx.chat.id, text, {
        parse_mode: "HTML",
        reply_parameters: { message_id: card.message_id, quote: `${pet.name} the ${pet.species} ${pet.emoji}` },
        ...thread,
      });
    } catch (err) {
      console.error(err);
      await ctx.api.sendMessage(ctx.chat.id, text, { parse_mode: "HTML", ...thread });
    }
  }

  private async sendGraveyard(ctx: MyContext) {
    if (!ctx.chat) {
      return;
    }
    const entries = await this.storage.getPetGraveyard(ctx.chat.id, GRAVEYARD_SIZE);
    if (entries.length === 0) {
      await replyToMessage(ctx, "The graveyard is empty. For now.");
      return;
    }
    const lines = entries.map(
      (e) =>
        `${e.emoji} <b>${escapeHtml(e.name)}</b> the ${e.species} — ${formatDate(e.adoptedAt)} to ${formatDate(e.diedAt)} ` +
        `(${formatLifespan(e.diedAt - e.adoptedAt)}), ${CAUSE_LABELS[e.cause]}` +
        (e.tricksKnown > 0 ? `, knew ${pluralTricks(e.tricksKnown)}` : "")
    );
    await replyHTML(ctx, [`🪦 <b>Graveyard</b>`, ``, ...lines].join("\n"));
  }

  private async handleKill(ctx: MyContext) {
    if (!this.isOwner(ctx) || !ctx.chat) {
      return;
    }
    const name = String(ctx.match ?? "").trim();
    const result = await this.storage.killPet(ctx.chat.id, name || undefined);
    await this.postEulogies(ctx.api, ctx.chat.id, result.eulogies);
    if ("eulogy" in result) {
      await this.postEulogy(ctx.api, ctx.chat.id, result.eulogy);
    } else if ("needsName" in result) {
      await replyToMessage(ctx, `Which one? /petkill <name>, out of: ${result.pets.join(", ")}.`);
    } else if (name) {
      await replyToMessage(ctx, `There's no pet named "${name}".`);
    } else if (result.eulogies.length === 0) {
      // (A eulogy just posted already says there's nobody left.)
      await replyToMessage(ctx, "There's no pet to put down.");
    }
  }

  private async handleRevive(ctx: MyContext) {
    if (!this.isOwner(ctx) || !ctx.chat) {
      return;
    }
    const pet = await this.storage.revivePet(ctx.chat.id);
    if (!pet) {
      await replyToMessage(ctx, "Nothing to revive: either every pet slot is taken, or the graveyard is empty.");
      return;
    }
    const { livingPets } = await this.storage.getPetFund(ctx.chat.id);
    await ctx.reply(`⚡ ${petTitle(pet)} is back from the dead.\n\n${formatCard(pet)}`, {
      parse_mode: "HTML",
      reply_markup: cardKeyboard(pet, await this.feedsOnFish(ctx.chat.id), livingPets >= 2),
      ...(ctx.message?.message_thread_id !== undefined && { message_thread_id: ctx.message.message_thread_id }),
    });
  }

  private async postEulogy(api: Api, chatId: number, eulogy: PetEulogy) {
    await api.sendMessage(chatId, formatEulogy(eulogy), {
      parse_mode: "HTML",
      ...(eulogy.threadId !== null && { message_thread_id: eulogy.threadId }),
    });
  }

  // One message per death, in the order they happened.
  private async postEulogies(api: Api, chatId: number, eulogies: PetEulogy[]) {
    for (const eulogy of eulogies) {
      await this.postEulogy(api, chatId, eulogy);
    }
  }

  /** Driven by main.ts's scheduled() handler, every hour. */

  // Settles every chat's pets (catching deaths nobody's been around to notice), then posts whatever's due:
  // eulogies, and each pet's "it's dying" warning (with that pet's card buttons attached — no "◀ All pets",
  // since a warning is its own message, not the switcher). Chats with the feature switched off get their
  // pets frozen instead — see the Pet DO's freeze().
  async runHourlyCheck(api: Api): Promise<void> {
    const chatIds = await this.storage.listPetChats();
    const { hour } = easternParts(new Date());
    const awake = hour >= PET_CONFIG.WARN_FROM_HOUR_ET && hour < PET_CONFIG.WARN_UNTIL_HOUR_ET;

    for (const chatId of chatIds) {
      // One chat failing (e.g. the bot was removed from it) shouldn't skip every chat after it.
      try {
        const features = await this.storage.getChatFeatures(chatId);
        if (!features.pet.enabled) {
          await this.storage.freezePet(chatId);
          continue;
        }
        const { pets, eulogies, warnings } = await this.storage.tickPet(chatId, awake);
        await this.postEulogies(api, chatId, eulogies);
        for (const { petId, warning } of warnings) {
          const pet = pets.find((p) => p.id === petId);
          if (!pet) {
            continue;
          }
          await api.sendMessage(chatId, formatWarning(pet, warning), {
            parse_mode: "HTML",
            reply_markup: cardKeyboard(pet, features.fishing.enabled, false),
            ...(pet.threadId !== null && { message_thread_id: pet.threadId }),
          });
        }
      } catch (err) {
        console.error(err);
      }
    }
  }
}

const CAUSE_LABELS: Record<PetEulogy["cause"], string> = {
  starved: "starved",
  ran_away: "ran away",
  put_down: "put down",
  overfed: "overfed to death",
  car_crash: "crashed the car",
};

function petTitle(pet: { name: string; species: string; emoji: string }): string {
  return `<b>${escapeHtml(pet.name)}</b> the ${pet.species} ${pet.emoji}`;
}

const NO_PET_MESSAGE = "There's no pet here. Use /adopt to get one.";

// What /pet shows (and "◀ All pets" goes back to): one pet's card as it's always been, or with two or
// more, a summary with a "check on" button each. With none (everyone died since the card was posted),
// just the nudge to adopt, and no buttons.
function petsView(pets: PetStatus[], fishFeeding: boolean): { text: string; keyboard: InlineKeyboard | null } {
  const [only] = pets;
  if (pets.length === 0 || !only) {
    return { text: NO_PET_MESSAGE, keyboard: null };
  }
  if (pets.length === 1) {
    return { text: formatCard(only), keyboard: cardKeyboard(only, fishFeeding, false) };
  }
  const keyboard = new InlineKeyboard();
  for (const pet of pets) {
    keyboard.text(`🔍 Check on ${pet.name}`, `pet:view:${pet.id}`).row();
  }
  return { text: formatSummary(pets), keyboard };
}

// Each pet on two lines, its name and then its meters indented under it:
//   🐶 Bluey the dog
//      🍖 80% · 💛 60%
function formatSummary(pets: PetStatus[]): string {
  const lines = pets.flatMap((pet) => [
    `${pet.emoji} <b>${escapeHtml(pet.name)}</b> the ${pet.species}`,
    `   🍖 ${Math.round(pet.food)}% · 💛 ${Math.round(pet.mood)}%`,
  ]);
  return [`🐾 <b>The pets</b>`, ``, ...lines].join("\n");
}

// With fishing on, Feed is three buttons on their own row — which size of fish to give it, from the
// tapper's own bucket. allPets adds a last row back to the summary, for chats with two or more pets.
function cardKeyboard(pet: PetStatus, fishFeeding: boolean, allPets: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (fishFeeding) {
    keyboard
      .text("🐟 Small", `pet:feed:${pet.id}:s`)
      .text("🐟 Medium", `pet:feed:${pet.id}:m`)
      .text("🐟 Large", `pet:feed:${pet.id}:l`)
      .row();
  } else {
    keyboard.text("🍖 Feed", `pet:feed:${pet.id}`);
  }
  keyboard.text("🤚 Pet", `pet:pet:${pet.id}`).text("🎾 Play", `pet:play:${pet.id}`);
  return allPets ? keyboard.row().text("◀ All pets", ALL_DATA) : keyboard;
}

// The tapper's own pop-up, in second person. Plain text: Telegram pop-ups don't render HTML.
function actionPopup(pet: PetStatus): string {
  const { kind, food, trick } = pet.lastAction!;
  const name = pet.name;
  const popups: Record<PetAction, () => string> = {
    fed: () => `${food ?? "🍖"} You fed ${name}!`,
    petted: () => `🤚 You pet ${name}!`,
    overfed: () => `🤮 ${name} was already full and threw up on you!`,
    zoomies: () => `💨 ${name} zoomZoom'd with you!`,
    fetch: () => `🎾 ${name} played fetch with you!`,
    bored: () => `🥱 ${name} ignored you!`,
    bit: () => `🦷 ${name} bit you!`,
    learned: () => `🎓 You taught ${name} a new trick: ${trickTitle(trick)}!`,
    trick: () => `🪄 ${trickLine(trick, name, "you", "your")}`,
    botched: () => `💥 ${name} tried to parallel park your car, hit a parked minivan, and is now being sued. ${name} never learned to drive.`,
  };
  return popups[kind]();
}

// A PET_TRICKS line with the names filled in. A trick that's since been removed from the list still
// gets a generic line.
function trickLine(trick: string | null, pet: string, person: string, possessive: string): string {
  const template = PET_TRICKS.find((t) => t.name === trick)?.line ?? "{pet} did a trick for {person}.";
  return template.replace("{pet}", pet).replace("{person's}", possessive).replace("{person}", person);
}

function formatCard(pet: PetStatus): string {
  const rarity = pet.rarity === "ultra" ? " 🌟" : pet.rarity === "rare" ? " ✨" : "";
  return [
    `${petTitle(pet)}${rarity}`,
    `<i>${moodLine(pet)}</i>`,
    // Bar lines start with an emoji (all the same width) so the bars line up; the words go underneath,
    // since "Food" and "Mood" render at different widths in Telegram's proportional font.
    `🍖 ${meterBar(pet.food, "🟥")}`,
    `Food ${Math.round(pet.food)}%`,
    `💛 ${meterBar(pet.mood, "🟦")}`,
    `Mood ${Math.round(pet.mood)}%`,
    ...(pet.tricksKnown > 0 ? [`🎓 Knows ${pluralTricks(pet.tricksKnown)}`] : []),
    ...(pet.lastAction ? [lastActionLine(pet)] : []),
  ].join("\n");
}

function lastActionLine(pet: PetStatus): string {
  const { kind, by, food, trick } = pet.lastAction!;
  const who = escapeHtml(by);
  const name = escapeHtml(pet.name);
  switch (kind) {
    case "fed":
      return `${food ?? "🍖"} ${who} fed ${name}.`;
    case "petted":
      return `🤚 ${who} pet ${name}.`;
    case "overfed":
      return `🤮 ${who} overfed ${name}.`;
    case "zoomies":
      return `💨 ${name} zoomZoom'd with ${who}.`;
    case "fetch":
      return `🎾 ${who} played fetch with ${name}.`;
    case "bored":
      return `🥱 ${name} ignored ${who}.`;
    case "bit":
      return `🦷 ${name} bit ${who}.`;
    case "learned":
      return `🎓 ${who} taught ${name} a new trick: ${trickTitle(trick)}.`;
    case "trick":
      return `🪄 ${trickLine(trick, name, who, `${who}'s`)}`;
    case "botched":
      return `💥 ${name} botched parallel parking ${who}'s car. Lawsuit pending.`;
  }
}

// "file taxes" -> "File taxes", for "a new trick: File taxes!"
function trickTitle(trick: string | null): string {
  const name = trick ?? "something";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function pluralTricks(count: number): string {
  return `${count} trick${count === 1 ? "" : "s"}`;
}

function bitMessage(pet: PetStatus, by: string): string {
  const name = `<b>${escapeHtml(pet.name)}</b>`;
  const who = escapeHtml(by);
  return random([
    `🦷 ${who} tried to play with ${name}. ${name} bit ${who}.`,
    `🦷 ${name} bit ${who}. Hard.`,
    `🦷 ${who} played too rough and ${name} bit back.`,
  ]);
}

function parkingMessage(pet: PetStatus, by: string): string {
  const name = `<b>${escapeHtml(pet.name)}</b>`;
  const who = escapeHtml(by);
  return random([
    `💥 ${name} tried to parallel park ${who}'s car and backed straight into a minivan. The owner is suing. ${name} never learned to drive.`,
    `💥 ${name} parallel parked ${who}'s car into another car. Lawyers have been contacted.`,
    `💥 ${name} learned to park before it learned to drive. ${who}'s car is totaled and there's a lawsuit.`,
  ]);
}

function overfedMessage(pet: PetStatus, by: string): string {
  const name = `<b>${escapeHtml(pet.name)}</b>`;
  const who = escapeHtml(by);
  return random([
    `🤮 ${who} fed ${name} when it was already full. ${name} threw up everywhere.`,
    `🤮 ${name} threw up all over ${who}'s shoes. It was already full, ${who}.`,
    `🤮 ${who} overfed ${name}. Someone get a mop.`,
  ]);
}

// Telegram can't color text, so the bars are colored square emoji: 10 squares, one per 10%.
function meterBar(value: number, filledSquare: string): string {
  const filled = Math.round(Math.max(0, Math.min(100, value)) / 10);
  return filledSquare.repeat(filled) + "⬜".repeat(10 - filled);
}

function moodLine(pet: PetStatus): string {
  const name = escapeHtml(pet.name);
  if (pet.food <= 0) {
    return `${name} is starving. This is not a drill.`;
  }
  if (pet.food < PET_CONFIG.HUNGRY_BELOW) {
    return `${name} keeps looking at you, then at the empty bowl.`;
  }
  if (pet.mood <= PET_CONFIG.MISERABLE_WARNING_AT) {
    return `${name} is staring at the wall with dead eyes.`;
  }
  if (pet.mood < 40) {
    return `${name} seems a little down.`;
  }
  if (pet.mood >= 80 && pet.food >= 60) {
    return `${name} is thriving.`;
  }
  return `${name} is doing fine, all things considered.`;
}

function formatWarning(pet: PetStatus, warning: PetWarning): string {
  return `☠️ ${petTitle(pet)} hasn't eaten in a long time. It has about ${warning.hoursLeft} hour${warning.hoursLeft === 1 ? "" : "s"} left.`;
}

// The pet begging in someone's /fish reply (see fishing.ts), when it's hungry or lonely — the only nudge
// before it's dying, and it lands on the one person holding a fresh fish. Plain text, like the rest of
// that reply. null when the pet's fine.
export function petDesireLine(pet: PetPeek, caught: "fish" | "trash"): string | null {
  const name = pet.name;
  const lead = `${pet.emoji} ${name}`;
  if (pet.food <= PET_CONFIG.STARVING_WARNING_AT) {
    return random(
      caught === "fish"
        ? [`${lead} is trying to climb into your bucket. Feed it from /pet.`, `${lead} hasn't eaten in ages and is staring at your fish. /pet`]
        : [`${lead} tried to eat that anyway. It's starving. /pet`, `${lead} is so hungry it's licking the bucket. /pet`]
    );
  }
  if (pet.food <= PET_CONFIG.HUNGRY_WARNING_AT) {
    return random(
      caught === "fish"
        ? [`${lead} smells your catch and drools.`, `${lead} followed you down to the dock. It looks hungry.`, `${lead} is eyeing your fish.`]
        : [`${lead} sniffs it hopefully. It's hungry.`, `${lead} looks at your catch, then at you. It was hoping for a fish.`]
    );
  }
  if (pet.mood <= PET_CONFIG.MISERABLE_WARNING_AT) {
    return random([
      `${lead} watches you fish from a distance. It looks lonely.`,
      `${lead} sat next to you on the dock and sighed. Nobody's played with it lately.`,
    ]);
  }
  return null;
}

// Feeding with an empty bucket: in-character, and a pointer to where fish come from. Plain text (pop-up).
function emptyBucketMessage(name: string): string {
  return random([
    `🪣 Your bucket's empty. ${name} sniffs your hands and looks away. Go /fish first.`,
    `🪣 ${name} stares at your empty hands. No fish, no food. Try /fish.`,
    `🪣 You don't have any fish. ${name} has standards. /fish`,
  ]);
}

function formatEulogy(e: PetEulogy): string {
  const title = petTitle(e);
  const headline =
    e.cause === "starved"
      ? `🪦 ${title} has died of starvation.`
      : e.cause === "ran_away"
        ? `🧳 ${title} ran away. Nobody showed it any love.`
        : e.cause === "car_crash"
          ? `🚗💥 ${title} crashed the car and died. The car curse is real.`
          : e.cause === "overfed"
            ? `🤮 ${title} threw up one last time and never got back up.`
            : `🪦 ${title} has been put down by management.`;
  const lines = [
    headline,
    `${formatDate(e.adoptedAt)} – ${formatDate(e.diedAt)} (${formatLifespan(e.diedAt - e.adoptedAt)})`,
    ...(e.tricksKnown > 0 ? [`It knew ${pluralTricks(e.tricksKnown)}.`] : []),
    ``,
  ];

  if (e.cause === "starved") {
    lines.push(
      e.lastFedBy && e.lastFedAt !== null
        ? `Last fed by ${escapeHtml(e.lastFedBy)}, ${formatLifespan(e.diedAt - e.lastFedAt)} before the end.`
        : `Nobody ever fed it.`
    );
    if (e.onlyPetted.length > 0) {
      lines.push(`${listNames(e.onlyPetted)} petted it but never fed it.`);
    }
  } else if (e.cause === "ran_away") {
    lines.push(
      e.lastPettedBy && e.lastPettedAt !== null
        ? `Last petted by ${escapeHtml(e.lastPettedBy)}, ${formatLifespan(e.diedAt - e.lastPettedAt)} before it left.`
        : `Nobody ever petted it.`
    );
    if (e.onlyFed.length > 0) {
      lines.push(`${listNames(e.onlyFed)} fed it but never once petted it.`);
    }
  } else if (e.cause === "car_crash" && e.lastActionBy) {
    lines.push(`${escapeHtml(e.lastActionBy)} was the one who handed it the keys.`);
  }
  lines.push(``, `Use /adopt to try again.`);
  return lines.join("\n");
}

function listNames(names: string[]): string {
  return joinList(names.map(escapeHtml));
}

// "A", "A and B", "A, B, and C". Joins as-is, so escape first.
function joinList(items: string[]): string {
  return items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function formatDate(epochSec: number): string {
  return formatEasternDate(epochSec);
}

function formatLifespan(seconds: number): string {
  const hours = Math.max(0, Math.round(seconds / 3600));
  if (hours < 48) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.round(hours / 24);
  return `${days} days`;
}

function cooldownMessage(name: string, action: PetInput): string {
  return random(
    {
      feed: [`You fed ${name} recently. Give someone else a turn!`, `${name} is still chewing your last meal. Let someone else have a go!`],
      pet: [`You pet ${name} recently. Give someone else a turn!`, `${name} has had plenty of you for now. Let someone else have a go!`],
      play: [`You played with ${name} recently. Give someone else a turn!`, `${name} is worn out from you. Let someone else have a go!`],
    }[action]
  );
}
