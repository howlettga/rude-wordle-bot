import { Composer, InlineKeyboard } from "grammy";
import type { Api, Context } from "grammy";
import { createConversation } from "@grammyjs/conversations";
import type { Conversation } from "@grammyjs/conversations";
import { type MyContext, replyToMessage, replyInThread, replyHTML } from "./context.js";
import type { StorageService } from "./storage-service.js";
import type { WordleGolfGame, WordleGolfScorecard, WordleGolfLeaderboardEntry } from "./durable-objects/wordle-golf.js";
import { getTodaysWordle, nextDateString } from "./wordle-api.js";
import { wordleGolf } from "./replies.js";
import { random } from "./util.js";

// Inside a conversation, ctx is always the plain (unflavored) Context — the conversation itself is the flavor.
type ConversationContext = Context;
type MyConversation = Conversation<MyContext, ConversationContext>;

const NEW_ROUND_CONVERSATION = "wordle-golf-new-round";
const HOLES_RANGE = { min: 1, max: 18 };
const EXIT_KEYWORDS = new Set(["stop", "quit", "exit", "end"]);

interface ParsedWordleScore {
  puzzleNumber: number;
  value: number;
  label: string;
}

export class WordleGolfComposer extends Composer<MyContext> {
  constructor(private storage: StorageService) {
    super();
    // Must be registered before any handler below that calls ctx.conversation.enter() — the middleware it
    // returns is what makes that name resolvable.
    this.use(createConversation(this.newRoundDialogue.bind(this), NEW_ROUND_CONVERSATION));

    this.command("wordle", (ctx) => ctx.conversation.enter(NEW_ROUND_CONVERSATION));
    this.command("scorecard", (ctx) => this.sendScorecard(ctx));
    this.command("leaderboard", (ctx) => this.sendLeaderboard(ctx));
    this.hears(/^Wordle.*/, (ctx) => this.handleScoreSubmission(ctx));
  }

  /** CONVERSATION: /wordle — start a new round */

  private async newRoundDialogue(conversation: MyConversation, ctx: ConversationContext) {
    if (!ctx.chat || !ctx.from) {
      return;
    }
    const chatId = ctx.chat.id;
    const initiatorId = ctx.from.id;
    const initiatorName = ctx.from.first_name;

    const confirmed = await this.confirmNewRound(ctx, conversation, initiatorId, initiatorName);
    if (!confirmed) {
      return;
    }

    const params = await this.gatherRoundParameters(ctx, conversation, initiatorId, initiatorName);
    if (!params) {
      return;
    }

    const todaysWordle = await conversation.external(() => getTodaysWordle());
    const startsToday = await this.askStartTiming(ctx, conversation, initiatorId);
    const startDate = startsToday ? todaysWordle.print_date : nextDateString(todaysWordle.print_date);
    const initialPuzzleNumber = startsToday ? todaysWordle.days_since_launch : todaysWordle.days_since_launch + 1;

    await conversation.external(() =>
      this.storage.startWordleGolfGame(chatId, {
        ...(ctx.message?.message_thread_id !== undefined && { threadId: ctx.message.message_thread_id }),
        holes: params.holes,
        mulligans: params.mulligans,
        startDate,
        initialPuzzleNumber,
      })
    );

    await replyToMessage(ctx, wordleGolf.startNewRound(startsToday));
  }

  // Whoever's mid-day when the round kicks off may have already played today's puzzle without knowing a
  // round was starting, so let the initiator choose whether today counts as hole one or the round waits
  // for a puzzle nobody's seen yet.
  private async askStartTiming(ctx: ConversationContext, conversation: MyConversation, initiatorId: number): Promise<boolean> {
    await ctx.reply("Last thing — start with today's puzzle, or wait for a fresh one tomorrow?", {
      reply_markup: new InlineKeyboard().text("Today", "wordle_start_today").text("Tomorrow", "wordle_start_tomorrow"),
      ...(ctx.message?.message_thread_id !== undefined && { message_thread_id: ctx.message.message_thread_id }),
    });

    return this.waitForStartTiming(conversation, initiatorId);
  }

