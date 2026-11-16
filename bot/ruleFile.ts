import { isDeepStrictEqual } from "node:util";
import type { Block, Rule } from "../engine/index.js";
import { parseRule } from "../parser/index.js";

/*
  The rule export/import file. Pure (no stoatx, no database), so it's easy to test.

  {
    "format": "pounce-rules",
    "version": 1,
    "exportedAt": "2026-11-16T12:00:00.000Z",
    "rules": [ { "name": "...", "enabled": true, "trigger": {...}, "conditions": [...], "actions": [...] } ]
  }

  Rules are stored without their id and server: an import always creates rules in the importing server
  with fresh ids, so a file can't overwrite another server's rules. Everything else is the rule's own JSON,
  so nothing is lost and the engine validates it again on import.
*/

export const FILE_FORMAT = "pounce-rules";
export const FILE_VERSION = 1;
export const MAX_IMPORT_BYTES = 256 * 1024;
export const MAX_IMPORT_RULES = 100;

/** A rule as it appears in the file. */
export type PortableRule = Pick<Rule, "name" | "enabled" | "schemaVersion" | "trigger" | "conditions" | "actions"> &
  Pick<Rule, "cooldownMs" | "cooldownPerUser" | "source">;

export function toPortable(rule: Rule): PortableRule {
  const { name, enabled, schemaVersion, trigger, conditions, actions, cooldownMs, cooldownPerUser, source } = rule;
  return { name, enabled, schemaVersion, trigger, conditions, actions, cooldownMs, cooldownPerUser, source };
}

export function exportRules(rules: Rule[], now = new Date()): string {
  const file = { format: FILE_FORMAT, version: FILE_VERSION, exportedAt: now.toISOString(), rules: rules.map(toPortable) };
  return JSON.stringify(file, null, 2);
}

export type ParsedImport = { ok: true; rules: PortableRule[] } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isBlock = (v: unknown): v is Block => isObject(v) && typeof v.type === "string" && isObject(v.params);

/**
 * Read a file's text. Checks the shape only (so the engine never sees garbage); whether the blocks
 * themselves are valid is checked per rule when it's added, so one bad rule doesn't sink the whole file.
 * Accepts the file object, or a bare rule / array of rules (handy for pasting one rule in chat).
 */
export function parseImport(text: string): ParsedImport {
  let data: unknown;
  try {
    data = JSON.parse(stripCodeFence(text));
  } catch (e) {
    return { ok: false, error: `That isn't valid JSON (${(e as Error).message.slice(0, 120)})` };
  }

  let list: unknown;
  if (isObject(data) && "format" in data) {
    if (data.format !== FILE_FORMAT) return { ok: false, error: "That isn't a rules export file" };
    if (data.version !== FILE_VERSION) {
      return { ok: false, error: `This file is version ${String(data.version)}; this bot reads version ${FILE_VERSION}` };
    }
    list = data.rules;
  } else list = Array.isArray(data) ? data : [data];

  if (!Array.isArray(list) || list.length === 0) return { ok: false, error: "The file has no rules in it" };
  if (list.length > MAX_IMPORT_RULES) return { ok: false, error: `Too many rules in one file (max ${MAX_IMPORT_RULES})` };

  const rules: PortableRule[] = [];
  for (const [i, r] of list.entries()) {
    const where = `Rule ${i + 1}${isObject(r) && typeof r.name === "string" ? ` ("${r.name.slice(0, 60)}")` : ""}`;
    if (!isObject(r)) return { ok: false, error: `${where} isn't a rule` };
    if (typeof r.name !== "string" || !r.name.trim()) return { ok: false, error: `${where} has no name` };
    if (!isBlock(r.trigger)) return { ok: false, error: `${where} has no valid trigger` };
    for (const key of ["conditions", "actions"] as const) {
      const blocks = r[key];
      if (!Array.isArray(blocks) || !blocks.every(isBlock)) return { ok: false, error: `${where}: "${key}" is malformed` };
    }
    if ((r.schemaVersion ?? 1) !== 1) return { ok: false, error: `${where} uses an unknown schema version` };
    if (r.cooldownMs !== undefined && typeof r.cooldownMs !== "number") return { ok: false, error: `${where}: bad cooldown` };
    const rule: PortableRule = {
      name: r.name.trim(),
      enabled: r.enabled !== false,
      schemaVersion: 1,
      trigger: r.trigger,
      conditions: r.conditions as Block[],
      actions: r.actions as Block[],
      ...(r.cooldownMs !== undefined ? { cooldownMs: r.cooldownMs } : {}),
      ...(r.cooldownPerUser === true ? { cooldownPerUser: true } : {}),
    };
    if (typeof r.source === "string" && sourceMatches(r.source, rule)) rule.source = r.source;
    rules.push(rule);
  }
  return { ok: true, rules };
}

/** ```json ... ``` or ``` ... ``` around pasted text. */
function stripCodeFence(text: string): string {
  const m = text.trim().match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return m ? m[1] : text.trim();
}

/**
 * Every channel a rule points at: `channel` params anywhere (including inside "or" groups), and
 * <#id> links inside text. Generic on purpose, so blocks added later are covered too.
 */
export function channelRefs(rule: Pick<Rule, "trigger" | "conditions" | "actions">): string[] {
  const found = new Set<string>();
  const walk = (v: unknown, key?: string) => {
    if (typeof v === "string") {
      if (key === "channel") found.add(v);
      for (const m of v.matchAll(/<#(\w+)>/g)) found.add(m[1]);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (isObject(v)) for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk([rule.trigger, rule.conditions, rule.actions]);
  return [...found];
}

/**
 * Does the saved rule text still produce exactly this rule? It won't if someone edited the file by hand
 * (e.g. fixed a channel id); then the text is dropped rather than shown as if it were the rule.
 */
function sourceMatches(source: string, rule: PortableRule): boolean {
  if (source.length > 4000) return false;
  const parsed = parseRule(source, { id: "check", serverId: "check" });
  if (!parsed.ok) return false;
  const what = (r: Partial<Rule>) =>
    JSON.parse(JSON.stringify({ t: r.trigger, c: r.conditions, a: r.actions, cd: r.cooldownMs, pu: r.cooldownPerUser ?? false }));
  return isDeepStrictEqual(what(parsed.rule), what(rule)); // key order may differ (Postgres jsonb reorders keys)
}
