import { z } from "zod";
import { conditions, MESSAGE_TRIGGERS } from "../../engine/index.js";
import { escapeRe, regexProblem } from "../../shared/text.js";

conditions.register("message.contains", {
  triggers: MESSAGE_TRIGGERS,
  schema: z.object({ text: z.string().min(1), wholeWord: z.boolean().default(true) }),
  test: (ev, p) => {
    const re = new RegExp(p.wholeWord === false ? escapeRe(p.text) : `\\b${escapeRe(p.text)}\\b`, "i");
    return re.test(ev.content);
  },
  describe: (p) => `message contains "${p.text}"`,
  help: {
    usage: 'message contains "<text>"',
    about: 'Whole words, any case: "SWS" matches "my SWS post" but not "SWSX".',
  },
  syntax: [{ pattern: ["message", "contains", "$str"], build: ([text]) => ({ text }) }],
});

conditions.register("message.starts_with", {
  triggers: MESSAGE_TRIGGERS,
  schema: z.object({ text: z.string().min(1) }),
  test: (ev, p) => ev.content.toLowerCase().startsWith(p.text.toLowerCase()),
  describe: (p) => `message starts with "${p.text}"`,
  help: {
    usage: 'message starts with "<text>"',
    about: 'Any case, and partial words count: "!sub" matches "!submit".',
  },
  syntax: [{ pattern: ["message", "starts", "with", "$str"], build: ([text]) => ({ text }) }],
});

conditions.register("message.matches", {
  triggers: MESSAGE_TRIGGERS,
  schema: z.object({
    pattern: z.string().min(1).superRefine((v, ctx) => {
      const problem = regexProblem(v);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }),
  }),
  // Only the first 1000 characters are searched, which also bounds the worst case.
  test: (ev, p) => new RegExp(p.pattern, "i").test(ev.content.slice(0, 1000)),
  describe: (p) => `message matches /${p.pattern}/`,
  help: {
    usage: 'message matches "<regex>"',
    about: `A regular expression, any case, checked against the first 1000 characters. Max 100 characters; patterns that could freeze the bot (nested repeats, back-references) are refused. Write \\" for a quote.`,
  },
  syntax: [{ pattern: ["message", "matches", "$str"], build: ([pattern]) => ({ pattern }) }],
});

conditions.register("message.mentions_channel", {
  triggers: MESSAGE_TRIGGERS,
  schema: z.object({ channel: z.string().min(1) }),
  test: (ev, p) => ev.mentionedChannelIds.includes(p.channel),
  describe: (p) => `message mentions <#${p.channel}>`,
  help: {
    usage: "message mentions #channel",
    about: "The message links that channel.",
  },
  syntax: [{ pattern: ["message", "mentions", "$chan"], build: ([channel]) => ({ channel }) }],
});

conditions.register("message.in_channel", {
  triggers: MESSAGE_TRIGGERS,
  schema: z.object({ channel: z.string().min(1) }),
  test: (ev, p) => ev.channelId === p.channel,
  describe: (p) => `message is sent in <#${p.channel}>`,
  help: {
    usage: "message in #channel",
    about: "The message was sent in that channel.",
  },
  syntax: [{ pattern: ["message", "in", "$chan"], build: ([channel]) => ({ channel }) }],
});

conditions.register("message.has_attachment", {
  triggers: MESSAGE_TRIGGERS,
  schema: z.object({}),
  test: (ev) => ev.attachments.length > 0,
  describe: () => "message has an attachment",
  help: {
    usage: "message has attachment",
    about: "The message has at least one file or image.",
  },
  syntax: [{ pattern: ["message", "has", "attachment"], build: () => ({}) }],
});
