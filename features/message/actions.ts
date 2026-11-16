import { z } from "zod";
import { actions, MESSAGE_TRIGGERS, type Syntax } from "../../engine/index.js";
import { emojiSchema } from "../../shared/emoji.js";

/*
  send "text" [to <#channel>] [with masquerade] [with files]

    send "Thanks {author}!"
    send "{message}" to <#submissions> with masquerade and files

  - with masquerade: the new message shows the original author's name and avatar
    (the bot needs the Masquerade permission in that channel)
  - with files: copies the original message's attachments into the new message
  Both copy from the message that triggered the rule, so they only work on message rules.
*/

// Every combination of the optional parts, generated instead of written out by hand.
const MODIFIERS: { words: string[]; params: { masquerade?: boolean; files?: boolean } }[] = [
  { words: ["with", "masquerade", "and", "files"], params: { masquerade: true, files: true } },
  { words: ["with", "files", "and", "masquerade"], params: { masquerade: true, files: true } },
  { words: ["with", "masquerade"], params: { masquerade: true } },
  { words: ["with", "files"], params: { files: true } },
  { words: [], params: {} },
];

const sendSyntax: Syntax[] = [];
for (const dest of [["to", "$chan"], []] as string[][]) {
  for (const mod of MODIFIERS) {
    sendSyntax.push({
      pattern: ["send", "$str", ...dest, ...mod.words],
      build: (args) => ({ text: args[0], ...(dest.length ? { channel: args[1] } : {}), ...mod.params }),
    });
  }
}

actions.register("message.send", {
  schema: z.object({
    channel: z.string().optional(),
    // May be empty after templates expand ("{message}" on a file-only message), if files are forwarded.
    text: z.string().max(2000),
    masquerade: z.boolean().default(false),
    files: z.boolean().default(false),
  }),
  run: async (ev, p, env, run) => {
    const files = p.files ? ev.attachments : [];
    if (!p.text && files.length === 0) throw new Error("nothing to send: the message had no text and no files");
    // Remember where it landed, so a later `react "..." to sent` can find it.
    run.sent = await env.send(p.channel ?? ev.channelId, p.text, {
      masquerade: p.masquerade ? { name: ev.authorName || "Unknown", avatarUrl: ev.authorAvatarUrl } : undefined,
      files: files.length ? files : undefined,
    });
  },
  describe: (p) => {
    const extras = [p.masquerade && "masquerade", p.files && "files"].filter(Boolean).join(" and ");
    return `send "${p.text}" to ${p.channel ? `<#${p.channel}>` : "the same channel"}${extras ? ` with ${extras}` : ""}`;
  },
  check: (p, trigger) => {
    const onMessage = MESSAGE_TRIGGERS.includes(trigger);
    if (!onMessage && !p.channel) return 'A scheduled rule must say where to send: send "..." to <#channel>';
    if (!onMessage && (p.masquerade || p.files)) {
      return "Masquerade and files copy from the triggering message, so they only work on message rules";
    }
    if (!p.text && !p.files) return "Message text can't be empty (unless the rule forwards files)";
    return undefined;
  },
  help: {
    usage: 'send "<text>" [to #channel] [with masquerade | with files | with masquerade and files]',
    about: "Posts a message (max 2000 characters) in the same channel, or the one after `to`. `masquerade` posts under the original author's name and avatar (the bot needs the Masquerade permission). `files` copies the original message's attachments. Both need a message or reaction rule.",
  },
  syntax: sendSyntax,
});

actions.register("message.reply", {
  triggers: MESSAGE_TRIGGERS,
  schema: z.object({ text: z.string().min(1).max(2000) }),
  run: (ev, p, env) => env.send(ev.channelId, p.text, { replyTo: ev.messageId }),
  describe: (p) => `reply "${p.text}"`,
  help: {
    usage: 'reply "<text>"',
    about: "Replies to the message without pinging its author.",
  },
  syntax: [{ pattern: ["reply", "$str"], build: ([text]) => ({ text }) }],
});

/*
  react "🎉"            reacts to the message that triggered the rule
  react "🎉" to sent    reacts to the message an earlier `send` in this rule posted

  The emoji is a unicode emoji ("🎉") or a custom emoji id ("01J..." or ":01J...:").
  The bot needs the React permission in that channel.
*/

actions.register("message.react", {
  schema: z.object({ emoji: emojiSchema, target: z.enum(["message", "sent"]).default("message") }),
  run: async (ev, p, env, run) => {
    if (p.target === "sent") {
      if (!run.sent) throw new Error("nothing was sent earlier in this rule, so there is no message to react to");
      return env.react(run.sent.channelId, run.sent.messageId, p.emoji);
    }
    return env.react(ev.channelId, ev.messageId, p.emoji);
  },
  describe: (p) => `react with ${p.emoji}${p.target === "sent" ? " to the sent message" : ""}`,
  check: (p, trigger, all, index) => {
    if (p.target === "sent") {
      const sentBefore = all.slice(0, index).some((a) => a.type === "message.send");
      return sentBefore ? undefined : '"react ... to sent" needs a send action before it in the same rule';
    }
    // Reacting to the triggering message needs one; a scheduled rule can still react to what it sent.
    if (!MESSAGE_TRIGGERS.includes(trigger)) {
      return `"react with ${p.emoji}" can't be used with a ${trigger} trigger (it needs a message); use "react ... to sent" after a send`;
    }
    return undefined;
  },
  help: {
    usage: 'react "<emoji>" [to sent]',
    about: "Reacts to the message, or with `to sent`, to the message an earlier `send` in this rule posted. The bot needs the React permission.",
  },
  syntax: [
    { pattern: ["react", "$str", "to", "sent"], build: ([emoji]) => ({ emoji, target: "sent" }) },
    { pattern: ["react", "$str"], build: ([emoji]) => ({ emoji }) },
  ],
});
