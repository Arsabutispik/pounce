import { summarizeRule, type Rule } from "../../engine/index.js";
import { suggestFixes, type Suggestion } from "../../parser/index.js";
import { PREFIX } from "../config.js";
import { toEvent } from "../toEvent.js";
import { lastChange } from "./audit.js";
import { NO_SUCH_RULE, replyChunks, serverChannels, takeTarget, unquote, wholeTarget, type Sub } from "./shared.js";

/*
  Creating and changing rules:  add, list, show, test, enable, disable, edit, rename, remove
*/

const add: Sub = async ({ ctx, rules, serverId, rest }) => {
  const res = await rules.addFromText(serverId, rest.trim(), ctx.authorId);
  if (res.ok) {
    await ctx.reply(`Rule **${res.rule.name}** (\`${res.rule.id}\`) added.`);
    return;
  }
  const tips = "at" in res ? suggestFixes(rest.trim(), { channels: serverChannels(ctx) }) : [];
  await replyChunks(ctx, couldNot("Couldn't add rule", res.error, tips, `${PREFIX}rule add`));
};

const list: Sub = async ({ ctx, rules, serverId }) => {
  const all = await rules.list(serverId);
  await ctx.reply(all.length ? all.map((r) => `${r.enabled ? "●" : "○"} **${r.name}** (\`${r.id}\`)`).join("\n") : "No rules yet.");
};

const show: Sub = async ({ ctx, rules, serverId, rest }) => {
  const { target } = wholeTarget(rest);
  const rule = target ? await rules.find(serverId, target) : undefined;
  if (!rule) {
    await ctx.reply(target ? NO_SUCH_RULE : "Usage: `rule show <rule>`");
    return;
  }
  const s = summarizeRule(rule);
  const text = [
    `${rule.enabled ? "●" : "○"} **${rule.name}** (\`${rule.id}\`) — ${rule.enabled ? "on" : "off"}`,
    `**When:** ${s.trigger}`,
    `**If:** ${s.conditions.length ? s.conditions.join(", and ") : "always"}`,
    `**Then:** ${s.actions.map((a, n) => `${n + 1}. ${a}`).join("  ")}`,
    ...(s.cooldown ? [`**Cooldown:** ${s.cooldown}`] : []),
    await lastChange(ctx, rules, serverId, rule.id),
    "",
    editHint(rule),
  ]
    .filter((line) => line !== null)
    .join("\n");
  await replyChunks(ctx, text); // a long rule's text can pass 2000 chars
};

const test: Sub = async ({ ctx, rules, serverId, rest }) => {
  const { target, remainder } = takeTarget(rest);
  if (!target) {
    await ctx.reply("Usage: `rule test <rule> <sample message>`");
    return;
  }
  const ev = toEvent(ctx.message, { content: unquote(remainder) });
  if (!ev) {
    await ctx.reply("Rules only work inside a server.");
    return;
  }
  const res = await rules.simulate(serverId, target, ev);
  if (!res.ok) {
    await ctx.reply(res.error);
    return;
  }
  const { rule, result } = res;
  const lines = [
    `Testing **${rule.name}** with: ${remainder ? `"${unquote(remainder)}"` : "(no sample text)"}`,
    ...(result.conditions.length
      ? result.conditions.map((c) => `${c.passed ? "✅" : "❌"} ${c.text}`)
      : ["(no conditions: always matches)"]),
    result.matched ? "**Would run.** It would:" : "**Would not run.** If it did match, it would:",
    ...result.steps.map((s, n) => `${n + 1}. ${s}`),
  ];
  if (!rule.enabled) lines.push("_This rule is disabled, so it won't run until you enable it._");
  await ctx.reply(lines.join("\n"));
};

const toggle: Sub = async ({ ctx, rules, serverId, sub, rest }) => {
  const enabled = sub === "enable";
  const { target } = wholeTarget(rest);
  if (!target) {
    await ctx.reply(`Usage: \`rule ${sub} <rule>\``);
    return;
  }
  const res = await rules.setEnabled(serverId, target, enabled, ctx.authorId);
  await ctx.reply(res.ok ? `**${res.rule.name}** is now ${enabled ? "on" : "off"}.` : `Couldn't update: ${res.error}`);
};

