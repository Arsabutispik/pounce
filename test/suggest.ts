import assert from "node:assert/strict";
import "../features/index.js";
import { validateRule } from "../engine/index.js";
import "reflect-metadata";
import { parseRule, suggestFixes } from "../parser/index.js";
import { couldNot } from "../bot/rule/manage.js";

/* "Did you mean" fixes, tested on real mistakes. */

const CH = "01K3RD9EGFJPQW366PXMZ3N6QR";
const C = `<#${CH}>`;
const channels = [{ id: CH, name: "General" }];
const texts = (s: ReturnType<typeof suggestFixes>) => s.map((x) => x.text);

// every suggestion must be a rule the bot accepts
const check = (input: string, opts = {}) => {
  const t0 = performance.now();
  const s = suggestFixes(input, { channels, ...opts });
  assert(performance.now() - t0 < 1500, `too slow: ${input}`);
  for (const x of s) {
    const r = parseRule(x.text, { id: "t", serverId: "s" });
    assert(r.ok && validateRule(r.rule).length === 0, `suggestion doesn't work: ${x.text}`);
    assert(x.changes.length > 0, "says what changed");
  }
  return s;
};

// four mistakes at once: two extra "do"s, a channel by name, "to send"
let s = check(`"SWS submissions" when message contains "SWS" do react ":01KPZPT2D9Q4FG4M2SVZZAMBXA:" do send "{message}" to General with masquerade and files do react ":01KJJV6Z86D3R2ANPMY078V6PK:" to send`);
assert.deepEqual(texts(s), [`"SWS submissions" when message contains "SWS" do react ":01KPZPT2D9Q4FG4M2SVZZAMBXA:" then send "{message}" to ${C} with masquerade and files then react ":01KJJV6Z86D3R2ANPMY078V6PK:" to sent`]);
assert.deepEqual(s[0].changes, [`"do" → "then"`, "General → #General", `"do" → "then"`, `"send" → "sent"`]);
assert.equal(s[0].rule.name, "SWS submissions", "name kept");

// without the channel list, a plain channel name can't be fixed (no guessing ids)
assert.deepEqual(check(`when message contains "a" do send "x" to General`, { channels: [] }), []);

// a channel with no condition word: offers the readings, never deletes the channel
s = check(`"SWS" when message contains "SWS" or ${C} day is monday do react "👀"`);
assert(s.length >= 2, "alternatives offered");
assert(s.every((x) => x.text.includes(C)), "the channel is never dropped");
assert(s.some((x) => x.text.includes(`or message mentions ${C} and day is monday`)));
assert(s.some((x) => x.text.includes(`or message in ${C} and day is monday`)));
const grouped = s.find((x) => x.text.includes("message mentions") && x.text.includes("and day"))!;
assert.equal(grouped.summary.conditions[0], `message contains "SWS" or (message mentions ${C} and the day is Monday (UTC))`, "explanation shows grouping");
assert.deepEqual(grouped.changes, [`added "message mentions"`, `added "and"`], "adjacent additions merged");

// typos and missing pieces
assert.deepEqual(texts(check(`when message contians "hi" do reply "hey"`)), [`when message contains "hi" do reply "hey"`]);
assert.deepEqual(texts(check(`when message contains SWS do react "🎉"`)), [`when message contains "SWS" do react "🎉"`]);
assert.deepEqual(texts(check(`on reaction "⭐" reachs 3 do send "x" to ${C}`)), [`on reaction "⭐" reaches 3 do send "x" to ${C}`]);
assert.deepEqual(texts(check(`when message contains "a" do reply "x" with cooldwn 5m`)), [`when message contains "a" do reply "x" with cooldown 5m`]);
assert.deepEqual(texts(check(`when message contains "a" do reply "x" then`)), [`when message contains "a" do reply "x"`], "stray keyword dropped");
s = check(`when message contains "a" message in ${C} do reply "x"`);
assert.deepEqual(texts(s), [`when message contains "a" and message in ${C} do reply "x"`, `when message contains "a" or message in ${C} do reply "x"`]);

// nothing to suggest: no rule in there, or it already parses (then the error is about values)
assert.deepEqual(check(`forward good posts to the showcase`), []);
assert.deepEqual(check(`when message contains "a" do react "star"`), [], "parses; bad emoji is a value problem");
assert.deepEqual(check(""), []);
// fixes that wouldn't validate aren't offered (message checks on a scheduled rule)
assert(check(`every day at 09:00 when message contians "x" do send "y" to ${C}`).length === 0);

// long garbage stays fast (search budget)
check(Array.from({ length: 80 }, (_, i) => (i % 3 ? "do" : `"x${i}"`)).join(" "));

// a keyword in the wrong place is one swap, not delete + add
s = check(`"SWS" when message contains "SWS" or message contains ${C} and day is monday do react "👀"`);
assert.deepEqual(s.map((x) => x.changes), [[`"contains" → "mentions"`], [`"contains" → "in"`]]);

// the reply: each code block starts on its own line (the Stoat client needs that to render it)
const reply = couldNot("Couldn't add rule", "Unknown condition", s, "!rule add");
assert.match(reply, /\*\*1\.\*\*\n```\n!rule add "SWS" when/);
assert.match(reply, /\n```\n→ If message contains "SWS" or \(message mentions/);
assert.match(reply, /_Changed: "contains" → "mentions"_\n\*\*2\.\*\*\n```\n/);

// two-step fixes: a channel left after a condition needs "and" + a condition word
s = check(`when message contains "SWS" ${C} do react "✅"`);
assert(s.some((x) => x.text === `when message contains "SWS" and message mentions ${C} do react "✅"`));
assert(s.some((x) => x.text === `when message contains "SWS" and message in ${C} do react "✅"`));
// keywords typed as one word
assert.deepEqual(texts(check(`when message startswith "!sub" do react "📥"`)), [`when message starts with "!sub" do react "📥"`]);
// only the simplest fix is shown: "to sent", not also "drop 'to send'" (which changes what gets the reaction)
assert.deepEqual(texts(check(`when message contains "x" do send "y" to ${C} then react "✅" to send`)), [
  `when message contains "x" do send "y" to ${C} then react "✅" to sent`,
]);

console.log("suggest tests passed");