  private async waitForStartTiming(conversation: MyConversation, initiatorId: number): Promise<boolean> {
    const response = await conversation.waitForCallbackQuery(["wordle_start_today", "wordle_start_tomorrow"]);

    if (response.from.id !== initiatorId) {
      await response.answerCallbackQuery({
        text: "Only the person who started this round gets to pick.",
        show_alert: true,
      });
      return this.waitForStartTiming(conversation, initiatorId);
    }

    await response.answerCallbackQuery();
    const startsToday = response.match === "wordle_start_today";
    await response.editMessageText(startsToday ? "Starting with today's puzzle!" : "Starting fresh tomorrow!");
    return startsToday;
  }

  // Requires confirmation from someone other than the initiator, via inline buttons rather than the old
  // bot's freeform "yes"/"y"/"no"/"n" text matching.
  private async confirmNewRound(
    ctx: ConversationContext,
    conversation: MyConversation,
    initiatorId: number,
    initiatorName: string
  ): Promise<boolean> {
    await ctx.reply(
      `<a href="tg://user?id=${initiatorId}">${initiatorName}</a> wants to start a new round of Wordle Golf. Would someone else confirm?\n\n🚨 This will reset any existing round!`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("✅ Confirm", "wordle_confirm").text("❌ Decline", "wordle_decline"),
        ...(ctx.message?.message_thread_id !== undefined && { message_thread_id: ctx.message.message_thread_id }),
      }
    );

