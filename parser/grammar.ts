import { actions, ANY_GROUP, conditions, triggers, type Block, type Rule } from "../engine/index.js";
import { buildTable, matchAt } from "./match.js";
import { parseDuration } from "../shared/time.js";
import { isWord, renderTokens, tokenize, type Token } from "./tokenizer.js";

/*
  Grammar (knows nothing about specific blocks; they declare their own syntax):

    ["name"] when <conditions> do <actions>                  on every new message
    ["name"] <trigger> [when <conditions>] do <actions>      e.g. every sunday at 09:00 in "Europe/Istanbul"
                                                             or on reaction "⭐" reaches 3

    <conditions> :=  [not] <condition> ((and | or) [not] <condition>)*
    <actions>    :=  <action> (then <action>)* [with cooldown <duration> [per user]]

  Cooldown: after the rule runs it stays quiet for <duration> (30s, 5m, 2h, 1d, 1h30m).
  "per user" counts it separately for each author, so one person's message doesn't block everyone else's.

  "and" binds tighter than "or":  a and b or c  =>  (a and b) or c
  The quoted name is optional; without one the rule is called "Rule <id>".
*/

/**
 * On failure, `at` is the token index where parsing stopped and `blockStart` where the block being read
 * (or the last one read) begins. parser/suggest.ts uses them to look for fixes in the right place.
 */
export type ParseResult = { ok: true; rule: Rule } | { ok: false; error: string; at?: number; blockStart?: number };

type Meta = { id: string; serverId: string; defaultName?: string };

export function parseRule(text: string, meta: Meta): ParseResult {
  return parseTokens(tokenize(text), meta, text);
}

/** Parse already-tokenized rule text. `text` (the original) is kept as the rule's source if given. */
export function parseTokens(t: Token[], meta: Meta, text = renderTokens(t)): ParseResult {
  const trigTable = buildTable(triggers);
  const condTable = buildTable(conditions);
  const actTable = buildTable(actions);
  let i = 0;
  let blockStart = 0;

  const fail = (msg: string): ParseResult => ({
    ok: false,
    error: `${msg} (near: ${renderTokens(t.slice(i, i + 4)) || "end of input"})`,
    at: i,
    blockStart,
  });

  // Optional name: a quoted string at the very start
  let name = meta.defaultName ?? `Rule ${meta.id}`;
  if (t[i]?.kind === "str") { name = t[i].v.trim(); i++; }

  // Trigger
  let trigger: Block = { type: "message.created", params: {} };
  let hasWhen = false;
  if (isWord(t[i], "when")) {
    hasWhen = true;
    i++;
  } else {
    blockStart = i;
    const m = matchAt(t, i, trigTable);
    if (!m) return fail('Rule must start with "when", or with a trigger like: every sunday at 09:00, or on reaction "⭐"');
    trigger = m.block;
    i = m.next;
    if (isWord(t[i], "when")) { hasWhen = true; i++; }
  }

  // Conditions ("and" binds tighter than "or")
  let conds: Block[] = [];
  if (hasWhen) {
    const groups: Block[][] = [[]];
    while (true) {
      let negate = false;
      if (isWord(t[i], "not")) { negate = true; i++; }
      blockStart = i;
      const m = matchAt(t, i, condTable);
      if (!m) return fail("Unknown condition");
      groups[groups.length - 1].push(negate ? { ...m.block, not: true } : m.block);
      i = m.next;
      if (isWord(t[i], "and")) { i++; continue; }
      if (isWord(t[i], "or")) { i++; groups.push([]); continue; }
      break;
    }
    // No "or" used: keep the flat list. Otherwise wrap in one OR block.
    conds = groups.length === 1 ? groups[0] : [{ type: ANY_GROUP, params: { anyOf: groups } }];
  }

  // Actions
  if (!isWord(t[i], "do")) return fail('Expected "do"');
  i++;

  const acts: Block[] = [];
  while (true) {
    blockStart = i;
    const m = matchAt(t, i, actTable);
    if (!m) return fail("Unknown action");
    acts.push(m.block);
    i = m.next;
    if (isWord(t[i], "then")) { i++; continue; }
    break;
  }

  // Optional cooldown, after the last action
  let cooldown: { cooldownMs: number; cooldownPerUser?: true } | undefined;
  if (isWord(t[i], "with") && isWord(t[i + 1], "cooldown")) {
    i += 2;
    const ms = t[i]?.kind === "word" ? parseDuration(t[i].v) : undefined;
    if (ms === undefined) return fail("Cooldown needs a duration like 30s, 5m, 2h or 1d");
    i++;
    cooldown = { cooldownMs: ms };
    if (isWord(t[i], "per") && isWord(t[i + 1], "user")) { cooldown.cooldownPerUser = true; i += 2; }
  }
  if (i < t.length) return fail("Unexpected extra input");

  return {
    ok: true,
    rule: {
      id: meta.id,
      name,
      schemaVersion: 1,
      serverId: meta.serverId,
      enabled: true,
      trigger,
      conditions: conds,
      actions: acts,
      ...cooldown,
      source: withoutName(text),
    },
  };
}

/** The rule text after its optional leading "name" (same string syntax as the tokenizer), whitespace tidied. */
function withoutName(text: string): string {
  return text.trim().replace(/^"(?:[^"\\]|\\.)*"\s*/, "").replace(/\s+/g, " ").trim();
}
