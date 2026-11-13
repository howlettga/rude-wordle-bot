import { Composer, InlineKeyboard } from "grammy";
import type { Api, Context } from "grammy";
import { createConversation } from "@grammyjs/conversations";
import type { Conversation } from "@grammyjs/conversations";
import { type MyContext, replyToMessage, replyHTML, isNotCommand, CONVERSATION_TIMEOUT_MS } from "./context.js";
import type { StorageService } from "./storage-service.js";
import type { PetEulogy, PetStatus, PetWarning } from "./durable-objects/pet.js";
import { PET_CONFIG, rollSpecies } from "./pet-config.js";
import { easternParts } from "./eastern-time.js";
import { escapeHtml, random } from "./util.js";

// The "pet" feature (see features.ts): one shared pet per chat, kept alive by everyone.
//   /adopt      -> when there's no living pet: reveals a random animal, then asks the adopter to name it
//   /pet        -> status card (food, mood, age) with Feed / Pet buttons that update the card in place
//   /graveyard  -> past pets, how long they lived, and how they went
//   /petkill    -> owner-only: puts the pet down (mercy, or testing)
//   /petrevive  -> owner-only: brings the last dead pet back at full meters (in case a bug killed it)
// The hourly check (runHourlyCheck) posts hunger/mood warnings and announces deaths. Every number lives
// in pet-config.ts.
type ConversationContext = Context;
type MyConversation = Conversation<MyContext, ConversationContext>;

