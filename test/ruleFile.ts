import assert from "node:assert/strict";
import "../features/index.js";
import type { Env, Rule } from "../engine/index.js";
import { parseRule } from "../parser/index.js";
import { RulesService } from "../bot/RulesService.js";
import { FakeStore } from "./fakeStore.js";
import { channelRefs, exportRules, parseImport } from "../bot/ruleFile.js";

/* Export/import, with an in-memory store (no database needed). */

const fake = new FakeStore();
const mem = fake.rules;
const store = fake.asStore;
const owner = new Map<string, string>(); // channel id -> server id, as the platform would say
const env: Env = {
  send: async (c) => ({ channelId: c, messageId: "x" }),
  react: async () => {},
  channelServerId: async (id) => owner.get(id),
  log: () => {},
};
const own = (server: string, ...channels: string[]) => channels.forEach((c) => owner.set(c, server));
const svc = new RulesService(store);
await svc.init(env);

const rule = (text: string, serverId = "A") => {
  const r = parseRule(text, { id: Math.random().toString(36).slice(2, 10), serverId });
  assert(r.ok, r.ok ? "" : r.error);
  return r.rule;
};

// ---- the file
const src = [
  rule(`"SWS" when message contains "SWS" or message in <#CH1> do send "{message} from <#CH2>" to <#CH3> with masquerade and files then react "✅" to sent with cooldown 10m per user`),
  { ...rule(`"Stars" on reaction "⭐" reaches 3 do send "{message}" to <#CH3>`), enabled: false },
];
const file = exportRules(src, new Date("2026-11-16T00:00:00Z"));
const json = JSON.parse(file);
assert.equal(json.format, "pounce-rules");
assert.equal(json.version, 1);
assert.equal(json.exportedAt, "2026-11-16T00:00:00.000Z");
assert(!file.includes(src[0].id) && !file.includes('"serverId"'), "no ids or server in the file");

const back = parseImport(file);
assert(back.ok);
assert.deepEqual(back.rules[0].actions, src[0].actions, "actions round-trip");
assert.deepEqual(back.rules[0].conditions, src[0].conditions, "conditions (with or-groups) round-trip");
assert.equal(back.rules[0].cooldownMs, 600_000);
assert.equal(back.rules[0].cooldownPerUser, true);
assert.equal(back.rules[1].enabled, false, "off stays off");

assert.deepEqual(channelRefs(src[0]).sort(), ["CH1", "CH2", "CH3"], "channels in params, or-groups and text");

// pasted forms: a bare rule, an array, in a code block
const bare = JSON.stringify(back.rules[1]);
assert(parseImport(bare).ok, "bare rule");
assert(parseImport(`[${bare}]`).ok, "array of rules");
assert(parseImport("```json\n" + bare + "\n```").ok, "code block");

