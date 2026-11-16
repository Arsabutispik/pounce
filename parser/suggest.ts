import { actions, conditions, summarizeRule, triggers, validateRule, type Rule, type RuleSummary } from "../engine/index.js";
import { parseRule, parseTokens, type ParseResult } from "./grammar.js";
import { buildTable } from "./match.js";
import { renderTokens, tokenize, type Token } from "./tokenizer.js";

/*
  "Did you mean …?" for rule text that doesn't parse.

  A small search over edits to the tokens, starting where the parser gave up:
    - add a missing keyword, or a whole block's missing keywords ("<#c>" -> "message in <#c>")
    - fix a misspelled keyword ("contians", "to send" -> "to sent")
    - add or swap a connector (a second "do" -> "then", a missing "and")
    - split two keywords typed as one ("startswith" -> "starts with")
    - drop a stray keyword (never a value: text, channels and users are what the user meant)
    - quote a bare word where text is expected (contains SWS -> contains "SWS")
    - turn a channel's name into a link ("General" -> <#id>), when the server's channels are given

  Each edit costs 1. A candidate is kept only if it parses AND passes the engine's validation, so every
  suggestion is a rule that would really be accepted. The vocabulary comes from the blocks' own syntax,
  so new blocks are covered without changes here.
*/

export type Suggestion = {
  text: string; // the fixed rule text
  rule: Rule;
  summary: RuleSummary; // what it does, in plain words
  changes: string[]; // what was changed, e.g. `"do" → "then"`
};

export type SuggestOptions = {
  channels?: { id: string; name: string }[]; // the server's channels, to turn names into links
  defaultName?: string;
  max?: number; // suggestions to return (default 3)
};

const MAX_COST = 4; // edits per suggestion
const MAX_PARSES = 6000; // search budget, so a long or hopeless rule can't stall the bot
const GRAMMAR_WORDS = ["when", "do", "then", "and", "or", "not", "with", "cooldown", "per", "user"];
const CONNECTORS = ["and", "or", "then", "do", "when"];
const SLOT_KIND: Record<string, Token["kind"]> = { $str: "str", $chan: "chan", $user: "user", $word: "word" };

type Edit = { tokens: Token[]; cost: number; changes: string[] };
type State = Edit & { res: Extract<ParseResult, { ok: false }> };

const word = (v: string): Token => ({ kind: "word", v });

/** Close enough to be a typo: 1 edit for short words, 2 for longer ones. Never for 1-2 letter words. */
function isTypo(a: string, b: string): boolean {
  a = a.toLowerCase();
  if (a === b || a.length < 3 || b.length < 3) return false;
  const limit = b.length <= 4 ? 1 : 2;
  if (Math.abs(a.length - b.length) > limit) return false;
  // Levenshtein distance, early exit once past the limit
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    if (Math.min(...cur) > limit) return false;
    prev = cur;
  }
  return prev[b.length] <= limit;
}

