import type { CommandContext } from "stoatx";
import { splitMessage } from "../helpText.js";
import type { RulesService } from "../RulesService.js";

/** What every `rule <sub>` handler gets. */
export type SubContext = {
  ctx: CommandContext;
  rules: RulesService;
  serverId: string;
  sub: string; // the subcommand as typed, lowercased ("add", "enable", ...)
  rest: string; // everything after it, curly quotes made plain (see argsAfterSub)
};

export type Sub = (c: SubContext) => Promise<void>;

/**
 * Everything after "<prefix>rule <sub>", whichever prefix was used (text prefix or @mention).
 * Curly quotes become plain ones, unless `raw` (pasted JSON, where they may be part of the rule's text).
 */
export function argsAfterSub(ctx: CommandContext, raw = false): string {
  const afterPrefix = ctx.content.slice(ctx.prefix.length).trim(); // "rule add ..."
  const rest = afterPrefix.match(/^\S+\s+\S+\s*([\s\S]*)$/)?.[1] ?? "";
  // Phones and some clients auto-replace " with curly quotes; treat them as plain quotes.
  return raw ? rest : rest.replace(/[“”„‟«»]/g, '"');
}

/** Read a rule reference off the front of `rest`: a "quoted name", or one word (an id or a one-word name). */
export function takeTarget(rest: string): { target: string; remainder: string } {
  const s = rest.trim();
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    if (end > 0) return { target: s.slice(1, end).trim(), remainder: s.slice(end + 1).trim() };
  }
  const m = s.match(/^(\S+)\s*([\s\S]*)$/);
  return { target: m?.[1] ?? "", remainder: m?.[2] ?? "" };
}

export const unquote = (s: string) => s.trim().replace(/^"([\s\S]*)"$/, "$1").trim();

/** For commands whose only argument is a rule: all of `rest` is the reference, so quotes are optional. */
export const wholeTarget = (rest: string) => ({ target: unquote(rest) });

/** Reply with text of any length, split to fit Stoat's 2000-character limit. */
export async function replyChunks(ctx: CommandContext, text: string) {
  for (const chunk of splitMessage(text)) await ctx.reply(chunk);
}

export const NO_SUCH_RULE = "No rule with that id or name in this server.";

/** "just now", "5m ago", "3h ago", "2d ago", then the date. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Display names for user ids (no mentions, so listing them doesn't ping anyone). */
export async function userNames(ctx: CommandContext, ids: (string | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  const found = await Promise.all(
    unique.map((id) =>
      ctx.client.users
        .fetch(id)
        .then((u) => [id, u.displayName || u.username] as const)
        .catch(() => undefined),
    ),
  );
  return new Map(found.filter((x) => x !== undefined));
}

/** This server's channels by name, so a suggestion can turn "General" into a real channel link. */
export function serverChannels(ctx: CommandContext): { id: string; name: string }[] {
  const ids = ctx.message.server?.channelIds ?? [];
  return ids.flatMap((id) => {
    const name = (ctx.client.channels.cache.get(id) as { name?: string } | undefined)?.name;
    return name ? [{ id, name }] : [];
  });
}
