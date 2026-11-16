import assert from "node:assert/strict";
import "../features/index.js";
import { actions, conditions, RuleEngine, triggers, type Env } from "../engine/index.js";
import { parseRule } from "../parser/index.js";
import { CHANNEL_MAX, MESSAGE_MAX, overview, splitMessage, TOPICS, findTopic } from "../bot/helpText.js";

// every block that can be written in a rule explains itself in !help
for (const [name, reg] of [["trigger", triggers], ["condition", conditions], ["action", actions]] as const) {
  for (const [type, def] of reg.entries()) {
    if (def.syntax?.length) assert(def.help, `${name} "${type}" has syntax but no help`);
  }
}

// every page fits in messages, and the in-channel overview stays short
const P = "!";
assert(overview(P).length <= CHANNEL_MAX + 400, `overview is ${overview(P).length} chars`);
for (const t of TOPICS) {
  const chunks = splitMessage(t.text(P));
  for (const c of chunks) assert(c.length <= MESSAGE_MAX, `${t.key}: chunk of ${c.length} chars`);
  assert.equal(chunks.join("\n").replace(/\n```\n```/g, ""), t.text(P), `${t.key}: splitting loses nothing`);
  assert(overview(P).includes(`\`${t.key}\``), `overview lists ${t.key}`);
}

// every example rule actually works
const env: Env = { send: async (c) => ({ channelId: c, messageId: "x" }), react: async () => {}, channelServerId: async () => "s", log: () => {} };
const examples = [...TOPICS.map((t) => t.text(P)).join("\n").matchAll(/`!rule add ("[^`]+)`/g)].map((m) => m[1]);
assert(examples.length >= 6, "examples found");
examples.forEach((text, n) => {
  const real = text.replace(/#channel/g, "<#C1>");
  const r = parseRule(real, { id: `ex${n}`, serverId: "s" });
  assert(r.ok, `example ${n} doesn't parse: ${r.ok ? "" : r.error}\n${text}`);
  new RuleEngine(env).addRule(r.rule); // throws if invalid
});

// topic lookup is forgiving about plurals and case
assert.equal(findTopic("Condition")?.key, "conditions");
assert.equal(findTopic("example")?.key, "examples");
assert.equal(findTopic("nope"), undefined);

// splitting: short text untouched; code blocks cut in two are closed and reopened
assert.deepEqual(splitMessage("hi"), ["hi"]);
const long = ["```", ...Array.from({ length: 50 }, (_, i) => `line ${i} ${"x".repeat(50)}`), "```", "after"].join("\n");
const parts = splitMessage(long, 1000);
assert(parts.length > 1);
for (const p of parts) {
  assert(p.length <= 1000, "chunk within max");
  assert.equal((p.match(/```/g) ?? []).length % 2, 0, "every chunk has balanced code fences");
}
assert.deepEqual(splitMessage("a".repeat(2500), 1000).map((c) => c.length <= 1000), [true, true, true], "huge line cut");

console.log("help tests passed");