export function suggestFixes(text: string, opts: SuggestOptions = {}): Suggestion[] {
  const patterns = [
    ...buildTable(triggers).map((e) => ({ pattern: e.pattern, action: false })),
    ...buildTable(conditions).map((e) => ({ pattern: e.pattern, action: false })),
    ...buildTable(actions).map((e) => ({ pattern: e.pattern, action: true })),
  ];
  const vocab = [...new Set([...GRAMMAR_WORDS, ...patterns.flatMap((p) => p.pattern).filter((p) => !p.startsWith("$"))])];
  const meta = { id: "suggest", serverId: "suggest", defaultName: opts.defaultName };
  const channelByName = (name: string) => {
    const n = name.replace(/^#/, "").toLowerCase();
    return opts.channels?.find((c) => c.name.toLowerCase() === n);
  };

  let parses = 0;
  const parse = (t: Token[]) => (parses++, parseTokens(t, meta));

  const start = tokenize(text);
  const first = parse(start);
  if (first.ok) return []; // it parses; any remaining error is about values, not wording

  /**
   * Ways to read tokens from `s` as `pattern`, inserting or fixing its keywords. Two limits keep guesses
   * honest: an action's verb is never invented (adding "reply" would change what the rule does), and a bare
   * word is only quoted right after a keyword the user wrote themselves ("contains SWS").
   */
  const align = ({ pattern, action }: { pattern: string[]; action: boolean }, t: Token[], s: number): Edit[] => {
    const out: Edit[] = [];
    const walk = (pi: number, ti: number, toks: Token[], cost: number, changes: string[], anchored: boolean, prevTyped = false) => {
      if (cost > MAX_COST) return;
      if (pi === pattern.length) {
        // must use at least one of the user's tokens (no inventing whole blocks), and change something
        if (anchored && cost > 0) out.push({ tokens: [...t.slice(0, s), ...toks, ...t.slice(ti)], cost, changes: mergeAdds(changes) });
        return;
      }
      const p = pattern[pi];
      const tok = t[ti];
      const slot = SLOT_KIND[p];
      if (slot) {
        if (tok?.kind === slot) return walk(pi + 1, ti + 1, [...toks, tok], cost, changes, true);
        if (tok?.kind !== "word") return; // values can't be invented
        if (slot === "str" && prevTyped && !GRAMMAR_WORDS.includes(tok.v.toLowerCase())) {
          walk(pi + 1, ti + 1, [...toks, { kind: "str", v: tok.v }], cost + 1, [...changes, `put ${tok.v} in "quotes"`], true);
        }
        const ch = slot === "chan" ? channelByName(tok.v) : undefined;
        if (ch) walk(pi + 1, ti + 1, [...toks, { kind: "chan", v: ch.id }], cost + 1, [...changes, `${tok.v} → #${ch.name}`], true);
        return;
      }
      if (tok?.kind === "word" && tok.v.toLowerCase() === p) return walk(pi + 1, ti + 1, [...toks, word(p)], cost, changes, true, true);
      // a typo of this keyword (cost 1), or another keyword in its place (cost 2: the user did write that
      // word, so prefer fixes that keep it; "message contains <#c>" -> "message mentions <#c>")
      // An action's verb is never swapped in either ("to" -> "send" would invent an action).
      const swap =
        tok?.kind !== "word" ? 0 : isTypo(tok.v, p) ? 1 : !(action && pi === 0) && vocab.includes(tok.v.toLowerCase()) ? 2 : 0;
      if (swap) walk(pi + 1, ti + 1, [...toks, word(p)], cost + swap, [...changes, `"${tok!.v}" → "${p}"`], true, true);
      if (action && pi === 0) return; // never invent an action (only a typo of its verb is fixed)
      walk(pi + 1, ti, [...toks, word(p)], cost + 1, [...changes, `added "${p}"`], anchored);
    };
    walk(0, s, [], 0, [], false);
    return out;
  };

  /** Candidate edits around where parsing stopped. */
  const edits = (cur: State): Edit[] => {
    const t = cur.tokens;
    const at = cur.res.at ?? 0;
    const bs = Math.min(cur.res.blockStart ?? at, at);
    const out: Edit[] = [];
    const put = (from: number, del: number, ins: Token[], change: string) =>
      out.push({ tokens: [...t.slice(0, from), ...ins, ...t.slice(from + del)], cost: 1, changes: [change] });

    for (const c of CONNECTORS) {
      put(at, 0, [word(c)], `added "${c}"`);
      // swap only a misplaced keyword ("do" -> "then"); a word the user chose is never turned into one
      const w = t[at]?.kind === "word" ? t[at].v.toLowerCase() : "";
      if (vocab.includes(w) && w !== c) put(at, 1, [word(c)], `"${t[at].v}" → "${c}"`);
    }
    // Only stray keywords are dropped (an extra "to" or "do"); never values or other words the user chose.
    // (also just before where it stopped: a dangling "then" at the end fails one token later)
    for (const k of [at, at - 1]) {
      if (t[k]?.kind === "word" && vocab.includes(t[k].v.toLowerCase())) put(k, 1, [], `removed "${t[k].v}"`);
    }
    for (let k = bs; k <= Math.min(at + 1, t.length - 1); k++) {
      const tok = t[k];
      if (tok.kind !== "word") continue;
      for (const v of vocab) if (isTypo(tok.v, v)) put(k, 1, [word(v)], `"${tok.v}" → "${v}"`);
      const ch = channelByName(tok.v);
      if (ch) put(k, 1, [{ kind: "chan", v: ch.id }], `${tok.v} → #${ch.name}`);
      // two keywords run together: "startswith" -> "starts with"
      const lower = tok.v.toLowerCase();
      for (const a of vocab) {
        const b = lower.startsWith(a) ? lower.slice(a.length) : "";
        if (b && vocab.includes(b)) put(k, 1, [word(a), word(b)], `"${tok.v}" → "${a} ${b}"`);
      }
    }
    for (const s of new Set([bs, at])) for (const p of patterns) out.push(...align(p, t, s));
    return out.map((e) => ({ ...e, cost: cur.cost + e.cost, changes: [...cur.changes, ...e.changes] }));
  };

  const found = new Map<string, Edit & { rule: Rule }>();
  const seen = new Set<string>([renderTokens(start)]);
  const frontier: State[] = [{ tokens: start, cost: 0, changes: [], res: first }];
  while (frontier.length && parses < MAX_PARSES) {
    frontier.sort((a, b) => a.cost - b.cost);
    const cur = frontier.shift()!;
    const left = cur.tokens.length - (cur.res.at ?? 0); // tokens not yet understood
    for (const next of edits(cur)) {
      if (next.cost > MAX_COST || parses >= MAX_PARSES) continue;
      const key = renderTokens(next.tokens);
      if (seen.has(key)) continue;
      seen.add(key);
      const res = parse(next.tokens);
      if (res.ok) {
        if (validateRule(res.rule).length === 0) found.set(key, { ...next, rule: res.rule });
        continue;
      }
      // Keep edits that don't leave more for the parser to understand. "Equal" matters: adding "and" before
      // "<#c>" doesn't get further on its own, but the next step ("message in <#c>") then completes it.
      // The cost cap and the seen-set keep this from looping.
      if (next.tokens.length - (res.at ?? 0) <= left) frontier.push({ ...next, res });
    }
  }

  const best = [...found.entries()].sort((a, b) => a[1].cost - b[1].cost || a[1].changes.length - b[1].changes.length);
  const cheapest = best[0]?.[1].cost ?? 0;
  return best
    .filter(([, f]) => f.cost === cheapest) // only the simplest fixes: a bigger change next to a small one is noise
    .slice(0, opts.max ?? 3)
    .map(([text]) => {
      const reparsed = parseRule(text, meta); // through the normal path, so `source` is set like any rule
      const rule = reparsed.ok ? reparsed.rule : found.get(text)!.rule;
      return { text, rule, summary: summarizeRule(rule), changes: found.get(text)!.changes };
    });
}

/** Within one block's fix: `added "message"`, `added "in"` -> `added "message in"`. */
function mergeAdds(changes: string[]): string[] {
  const out: string[] = [];
  for (const c of changes) {
    const prev = out.at(-1);
    const add = c.match(/^added "(.*)"$/);
    const prevAdd = prev?.match(/^added "(.*)"$/);
    if (add && prevAdd) out[out.length - 1] = `added "${prevAdd[1]} ${add[1]}"`;
    else out.push(c);
  }
  return out;
}
