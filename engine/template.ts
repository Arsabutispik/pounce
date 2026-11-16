import type { RuleEvent } from "./types.js";

/** "{author} posted in {channel}" -> real mentions. Unknown keys are left as-is. */
export function render(template: string, ev: RuleEvent): string {
  const vars: Record<string, string> = {
    author: `<@${ev.authorId}>`,
    "author.name": ev.authorName,
    channel: `<#${ev.channelId}>`,
    message: ev.content,
    "message.id": ev.messageId,
  };
  if (ev.reaction) {
    vars.reactor = `<@${ev.reaction.userId}>`;
    vars["reactor.name"] = ev.reaction.userName;
  }
  return template.replace(/\{([\w.]+)\}/g, (m, key) => vars[key] ?? m);
}

export function renderParams(params: Record<string, unknown>, ev: RuleEvent) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) out[k] = typeof v === "string" ? render(v, ev) : v;
  return out;
}
