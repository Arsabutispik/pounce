import type { CommandContext } from "stoatx";
import type { HistoryAction } from "../../db/PostgresRuleStore.js";
import { PREFIX } from "../config.js";
import type { RulesService } from "../RulesService.js";
import { ago, replyChunks, userNames, wholeTarget, type Sub } from "./shared.js";

/*
  Looking back:  rule logs, rule logs channel #channel|off, rule history [<rule>]
*/

export const VERBS: Record<HistoryAction, string> = {
  added: "added", edited: "edited", renamed: "renamed", enabled: "turned on", disabled: "turned off",
  removed: "removed", imported: "imported", replaced: "replaced by an import",
};

/** "Last change: edited by Alice, 2h ago" for `rule show`, or null if there's no history. */
export async function lastChange(ctx: CommandContext, rules: RulesService, serverId: string, ruleId: string): Promise<string | null> {
  const last = (await rules.history(serverId, ruleId, 1).catch(() => undefined))?.[0];
  if (!last) return null;
  const who = last.userId ? ` by ${(await userNames(ctx, [last.userId])).get(last.userId) ?? `\`${last.userId}\``}` : "";
  return `_Last change: ${VERBS[last.action]}${who}, ${ago(last.at)}. Full list: \`${PREFIX}rule history ${ruleId}\`_`;
}

const logs: Sub = async ({ ctx, rules, serverId, rest }) => {
  const setting = rest.trim().match(/^channel\b\s*([\s\S]*)$/i);
  if (setting) return logChannel(ctx, rules, serverId, setting[1].trim());

  const failures = rules.recentFailures(serverId).slice(0, 15);
  const where = rules.logChannel(serverId);
  const footer = where
    ? `New failures are also posted in <#${where}>.`
    : `Tip: \`${PREFIX}rule logs channel #channel\` posts new failures there as they happen.`;
  if (!failures.length) {
    await ctx.reply(`No recent rule failures. ✅\n${footer}`);
    return;
  }
  const lines = failures.map((f) => {
    const times = f.count > 1 ? ` (${f.count} times since ${ago(f.first)})` : "";
    return `• **${f.ruleName}** (\`${f.ruleId}\`), ${ago(f.last)}${times}\n  ${f.error}`;
  });
  await replyChunks(ctx, [`**Recent rule failures** (newest first)`, ...lines, "", footer].join("\n"));
};

async function logChannel(ctx: CommandContext, rules: RulesService, serverId: string, value: string) {
  const current = rules.logChannel(serverId);
  if (!value) {
    await ctx.reply(
      current
        ? `Rule failures are posted in <#${current}>. Stop with \`${PREFIX}rule logs channel off\`.`
        : `No log channel. Set one with \`${PREFIX}rule logs channel #channel\`.`,
    );
    return;
  }
  const off = /^(off|none|stop)$/i.test(value);
  const channelId = off ? null : value.match(/^<#(\w+)>$/)?.[1];
  if (channelId === undefined) {
    await ctx.reply(`Usage: \`${PREFIX}rule logs channel #channel\` (type # and pick it) or \`${PREFIX}rule logs channel off\``);
    return;
  }
  const res = await rules.setLogChannel(serverId, channelId);
  await ctx.reply(
    !res.ok
      ? `Couldn't set the log channel: ${res.error}`
      : channelId
        ? `Rule failures will be posted in <#${channelId}> (the same failure at most once per 10 minutes).`
        : "Stopped posting rule failures.",
  );
}

const history: Sub = async ({ ctx, rules, serverId, rest }) => {
  const { target } = wholeTarget(rest);
  const entries = await rules.history(serverId, target || undefined);
  if (!entries?.length) {
    await ctx.reply(target ? "No history for that rule." : "No rule changes recorded yet.");
    return;
  }
  const names = await userNames(ctx, entries.map((e) => e.userId));
  const lines = entries.map((e) => {
    const who = e.userId ? ` by ${names.get(e.userId) ?? `\`${e.userId}\``}` : "";
    const detail = e.action === "renamed" ? `: ${e.detail}` : "";
    return `• ${ago(e.at)}: **${e.ruleName}** ${VERBS[e.action]}${who}${detail}`;
  });
  const out = [target ? `**History of ${entries[0].ruleName}**` : "**Recent rule changes**", ...lines];
  // A removed rule can be added back from its last saved text.
  const latest = entries[0];
  if (target && latest.action === "removed" && latest.detail) {
    const line = `${PREFIX}rule add "${latest.ruleName}" ${latest.detail}`;
    if (!line.includes("```")) out.push("", "It was removed. To add it back:", "```", line, "```");
  }
  await replyChunks(ctx, out.join("\n"));
};

export const auditCommands: Record<string, Sub> = { logs, history };
