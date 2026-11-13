import { Composer, InputFile } from "grammy";
import { random } from "./util.js";
import type { StorageService } from "./storage-service.js";
import { type MyContext, replyPhoto } from "./context.js";
import beenMentionedPhoto from "../assets/beens_mentioned.jpg";
import beenMentionedPhoto2 from "../assets/beens_mentioned_2.jpg";

const BEEN_PHOTOS = [beenMentionedPhoto, beenMentionedPhoto2];

// The "beans" feature (see features.ts). "been"/"beens" increments the tally silently — the word is
// common enough in normal chat that replying every time would be spammy. Saying "bean"/"beans" instead
// (a nod to the bot's name) triggers the announcement below, reporting the current tally without bumping
// it further. Neither handler calls next(), so a message containing either word is never also seen by the
// rude composers registered after this one.
export class BeanCounterComposer extends Composer<MyContext> {
  constructor(private storage: StorageService) {
    super();

    this.hears(/(?<!@)\bbeens?\b/i, async (ctx) => {
      const occurrences = ctx.message?.text?.match(/(?<!@)\bbeens?\b/gi)?.length ?? 1;
      await this.storage.incrementBeenCounter(`been_counter_${ctx.chat.id}`, occurrences);
    });

    this.hears(/(?<!@)\bbeans?\b/i, async (ctx) => {
      const occurrences = ctx.message?.text?.match(/(?<!@)\bbeans?\b/gi)?.length ?? 1;
      const [beenCount] = await Promise.all([
        this.storage.incrementBeenCounter(`been_counter_${ctx.chat.id}`, 0),
        this.storage.incrementBeanCounter(`bean_counter_${ctx.chat.id}`, occurrences),
      ]);
      const photo = new InputFile(new Uint8Array(random(BEEN_PHOTOS)), "beens_mentioned.jpg");
      await replyPhoto(ctx, photo, `Been count: <b>${beenCount}</b>`);
    });
  }
}
