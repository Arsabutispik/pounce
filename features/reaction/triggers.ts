import { z } from "zod";
import { triggers } from "../../engine/index.js";
import { emojiSchema, sameEmoji, showEmoji } from "../../shared/emoji.js";

/*
  on reaction "<emoji>" [reaches <n>]

    "Starboard" on reaction "⭐" reaches 3 do send "{message}" to <#highlights> with masquerade and files
    on reaction "✅" when reactor has role "Mod" do send "{message}" to <#approved> with masquerade and files

  Without "reaches", fires when anyone adds the emoji. With "reaches n", fires when the count becomes n.
  The reacted message is "the message" for every other block: {message}, {author}, message conditions,
  react, send ... with files, etc.
  {reactor} / {reactor.name} are who added the reaction.

  - Once per message per rule: more reactions, or removing and re-adding one, don't fire it again.
    Remembered in the database (rule_fires) for 90 days, so restarts don't repost.
  - Reactions on bot messages and reactions by bots are ignored, so a starboard never stars its own reposts.
*/
triggers.register("reaction.added", {
  schema: z.object({ emoji: emojiSchema, count: z.number().int().min(1).max(100).default(1) }),
  describe: (p) =>
    p.count > 1 ? `a message reaches ${p.count} ${showEmoji(p.emoji)} reactions` : `someone reacts with ${showEmoji(p.emoji)}`,
  // Plain "on reaction": any reaction counts, so a mod's ✅ works even if someone else reacted first.
  // "reaches n": exactly at n, so after a restart (which forgets what already fired) the 4th star doesn't repost.
  matches: (p, ev) =>
    !!ev.reaction && sameEmoji(ev.reaction.emoji, p.emoji) && (p.count === 1 || ev.reaction.count === p.count),
  oncePerMessage: true,
  help: {
    usage: 'on reaction "<emoji>" [reaches <n>]',
    about: 'Runs when someone reacts. Without `reaches`: every time anyone adds that emoji. With `reaches 3`: when the count becomes 3. Fires once per message per rule, even after restarts. The reacted message is "the message" for checks, templates and actions. Reactions on bot messages and reactions by bots are ignored.',
  },
  syntax: [
    { pattern: ["on", "reaction", "$str", "reaches", "$word"], build: ([emoji, n]) => ({ emoji, count: Number(n) }) },
    { pattern: ["on", "reaction", "$str"], build: ([emoji]) => ({ emoji }) },
  ],
});
