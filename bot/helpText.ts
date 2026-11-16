import { actions, conditions, triggers, type BlockHelp, type Registry } from "../engine/index.js";

/*
  Text for `!help`. Pure (no stoatx), so tests can check every page fits Stoat's 2000-character limit.

  - Block references (triggers, conditions, actions) are built from each block's own `help`, so a new
    block shows up here automatically. Everything else is written by hand below.
  - The overview is posted in the channel. A topic is posted in the channel only if it's short
    (CHANNEL_MAX); longer ones go to the user's DMs (see bot/help.ts).
*/

export const MESSAGE_MAX = 2000; // Stoat's limit per message
export const CHUNK_MAX = 1900; // headroom for the fence fixes splitMessage adds
export const CHANNEL_MAX = 900; // longer help goes to DMs so it doesn't fill the channel

export type Topic = { key: string; title: string; summary: string; text: (p: string) => string };

/** "`usage`\nabout" for each block that declares help, in registration order. */
function blockList(reg: Registry<{ help?: BlockHelp }>): string {
  return reg
    .entries()
    .flatMap(([, def]) => (def.help ? [`\`${def.help.usage}\`\n${def.help.about}`] : []))
    .join("\n\n");
}

export const TOPICS: Topic[] = [
  {
    key: "rules",
    title: "How a rule is put together",
    summary: "the parts of a rule: and, or, not, then, quotes",
    text: (p) => `**How a rule is put together**
\`\`\`
["Name"] <trigger> [when <conditions>] do <actions> [with cooldown <time> [per user]]
\`\`\`
**Name** (optional, in "quotes"): how you refer to the rule later. Unique per server, max 60 characters. Without one it's called "Rule <id>".
**Trigger**: what starts the rule. Starting with \`when\` means "on every new message". Other triggers (\`every …\`, \`on reaction …\`) come first and can be followed by \`when\`. See \`${p}help triggers\`.
**Conditions** (after \`when\`): checks that must pass.
• Join them with \`and\` / \`or\`, and put \`not\` before any one.
• \`and\` binds tighter than \`or\`: \`a and b or c\` means (a and b) or c. There are no brackets.
**Actions** (after \`do\`): run in order, joined with \`then\`. Write \`do\` only once. Max 5. If one fails, the rest are skipped.
**Cooldown** (optional, at the very end): see \`${p}help cooldown\`.

**Writing values**
• Text goes in "double quotes". Inside, write \\" for a quote and \\\\ for a backslash.
• Channels must be real links: type \`#\` and pick the channel. A plain name like \`General\` doesn't work.
• Emoji: a normal one ("🎉") or a custom emoji id (":01J…:").
• Keywords like \`when\`, \`do\` and \`then\` work in any case.

If a rule doesn't parse, the bot suggests fixed versions, each with what it would do. Check the explanation matches what you meant before copying one.
Rules ignore messages from bots, including this bot's own posts, so rules can't set each other off in a loop.`,
  },
  {
    key: "triggers",
    title: "Triggers",
    summary: "what starts a rule: messages, schedules, reactions",
    text: () => `**Triggers**: what starts a rule

\`when <conditions> do …\`
The default: every new message in the server. Bot messages and commands are skipped.

${blockList(triggers)}`,
  },
  {
    key: "conditions",
    title: "Conditions",
    summary: "every check you can use after `when`",
    text: () => `**Conditions**: checks after \`when\`. Put \`not\` before any one to flip it.

${blockList(conditions)}

Message and author checks need a message, so they work on message and reaction rules, not scheduled ones.`,
  },
  {
    key: "actions",
    title: "Actions",
    summary: "everything a rule can do",
    text: (p) => `**Actions**: what the rule does, after \`do\`. Join several with \`then\` (max 5).

${blockList(actions)}

Text in \`send\` and \`reply\` can use placeholders like {author} (see \`${p}help templates\`).`,
  },
  {
    key: "templates",
    title: "Templates",
    summary: "placeholders like {author} and {message}",
    text: () => `**Templates**: placeholders in quoted text, filled in when the rule runs.
\`{author}\` mentions the message author
\`{author.name}\` the author's name, without a ping
\`{channel}\` links the channel the message is in
\`{message}\` the message text
\`{message.id}\` the message id
\`{reactor}\` / \`{reactor.name}\` reaction rules: who reacted
Scheduled rules have no message, so these stay empty there. Unknown placeholders are left as typed.`,
  },
  {
    key: "cooldown",
    title: "Cooldown",
    summary: "stop a rule from running too often",
    text: () => `**Cooldown**: after a rule runs, it stays quiet for a while.
\`… do reply "hey" with cooldown 5m\`
\`… with cooldown 1h per user\`
• Times: \`30s\`, \`5m\`, \`2h\`, \`1d\`, or combined like \`1h30m\`. Max 7 days.
• Without \`per user\`, one person's message silences the rule for everyone. With it, each author has their own cooldown. Use \`per user\` for rules that handle submissions, or other people's posts get skipped.
• Only real runs start it: messages that don't match the conditions, and \`rule test\`, don't.
• Cooldowns reset when the bot restarts.`,
  },
  {
    key: "commands",
    title: "Commands",
    summary: "add, show, test, edit, remove, history, logs, export, import…",
    text: (p) => `**Commands** (need the **Manage Server** permission)
\`${p}rule add <rule>\` create a rule (see \`${p}help rules\`)
\`${p}rule list\` all rules here, ● on / ○ off
\`${p}rule show <rule>\` explain a rule in plain words
\`${p}rule test <rule> <sample text>\` check what a rule would do with that text, without doing it
\`${p}rule enable <rule>\` / \`${p}rule disable <rule>\` turn a rule on or off
\`${p}rule edit <rule> <new rule text>\` change what a rule does. It keeps its name, id and on/off. \`rule show\` gives you the current text to copy.
\`${p}rule rename <rule> <new name>\`
\`${p}rule remove <rule>\` delete it for good
\`${p}rule history [<rule>]\` who added, edited, turned off or removed rules, and when. Works for removed rules too, and shows how to add one back.
\`${p}rule logs\` recent rule failures (a missing permission, a deleted channel…)
\`${p}rule logs channel #channel\` also post new failures there (\`off\` to stop)
\`${p}rule export [<rule>]\` save all rules (or one) as a file, to back up or share
\`${p}rule import [replace]\` attach an exported file to load its rules. Same-name rules are skipped, or overwritten with \`replace\`. Rules that use channels this server doesn't have are imported turned off.

\`<rule>\` is the rule's name or its id (shown in \`rule list\`). Quotes are optional, except in \`test\` and \`rename\`, where a name with spaces needs "quotes" because more text follows.
Commands never set off rules.`,
  },
  {
    key: "examples",
    title: "Examples",
    summary: "ready-to-use rules to copy",
    text: (p) => `**Examples** (replace #channel with a real channel link)

Forward submissions under the author's name, with their files, and mark both copies:
\`${p}rule add "SWS" when message contains "SWS" do react "👀" then send "{message}" to #channel with masquerade and files then react "✅" to sent\`

Starboard: repost anything that gets 3 stars:
\`${p}rule add "Starboard" on reaction "⭐" reaches 3 do send "{message}" to #channel with masquerade and files\`

Mod approval: a mod's ✅ publishes a post:
\`${p}rule add "Approve" on reaction "✅" when reactor has role "Mod" do send "{message}" to #channel with masquerade and files\`

Weekly reminder:
\`${p}rule add "Wins" every sunday at 18:00 in "Europe/Istanbul" do send "Share your small wins!" to #channel\`

Quiet hours, at most once an hour per person:
\`${p}rule add "Night" when time between "23:00" to "07:00" and not author has role "Mod" do reply "Mods are asleep, we'll get back to you." with cooldown 1h per user\`

Links in one channel only:
\`${p}rule add "Links" when message matches "https?://" and not message in #channel do reply "Please post links in #channel"\``,
  },
];