// bad input fails with a readable reason, never throws
const bad = (text: string, re: RegExp) => {
  const r = parseImport(text);
  assert(!r.ok && re.test(r.error), `${text.slice(0, 40)} -> ${r.ok ? "ok" : r.error}`);
};
bad("not json", /valid JSON/);
bad(`{"format":"other","rules":[]}`, /isn't a rules export/);
bad(`{"format":"pounce-rules","version":2,"rules":[]}`, /version 2/);
bad(`{"format":"pounce-rules","version":1,"rules":[]}`, /no rules/);
bad(`[{"name":"x"}]`, /no valid trigger/);
bad(`[{"name":"x","trigger":{"type":"schedule","params":{}},"conditions":"nope","actions":[]}]`, /malformed/);
bad(`[{"name":"x","trigger":{"type":"schedule","params":{}},"conditions":[],"actions":[null]}]`, /malformed/);
bad(`[{"trigger":{"type":"schedule","params":{}},"conditions":[],"actions":[]}]`, /no name/);
bad(`[1]`, /isn't a rule/);
bad(JSON.stringify(Array(101).fill(JSON.parse(bare))), /Too many/);

// ---- importing into another server
const parsed = parseImport(file);
assert(parsed.ok);
own("B", "CH1", "CH2", "CH3");
let r = await svc.importRules("B", parsed.rules);
assert.deepEqual([r.added, r.replaced, r.skipped, r.disabled], [["SWS", "Stars"], [], [], []], "clean import");
const inB = await svc.list("B");
assert.equal(inB.length, 2);
assert(inB.every((x) => x.serverId === "B" && !src.some((s) => s.id === x.id)), "new ids, in the importing server");
assert.equal((await svc.find("B", "Stars"))?.enabled, false, "disabled rule stays disabled");
assert.equal(mem.size, 2, "saved to the store");

// importing again: same names are skipped...
r = await svc.importRules("B", parsed.rules);
assert.deepEqual([r.added, r.skipped.map((s) => s.name)], [[], ["SWS", "Stars"]], "name clash skipped");
assert.match(r.skipped[0].reason, /already exists/);

// ...or replaced in place with `replace`
const oldId = (await svc.find("B", "SWS"))!.id;
const changed = parsed.rules.map((x) => (x.name === "SWS" ? { ...x, cooldownMs: 60_000 } : x));
r = await svc.importRules("B", changed, { replace: true });
assert.deepEqual(r.replaced, ["SWS", "Stars"], "replaced");
assert.equal((await svc.find("B", "SWS"))!.id, oldId, "replace keeps the rule's id");
assert.equal((await svc.find("B", "SWS"))!.cooldownMs, 60_000, "replace updates the rule");
assert.equal((await svc.list("B")).length, 2, "no duplicates");

// unknown channels: imported but turned off
own("C", "CH1"); // CH2 and CH3 belong to server B
r = await svc.importRules("C", parsed.rules);
assert.deepEqual(r.added, ["SWS", "Stars"]);
assert.deepEqual(r.disabled, [{ name: "SWS", channels: ["CH2", "CH3"] }], "only rules that were on are reported");
assert.equal((await svc.find("C", "SWS"))?.enabled, false, "turned off");

// one bad rule doesn't stop the rest; duplicate names inside one file
const mixed = parseImport(JSON.stringify([
  { name: "Good", trigger: { type: "message.created", params: {} }, conditions: [], actions: [{ type: "message.reply", params: { text: "hi" } }] },
  { name: "Bad", trigger: { type: "message.created", params: {} }, conditions: [], actions: [{ type: "nope.nope", params: {} }] },
  { name: "good", trigger: { type: "message.created", params: {} }, conditions: [], actions: [{ type: "message.reply", params: { text: "x" } }] },
]));
assert(mixed.ok);
r = await svc.importRules("D", mixed.rules);
assert.deepEqual(r.added, ["Good"]);
assert.deepEqual(r.skipped.map((s) => [s.name, /Unknown action|another rule/.test(s.reason)]), [["Bad", true], ["good", true]]);

// ---- saved rule text
const named = rule(`"Hi"   when message contains "hi"\n do react "👋"`);
assert.equal(named.source, `when message contains "hi" do react "👋"`, "source: name dropped, whitespace tidied");
assert.equal(rule(`when message contains "a" do reply "x  y"`).source, `when message contains "a" do reply "x y"`);

// export keeps the text when it matches, drops it when the file was hand-edited
const withText = parseImport(exportRules([named]));
assert(withText.ok && withText.rules[0].source === named.source, "text survives export/import");
const handEdited = JSON.parse(exportRules([named]));
handEdited.rules[0].actions[0].params.emoji = "🎉";
const edited = parseImport(JSON.stringify(handEdited));
assert(edited.ok && edited.rules[0].source === undefined, "stale text dropped");
// Postgres jsonb reorders keys; that alone mustn't drop the text
const reordered = JSON.parse(exportRules([rule(`"Fwd" when message contains "a" do send "x" to <#C1> with masquerade and files`)]));
reordered.rules[0].actions[0].params = { files: true, text: "x", channel: "C1", masquerade: true };
const ro = parseImport(JSON.stringify(reordered));
assert(ro.ok && ro.rules[0].source !== undefined, "key order doesn't matter");

// ---- rule edit
const cleared = fake.clearedFires;
own("E", "S1");
const base = await svc.addFromText("E", `"Fwd" on reaction "⭐" reaches 3 do send "{message}" to <#S1>`);
assert(base.ok);
await svc.setEnabled("E", "Fwd", false);

let ed = await svc.editFromText("E", "fwd", `on reaction "⭐" reaches 5 do send "{message}!" to <#S1> with cooldown 1m`);
assert(ed.ok, ed.ok ? "" : ed.error);
assert.equal(ed.rule.id, base.rule.id, "edit keeps the id");
assert.equal(ed.rule.name, "Fwd", "edit keeps the name");
assert.equal(ed.rule.enabled, false, "edit keeps on/off");
assert.equal(ed.rule.trigger.params.count, 5);
assert.equal(ed.rule.cooldownMs, 60_000);
assert.equal(ed.rule.source, `on reaction "⭐" reaches 5 do send "{message}!" to <#S1> with cooldown 1m`, "edit saves the new text");
assert.deepEqual(cleared, [base.rule.id], "trigger changed: fired messages forgotten");
assert.equal(mem.get(base.rule.id)?.trigger.params.count, 5, "edit saved to the store");
assert.equal((await svc.list("E")).length, 1, "no duplicate");

ed = await svc.editFromText("E", base.rule.id, `"Forward" on reaction "⭐" reaches 5 do reply "x"`);
assert(ed.ok && ed.rule.name === "Forward", "edit can rename with a leading name");
assert.equal(cleared.length, 1, "same trigger: fired messages kept");

ed = await svc.editFromText("E", "Forward", `when foo do bar`);
assert(!ed.ok && /Unknown condition/.test(ed.error), "bad text rejected");
assert.equal((await svc.find("E", "Forward"))?.actions[0].type, "message.reply", "failed edit leaves the rule alone");
await svc.addFromText("E", `"Other" when message contains "o" do reply "o"`);
ed = await svc.editFromText("E", "Forward", `"other" when message contains "o" do reply "o"`);
assert(!ed.ok && /already exists/.test(ed.error), "can't edit into a taken name");
assert(!(await svc.editFromText("E", "missing", `when message contains "o" do reply "o"`)).ok, "unknown rule");

// ---- adding a rule that targets another server's channel is refused up front
own("victim", "THEIRS");
own("F", "MINE");
const steal = await svc.addFromText("F", `"Steal" when message contains "x" do send "x" to <#THEIRS> with masquerade`);
assert(!steal.ok && /aren't in this server: `THEIRS`/.test(steal.error), "foreign channel rejected on add");
const fine = await svc.addFromText("F", `"Fine" when message contains "x" do send "x" to <#MINE>`);
assert(fine.ok, "own channel accepted");
const sneaky = await svc.editFromText("F", "Fine", `when message contains "x" do send "x" to <#THEIRS>`);
assert(!sneaky.ok, "can't edit a rule into another server's channel");
// imported off, then can't be turned on until fixed
const off = parseImport(JSON.stringify([{ name: "Imp", trigger: { type: "message.created", params: {} }, conditions: [], actions: [{ type: "message.send", params: { text: "x", channel: "THEIRS" } }] }]));
assert(off.ok);
r = await svc.importRules("F", off.rules);
assert.deepEqual(r.disabled, [{ name: "Imp", channels: ["THEIRS"] }]);
const on = await svc.setEnabled("F", "Imp", true);
assert(!on.ok && /aren't in this server/.test(on.error), "can't enable it while it points elsewhere");

console.log("rule file tests passed");