    return this.waitForRoundConfirmation(conversation, initiatorId);
  }

  // Split out from confirmNewRound so a self-click can loop back to waiting on the same message instead of
  // aborting — otherwise the buttons stay live but nothing is listening, and the next person's tap just spins.
  private async waitForRoundConfirmation(conversation: MyConversation, initiatorId: number): Promise<boolean> {
    const response = await conversation.waitForCallbackQuery(["wordle_confirm", "wordle_decline"]);

    if (response.from.id === initiatorId && response.match === "wordle_confirm") {
      await response.answerCallbackQuery({
        text: "You can't confirm your own round — get a friend to do it!",
        show_alert: true,
      });
      return this.waitForRoundConfirmation(conversation, initiatorId);
    }

    await response.answerCallbackQuery();

    if (response.match === "wordle_decline") {
      await response.editMessageText(wordleGolf.declineResponse(response.from.id, response.from.first_name), {
        parse_mode: "HTML",
      });
      return false;
    }

    await response.editMessageText("Let's get this round started!");
    return true;
  }

  private async gatherRoundParameters(
    ctx: ConversationContext,
    conversation: MyConversation,
    initiatorId: number,
    initiatorName: string
  ): Promise<{ holes: number; mulligans: number } | null> {
    await replyInThread(ctx, `How many holes (days) would you like to play? (${HOLES_RANGE.min}-${HOLES_RANGE.max})`);
    const holes = await this.askForNumber(conversation, initiatorId, initiatorName, HOLES_RANGE);
    if (holes === null) {
      return null;
    }

    const mulligansRange = { min: 0, max: holes };
    await replyInThread(
      ctx,
      `How many mulligans (skip days) would you like to include? (${mulligansRange.min}-${mulligansRange.max})`
    );
    const mulligans = await this.askForNumber(conversation, initiatorId, initiatorName, mulligansRange);
    if (mulligans === null) {
      return null;
    }

    return { holes, mulligans };
  }

  // Only the initiator gets to set the round's parameters. Loops (re-waiting) when anyone else answers, or
  // when the answer is out of range — a typo shouldn't blow up the whole dialogue.
  private async askForNumber(
    conversation: MyConversation,
    initiatorId: number,
    initiatorName: string,
    range: { min: number; max: number }
  ): Promise<number | null> {
    const response = await conversation.waitFor("message:text");

    if (response.from?.id !== initiatorId) {
      await replyHTML(
        response,
        `I'm sorry, only <a href="tg://user?id=${initiatorId}">${initiatorName}</a> gets to choose the settings for their round.`
      );
      return this.askForNumber(conversation, initiatorId, initiatorName, range);
    }

    if (EXIT_KEYWORDS.has(response.message.text.trim().toLowerCase())) {
      await replyInThread(response, "I guess you don't love me after all...");
      return null;
    }

    const value = parseInt(response.message.text, 10);
    if (Number.isNaN(value) || value < range.min || value > range.max) {
      await replyInThread(response, `That's not a valid number — please enter a value between ${range.min} and ${range.max}.`);
      return this.askForNumber(conversation, initiatorId, initiatorName, range);
    }

    return value;
  }

  /** SCORE SUBMISSION: any message starting with "Wordle" (a pasted share) */

  private async handleScoreSubmission(ctx: MyContext) {
    if (!ctx.from || !ctx.message?.text || !ctx.chat) {
      return;
    }

    const parsed = this.parseWordleScore(ctx.message.text);
    if (!parsed) {
      await replyToMessage(ctx, "That doesn't look like a Wordle share — make sure you copy the whole thing.");
      return;
    }

    // Rejects backdated/future-dated shares (or a puzzle number just typed in by hand) — only today's
    // actual puzzle, per the NYT API, can be submitted.
    const todaysWordle = await getTodaysWordle();
    if (parsed.puzzleNumber !== todaysWordle.days_since_launch) {
      await replyToMessage(ctx, wordleGolf.NOT_TODAYS_PUZZLE);
      return;
    }

    const result = await this.storage.submitWordleGolfScore(ctx.chat.id, {
      userId: ctx.from.id,
      ...(ctx.from.username !== undefined && { username: ctx.from.username }),
      firstName: ctx.from.first_name,
      puzzleNumber: parsed.puzzleNumber,
      scoreValue: parsed.value,
      scoreLabel: parsed.label,
      rawMessage: ctx.message.text,
    });

    if (!result.ok) {
      await replyToMessage(ctx, wordleGolf.SCORE_ERROR[result.type]);
      return;
    }

    const response = wordleGolf.GOLF_SCORE_RESPONSES[parsed.value];
    await replyToMessage(
      ctx,
      response
        ? `${response.label}! ${random(response.responses)}`
        : `You have been marked down for a score of ${parsed.value}.`
    );
  }

  // A Wordle share looks like:
  //   Wordle 1,234 4/6
  //   (blank line)
  //   🟨⬜⬜⬜⬜
  //   ...
  //   🟩🟩🟩🟩🟩
  // "X/6" (failed to solve) is a special case: still 8 lines total, but the last row isn't all green.
  private parseWordleScore(message: string): ParsedWordleScore | null {
    const lines = message.split("\n");
    const title = lines[0]?.split(" ") ?? [];
    if (title[0] !== "Wordle" || !title[1] || !title[2]) {
      return null;
    }

    const puzzleNumber = parseInt(title[1].replace(/,/g, ""), 10);
    const label = title[2];
    const [guesses, outOf] = label.split("/");
    const solved = lines[lines.length - 1] === "🟩🟩🟩🟩🟩";

    if (Number.isNaN(puzzleNumber) || outOf !== "6" || !guesses) {
      return null;
    }

    if (guesses === "X") {
      return lines.length === 8 && !solved ? { puzzleNumber, value: 6.5, label } : null;
    }

    const value = parseInt(guesses, 10);
    if (value < 1 || value > 6 || lines.length !== value + 2 || !solved) {
      return null;
    }

    return { puzzleNumber, value, label };
  }

  /** /scorecard and /leaderboard */

  private async sendScorecard(ctx: MyContext) {
    if (!ctx.chat) {
      return;
    }

    const game = await this.storage.getActiveWordleGolfGame(ctx.chat.id);
    if (!game) {
      await replyToMessage(ctx, wordleGolf.NO_ACTIVE_ROUND);
      return;
    }

    const [scorecard, todaysWordle] = await Promise.all([
      this.storage.getWordleGolfScorecard(ctx.chat.id, game.id),
      getTodaysWordle(),
    ]);

    await replyHTML(ctx, this.formatScorecard(scorecard, todaysWordle.days_since_launch));
  }

  private formatScorecard(scorecard: WordleGolfScorecard, todaysPuzzleNumber: number): string {
    const { game } = scorecard;
    const completedHoles = Math.min(game.holes, Math.max(0, todaysPuzzleNumber - game.initialPuzzleNumber));

    const lines = [`<b>Current Round</b>`, `-----`, `${completedHoles} of ${game.holes} days completed`, `-----`, `Scores:`, ``];
    lines.push(...this.formatStandings(scorecard));
    lines.push(`-----`, `Mulligans are applied automatically once the round ends.`, `Thanks for playing!`);
    return lines.join("\n");
  }

  // Shared between /scorecard (mid-round) and the final "round complete" announcement.
  private formatStandings(scorecard: WordleGolfScorecard): string[] {
    const { game, players } = scorecard;
    const sorted = [...players].sort((a, b) => a.total - b.total);
    const lines: string[] = [];

    for (const player of sorted) {
      const visual = Array.from({ length: game.holes }, (_, holeIndex) => {
        const hole = player.holes.find((h) => h.puzzleNumber - game.initialPuzzleNumber === holeIndex);
        if (!hole) return " ";
        if (hole.isMulligan) return "M";
        if (hole.label === "Missed") return "X"; // didn't submit at all, vs "x" below for a played-but-failed day
        return hole.value === 6.5 ? "x" : String(hole.value);
      });
      lines.push(`<a href="tg://user?id=${player.userId}">${player.firstName}</a>: <code>${player.total}</code>`);
      lines.push(`   <code>${visual.join(" ")}</code>`);
    }

    return lines;
  }

  private async sendLeaderboard(ctx: MyContext) {
    if (!ctx.chat) {
      return;
    }

    const entries = await this.storage.getWordleGolfLeaderboard(ctx.chat.id);
    if (entries.length === 0) {
      await replyToMessage(ctx, "No completed rounds yet — finish a round of Wordle Golf first!");
      return;
    }

    await replyHTML(ctx, this.formatLeaderboard(entries));
  }

  private formatLeaderboard(entries: WordleGolfLeaderboardEntry[]): string {
    const sorted = [...entries].sort((a, b) => a.averageScore - b.averageScore);
    const lines = [`<b>Wordle Golf Leaderboard</b>`, `-----`];

    sorted.forEach((entry, index) => {
      const rounds = entry.gamesPlayed === 1 ? "round" : "rounds";
      lines.push(
        `${index + 1}. <a href="tg://user?id=${entry.userId}">${entry.firstName}</a> — <code>${entry.averageScore.toFixed(2)}</code> avg over ${entry.gamesPlayed} ${rounds}`
      );
    });

    return lines.join("\n");
  }

  /** DAILY CHECK: driven by main.ts's scheduled() handler, not by an incoming Telegram update — there's
   * no ctx here, so this takes an Api client directly and looks up every chat itself. */

  async runDailyCheck(api: Api): Promise<void> {
    const chatIds = await this.storage.listWordleGolfChats();
    if (chatIds.length === 0) {
      return;
    }

    const todaysWordle = await getTodaysWordle();

    for (const chatId of chatIds) {
      const game = await this.storage.getActiveWordleGolfGame(chatId);
      if (!game) {
        continue;
      }

      const completedHoles = Math.min(game.holes, Math.max(0, todaysWordle.days_since_launch - game.initialPuzzleNumber));
      await this.storage.backfillMissedWordleGolfDays(chatId, completedHoles);

      if (completedHoles >= game.holes) {
        await this.finalizeAndAnnounce(api, chatId, game.id);
      } else {
        await this.sendDailyReminder(api, chatId, game, completedHoles);
      }
    }
  }

  private async finalizeAndAnnounce(api: Api, chatId: number, gameId: number): Promise<void> {
    const scorecard = await this.storage.finalizeWordleGolfGame(chatId, gameId);
    const sorted = [...scorecard.players].sort((a, b) => a.total - b.total);
    const best = sorted[0];

    const lines = [`<b>Round Complete!</b>`, `-----`, `🏆🏆🏆🏆🏆`];
    if (best) {
      const winners = sorted.filter((player) => player.total === best.total);
      const names = winners.map((winner) => `<a href="tg://user?id=${winner.userId}">${winner.firstName}</a>`);
      lines.push(winners.length > 1 ? `${names.join(" and ")} win!` : `${names[0]} wins!`);
    }
    lines.push(`🏆🏆🏆🏆🏆`, `-----`, `Final results:`, ``, ...this.formatStandings(scorecard));

    await api.sendMessage(chatId, lines.join("\n"), {
      parse_mode: "HTML",
      ...(scorecard.game.threadId !== null && { message_thread_id: scorecard.game.threadId }),
    });
  }

  private async sendDailyReminder(api: Api, chatId: number, game: WordleGolfGame, completedHoles: number): Promise<void> {
    const remaining = game.holes - completedHoles;
    const message = [
      `One more day down! You have ${remaining} day${remaining === 1 ? "" : "s"} remaining!`,
      `Don't forget to submit today's score if you want to win!`,
      ``,
      `Use /scorecard to check the current standings.`,
    ].join("\n");

    await api.sendMessage(chatId, message, {
      ...(game.threadId !== null && { message_thread_id: game.threadId }),
    });
  }
}