export const findTopic = (key: string) => {
  const k = key.trim().toLowerCase();
  return TOPICS.find((t) => t.key === k || t.key === `${k}s` || `${t.key}s` === k);
};

/** The `!help` reply: always posted in the channel, so it stays short. */
export function overview(p: string): string {
  const topics = TOPICS.map((t) => `\`${t.key}\` ${t.summary}`).join("\n");
  return `**Pounce** runs rules written in plain words: *when* something happens, *if* checks pass, *do* actions.
\`${p}rule add "Hi" when message contains "hello" do react "👋"\`

**Learn more:** \`${p}help <topic>\`
${topics}
\`all\` everything above

Longer topics are sent by DM so they don't fill the channel.`;
}

/**
 * Split text into messages of at most `max` characters, on line breaks where possible.
 * A code block cut in two is closed at the end of one message and reopened in the next.
 */
export function splitMessage(text: string, max = CHUNK_MAX): string[] {
  const chunks: string[] = [];
  let cur = "";
  let inFence = false; // is `cur` inside an open ``` block?

  const flush = () => {
    if (!cur.trim()) return;
    chunks.push(inFence ? `${cur}\n\`\`\`` : cur);
    cur = inFence ? "```" : "";
  };

  for (let line of text.split("\n")) {
    // A single line longer than a message: cut it hard.
    while (line.length > max - 10) {
      flush();
      chunks.push(line.slice(0, max - 10));
      line = line.slice(max - 10);
    }
    const next = cur ? `${cur}\n${line}` : line;
    if (next.length > max - 4) {
      flush();
      cur = cur ? `${cur}\n${line}` : line;
    } else cur = next;
    if (line.trimStart().startsWith("```")) inFence = !inFence;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}