const edit: Sub = async ({ ctx, rules, serverId, rest }) => {
  const { target, remainder } = takeTarget(rest);
  if (!target || !remainder) {
    await ctx.reply(
      `Usage: \`${PREFIX}rule edit <rule> <new rule text>\`, e.g. \`${PREFIX}rule edit SWS when message contains "SWS" do react "🎉"\`\n` +
        `\`${PREFIX}rule show <rule>\` gives you the current text to copy.`,
    );
    return;
  }
  const res = await rules.editFromText(serverId, target, remainder, ctx.authorId);
  if (res.ok) {
    await ctx.reply(
      `Updated **${res.rule.name}**${res.rule.enabled ? "" : " (still off)"}. Check it with \`${PREFIX}rule show ${res.rule.id}\`.`,
    );
    return;
  }
  const old = await rules.find(serverId, target);
  const tips = "at" in res && old ? suggestFixes(remainder, { channels: serverChannels(ctx), defaultName: old.name }) : [];
  const ref = /\s/.test(target) ? `"${target}"` : target;
  await replyChunks(ctx, couldNot("Couldn't edit", res.error, tips, `${PREFIX}rule edit ${ref}`));
};

const rename: Sub = async ({ ctx, rules, serverId, rest }) => {
  const { target, remainder } = takeTarget(rest);
  const newName = unquote(remainder);
  if (!target || !newName) {
    await ctx.reply("Usage: `rule rename <rule> <new name>`");
    return;
  }
  const res = await rules.rename(serverId, target, newName, ctx.authorId);
  await ctx.reply(res.ok ? `Renamed to **${res.rule.name}**.` : `Couldn't rename: ${res.error}`);
};

const remove: Sub = async ({ ctx, rules, serverId, rest }) => {
  const { target } = wholeTarget(rest);
  if (!target) {
    await ctx.reply("Usage: `rule remove <rule>`");
    return;
  }
  const rule = await rules.find(serverId, target);
  if (!rule) {
    await ctx.reply(NO_SUCH_RULE);
    return;
  }
  await rules.removeRule(rule.id, ctx.authorId);
  await ctx.reply(`Rule **${rule.name}** (\`${rule.id}\`) removed.`);
};

/** For `rule show`: the rule's own text as a ready-to-send edit command, so changing it is copy, tweak, send. */
function editHint(rule: Rule): string {
  if (!rule.source) {
    return `To change it: \`${PREFIX}rule edit ${rule.id} <new rule text>\` (this rule's original text wasn't saved, so type it out once).`;
  }
  const ref = /^[^"\s]+$/.test(rule.name) ? rule.name : rule.name.includes('"') ? rule.id : `"${rule.name}"`;
  const line = `${PREFIX}rule edit ${ref} ${rule.source}`;
  return `To change it, copy, edit and send:\n${line.includes("```") ? `\`${line}\`` : `\`\`\`\n${line}\n\`\`\``}`;
}

/**
 * A failed add/edit, with "did you mean" fixes: each one ready to copy, with what it would do in plain
 * words (so people can tell whether the guess matches what they meant) and what was changed.
 */
export function couldNot(what: string, error: string, tips: Suggestion[], command: string): string {
  if (!tips.length) return `${what}: ${error}\nSee \`${PREFIX}help rules\` and \`${PREFIX}help examples\`.`;
  const blocks = tips.map((t, n) => {
    const s = t.summary;
    const when = t.rule.trigger.type === "message.created" ? "" : `when ${s.trigger}, `;
    const cond = s.conditions.length ? `if ${s.conditions.join(", and ")}, ` : "";
    const does = `${when}${cond}${s.actions.join(", then ")}${s.cooldown ? ` (cooldown ${s.cooldown})` : ""}`;
    const line = `${command} ${t.text}`;
    const code = line.includes("```") ? `\`${line}\`` : `\`\`\`\n${line}\n\`\`\``;
    // The code block must start on its own line, or the Stoat client doesn't render it.
    return `**${n + 1}.**\n${code}\n→ ${does[0].toUpperCase()}${does.slice(1)}\n_Changed: ${t.changes.join(", ")}_`;
  });
  return [`${what}: ${error}`, "", `**Did you mean${tips.length > 1 ? " one of these" : ""}?**`, ...blocks].join("\n");
}

export const manageCommands: Record<string, Sub> = {
  add, list, show, test, enable: toggle, disable: toggle, edit, rename, remove,
};