const ADOPT_CONVERSATION = "pet-adopt";
const EXIT_KEYWORDS = new Set(["stop", "quit", "exit", "end", "cancel"]);
const MAX_NAME_LENGTH = 24;
const GRAVEYARD_SIZE = 10;

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
    this.callbackQuery(/^pet:(feed|pet):(\d+)$/, (ctx) => this.handleButton(ctx));
  }

  private isOwner(ctx: MyContext): boolean {
    return this.ownerChatId !== undefined && ctx.from?.id === this.ownerChatId;
  }

  private async handleAdopt(ctx: MyContext) {
    if (!ctx.chat || !ctx.from) {
      return;
    }
    const { pet, eulogy } = await this.storage.getPet(ctx.chat.id);
    if (eulogy) {
      await this.postEulogy(ctx.api, ctx.chat.id, eulogy);
    }
    if (pet) {
      await replyHTML(ctx, `You already have ${petTitle(pet)}. One pet at a time.`);
      return;
    }
    await ctx.conversation.enter(ADOPT_CONVERSATION);
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

      const result = await conversation.external(async () => {
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
        return adopted;
      });

      if (!result.ok) {
        await replyHTML(response, `Too slow — ${petTitle(result.pet)} already lives here.`);
        return;
      }
      await response.reply(`🎉 Welcome home, ${petTitle(result.pet)}!\n\n${formatCard(result.pet)}`, {
        parse_mode: "HTML",
        reply_markup: cardKeyboard(result.pet),
        ...(threadId !== null && { message_thread_id: threadId }),
      });
      return;
    }
  }

  private async sendCard(ctx: MyContext) {
    if (!ctx.chat) {
      return;
    }
    const { pet, eulogy } = await this.storage.getPet(ctx.chat.id);
    if (eulogy) {
      await this.postEulogy(ctx.api, ctx.chat.id, eulogy);
      return;
    }
    if (!pet) {
      await replyToMessage(ctx, "There's no pet here. Use /adopt to get one.");
      return;
    }
    await ctx.reply(formatCard(pet), {
      parse_mode: "HTML",
      reply_markup: cardKeyboard(pet),
      ...(ctx.message?.message_thread_id !== undefined && { message_thread_id: ctx.message.message_thread_id }),
    });
  }

  // Feed / Pet buttons work on any message that carries them (the card, warnings) and turn it into an
  // up-to-date card. Everything else is a private toast, so caring for the pet doesn't flood the chat.
  private async handleButton(ctx: MyContext) {
    const match = ctx.callbackQuery?.data?.match(/^pet:(feed|pet):(\d+)$/);
    if (!match || !ctx.chat || !ctx.from) {
      return;
    }
    const action = match[1] as "feed" | "pet";
    const result = await this.storage.interactWithPet(ctx.chat.id, {
      petId: Number(match[2]),
      action,
      userId: ctx.from.id,
      firstName: ctx.from.first_name,
    });

    switch (result.result) {
      case "STALE":
        await ctx.answerCallbackQuery({ text: "That pet is no longer with us." });
        return;
      case "GONE":
        await ctx.answerCallbackQuery({ text: "Too late." });
        await this.postEulogy(ctx.api, ctx.chat.id, result.eulogy);
        return;
      case "COOLDOWN":
        // Deliberately vague about when: it's a nudge to share, not a timer to watch. show_alert keeps it up
        // until dismissed — Telegram gives bots no control over how long a normal toast stays.
        await ctx.answerCallbackQuery({ text: cooldownMessage(result.pet.name, action), show_alert: true });
        return;
      case "OVERFED":
      case "OK":
        await ctx
          .editMessageText(formatCard(result.pet), { parse_mode: "HTML", reply_markup: cardKeyboard(result.pet) })
          .catch((err) => console.error(err)); // e.g. "message is not modified" — the toast still goes out
        await ctx.answerCallbackQuery({ text: result.result === "OVERFED" ? "🤮 Gross." : action === "feed" ? "🍖 Fed!" : "🤚 Petted!" });
        // Everything else stays on the card, but throwing up is worth a public shaming.
        if (result.result === "OVERFED") {
          const cardMessage = ctx.callbackQuery?.message;
          await ctx.api.sendMessage(ctx.chat.id, overfedMessage(result.pet, ctx.from.first_name), {
            parse_mode: "HTML",
            ...(cardMessage && { reply_to_message_id: cardMessage.message_id }),
            ...(cardMessage?.message_thread_id !== undefined && { message_thread_id: cardMessage.message_thread_id }),
          });
        }
        return;
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
        `(${formatLifespan(e.diedAt - e.adoptedAt)}), ${CAUSE_LABELS[e.cause]}`
    );
    await replyHTML(ctx, [`🪦 <b>Graveyard</b>`, ``, ...lines].join("\n"));
  }

  private async handleKill(ctx: MyContext) {
    if (!this.isOwner(ctx) || !ctx.chat) {
      return;
    }
    const { eulogy } = await this.storage.killPet(ctx.chat.id);
    if (!eulogy) {
      await replyToMessage(ctx, "There's no pet to put down.");
      return;
    }
    await this.postEulogy(ctx.api, ctx.chat.id, eulogy);
  }

  private async handleRevive(ctx: MyContext) {
    if (!this.isOwner(ctx) || !ctx.chat) {
      return;
    }
    const pet = await this.storage.revivePet(ctx.chat.id);
    if (!pet) {
      await replyToMessage(ctx, "Nothing to revive: either a pet is alive, or the graveyard is empty.");
      return;
    }
    await ctx.reply(`⚡ ${petTitle(pet)} is back from the dead.\n\n${formatCard(pet)}`, {
      parse_mode: "HTML",
      reply_markup: cardKeyboard(pet),
      ...(ctx.message?.message_thread_id !== undefined && { message_thread_id: ctx.message.message_thread_id }),
    });
  }

  private async postEulogy(api: Api, chatId: number, eulogy: PetEulogy) {
    await api.sendMessage(chatId, formatEulogy(eulogy), {
      parse_mode: "HTML",
      ...(eulogy.threadId !== null && { message_thread_id: eulogy.threadId }),
    });
  }

  /** Driven by main.ts's scheduled() handler, every hour. */

  // Settles every chat's pet (catching deaths nobody's been around to notice), then posts whatever's due:
  // a eulogy, or warnings (with Feed / Pet buttons attached). Chats with the feature switched off get
  // their pet frozen instead — see the Pet DO's freeze().
  async runHourlyCheck(api: Api): Promise<void> {
    const chatIds = await this.storage.listPetChats();
    const { hour } = easternParts(new Date());
    const awake = hour >= PET_CONFIG.WARN_FROM_HOUR_ET && hour < PET_CONFIG.WARN_UNTIL_HOUR_ET;

    for (const chatId of chatIds) {
      // One chat failing (e.g. the bot was removed from it) shouldn't skip every chat after it.
      try {
        if (!(await this.storage.getChatFeatures(chatId)).pet.enabled) {
          await this.storage.freezePet(chatId);
          continue;
        }
        const { pet, eulogy, warnings } = await this.storage.tickPet(chatId, awake);
        if (eulogy) {
          await this.postEulogy(api, chatId, eulogy);
        }
        if (pet) {
          for (const warning of warnings) {
            await api.sendMessage(chatId, formatWarning(pet, warning), {
              parse_mode: "HTML",
              reply_markup: cardKeyboard(pet),
              ...(pet.threadId !== null && { message_thread_id: pet.threadId }),
            });
          }
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
};

function petTitle(pet: { name: string; species: string; emoji: string }): string {
  return `<b>${escapeHtml(pet.name)}</b> the ${pet.species} ${pet.emoji}`;
}

function cardKeyboard(pet: PetStatus): InlineKeyboard {
  return new InlineKeyboard().text("🍖 Feed", `pet:feed:${pet.id}`).text("🤚 Pet", `pet:pet:${pet.id}`);
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
    ...(pet.lastAction ? [lastActionLine(pet)] : []),
  ].join("\n");
}

function lastActionLine(pet: PetStatus): string {
  const { kind, by, food } = pet.lastAction!;
  const who = escapeHtml(by);
  const name = escapeHtml(pet.name);
  switch (kind) {
    case "fed":
      return `${food ?? "🍖"} ${who} fed ${name}.`;
    case "petted":
      return `🤚 ${who} pet ${name}.`;
    case "overfed":
      return `🤮 ${who} overfed ${name}.`;
  }
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
  const title = petTitle(pet);
  switch (warning.type) {
    case "hungry":
      return `🍖 ${title} is getting hungry.`;
    case "starving":
      return `😫 ${title} is starving! Somebody feed it.`;
    case "dying":
      return `☠️ ${title} hasn't eaten in a long time. It has about ${warning.hoursLeft} hour${warning.hoursLeft === 1 ? "" : "s"} left.`;
    case "miserable":
      return `💔 ${title} seems miserable. Nobody's paid it any attention lately.`;
  }
}

function formatEulogy(e: PetEulogy): string {
  const title = petTitle(e);
  const headline =
    e.cause === "starved"
      ? `🪦 ${title} has died of starvation.`
      : e.cause === "ran_away"
        ? `🧳 ${title} ran away. Nobody showed it any love.`
        : `🪦 ${title} has been put down by management.`;
  const lines = [headline, `${formatDate(e.adoptedAt)} – ${formatDate(e.diedAt)} (${formatLifespan(e.diedAt - e.adoptedAt)})`, ``];

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
  }
  lines.push(``, `Use /adopt to try again.`);
  return lines.join("\n");
}

function listNames(names: string[]): string {
  const escaped = names.map(escapeHtml);
  return escaped.length <= 2 ? escaped.join(" and ") : `${escaped.slice(0, -1).join(", ")}, and ${escaped[escaped.length - 1]}`;
}

function formatDate(epochSec: number): string {
  return new Date(epochSec * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
}

function formatLifespan(seconds: number): string {
  const hours = Math.max(0, Math.round(seconds / 3600));
  if (hours < 48) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.round(hours / 24);
  return `${days} days`;
}

function cooldownMessage(name: string, action: "feed" | "pet"): string {
  return random(
    action === "feed"
      ? [`You fed ${name} recently. Give someone else a turn!`, `${name} is still chewing your last meal. Let someone else have a go!`]
      : [`You pet ${name} recently. Give someone else a turn!`, `${name} has had plenty of you for now. Let someone else have a go!`]
  );
}
