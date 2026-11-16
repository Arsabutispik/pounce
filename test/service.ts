import assert from "node:assert/strict";
import "../features/index.js";
import type { Env, RuleEvent } from "../engine/index.js";
import { RulesService } from "../bot/RulesService.js";
import { FakeStore } from "./fakeStore.js";

/* Persistent cooldowns, the failure log / log channel, and rule history (in-memory store). */

const S = "srv";
const posts: string[] = [];
let failSend = false;
const owner = new Map<string, string>([["c1", S], ["LOG", S], ["OUT", S], ["THEIRS", "other"]]);
const env: Env = {
  send: async (c, t) => {
    if (failSend && c !== "LOG") throw new Error("Missing permission: SendMessage");
    posts.push(`${c}|${t}`);
    return { channelId: c, messageId: `p${posts.length}` };
  },
  react: async () => {},
  channelServerId: async (id) => owner.get(id),
  log: () => {},
};
const ev = (o: Partial<RuleEvent> = {}): RuleEvent => ({
  type: "message.created", serverId: S, channelId: "c1", messageId: "m1", authorId: "u1",
  authorIsBot: false, content: "", mentionedChannelIds: [], authorName: "A", attachments: [], authorRoles: [],
  timestamp: Date.now(), ...o,
});
const tick = () => new Promise((r) => setTimeout(r, 0)); // let background writes/posts finish

// ---------- cooldowns survive a restart
{
  const store = new FakeStore();
  const a = new RulesService(store.asStore);
  await a.init(env);
  assert((await a.addFromText(S, `"SWS" when message contains "SWS" do reply "got it" with cooldown 24h per user`, "admin")).ok);
  posts.length = 0;
  await a.handleEvent(ev({ content: "SWS", authorId: "u1" }));
  await tick();
  assert.equal(posts.length, 1);
  assert.equal(store.cooldowns.size, 1, "cooldown saved");

  const b = new RulesService(store.asStore); // "restart"
  await b.init(env);
  await b.handleEvent(ev({ content: "SWS", authorId: "u1" }));
  assert.equal(posts.length, 1, "after a restart, the same user is still on cooldown");
  await b.handleEvent(ev({ content: "SWS", authorId: "u2" }));
  assert.equal(posts.length, 2, "other users aren't");

  // expired cooldowns aren't restored, and get pruned
  store.now = () => Date.now() + 25 * 3600_000;
  const c = new RulesService(store.asStore);
  await c.init(env);
  await c.handleEvent(ev({ content: "SWS", authorId: "u1", timestamp: Date.now() + 25 * 3600_000 }));
  assert.equal(posts.length, 3, "expired cooldown not restored");
  assert((await store.pruneCooldowns()) >= 1);

  // the store being down never blocks a rule
  const flaky = new FakeStore();
  flaky.saveCooldown = async () => { throw new Error("db down"); };
  const d = new RulesService(flaky.asStore);
  await d.init(env);
  await d.addFromText(S, `"Hi" when message contains "hi" do reply "hey" with cooldown 1m`);
  posts.length = 0;
  await d.handleEvent(ev({ content: "hi" }));
  await d.handleEvent(ev({ content: "hi" }));
  await tick();
  assert.equal(posts.length, 1, "runs once, cooldown kept in memory");
}

// ---------- failures: rule logs + log channel
{
  const store = new FakeStore();
  const svc = new RulesService(store.asStore);
  await svc.init(env);
  assert((await svc.addFromText(S, `"Fwd" when message contains "x" do send "{message}" to <#OUT>`)).ok);
  assert.deepEqual(svc.recentFailures(S), [], "nothing yet");

  failSend = true;
  posts.length = 0;
  await svc.handleEvent(ev({ content: "x" }));
  let f = svc.recentFailures(S);
  assert.equal(f.length, 1);
  assert.equal(f[0].ruleName, "Fwd");
  assert.match(f[0].error, /Missing permission/);
  assert.equal(posts.length, 0, "no log channel: nothing posted");

  // repeats are counted, not listed again
  await svc.handleEvent(ev({ content: "x" }));
  await svc.handleEvent(ev({ content: "x" }));
  f = svc.recentFailures(S);
  assert.deepEqual([f.length, f[0].count], [1, 3], "same failure counted");

  // log channel: must be in this server; posts new failures once
  assert.deepEqual(await svc.setLogChannel(S, "THEIRS"), { ok: false, error: "That channel isn't in this server." });
  assert((await svc.setLogChannel(S, "LOG")).ok);
  assert.equal(store.settings.get(S), "LOG", "saved");
  assert((await svc.addFromText(S, `"Other" when message contains "y" do send "{message}" to <#OUT>`)).ok);
  await svc.handleEvent(ev({ content: "y" }));
  await svc.handleEvent(ev({ content: "y" }));
  await tick();
  assert.equal(posts.filter((p) => p.startsWith("LOG|")).length, 1, "posted once for a repeating failure");
  assert.match(posts.find((p) => p.startsWith("LOG|"))!, /Rule \*\*Other\*\* .* failed: .*Missing permission/);

  // hourly cap per server
  for (let i = 0; i < 30; i++) assert((await svc.addFromText(S, `"R${i}" when message contains "z${i}" do send "a" to <#OUT>`)).ok);
  for (let i = 0; i < 30; i++) await svc.handleEvent(ev({ content: `z${i}` }));
  await tick();
  assert.equal(posts.filter((p) => p.startsWith("LOG|")).length, 20, "at most 20 log posts an hour");
  assert(svc.recentFailures(S).length <= 50, "list is bounded");
  failSend = false;

  // setting survives a restart; "off" stops it
  const again = new RulesService(store.asStore);
  await again.init(env);
  assert.equal(again.logChannel(S), "LOG", "log channel loaded at startup");
  assert((await again.setLogChannel(S, null)).ok);
  assert.equal(again.logChannel(S), undefined);

  // failures survive a restart, with their counts; repeats are written at most once a minute
  const fwd = again.recentFailures(S).find((x) => x.ruleName === "Fwd")!;
  assert.equal(fwd.count, 1, "saved count (repeats within a minute aren't written yet)");
  assert.equal(store.failureRows.size, 32, "one row per rule + error");
  assert.equal(again.recentFailures(S).length, 32);
  assert(again.recentFailures(S).every((x, i, all) => i === 0 || all[i - 1].last >= x.last), "most recent first");

  // repeats after a restart keep counting on the saved row, and aren't re-posted to a log channel right away
  assert((await again.setLogChannel(S, "LOG")).ok);
  failSend = true;
  posts.length = 0;
  await again.handleEvent(ev({ content: "y" }));
  await tick();
  failSend = false;
  // before the restart it failed twice, but only the first was written (repeats: at most once a minute)
  assert.equal(again.recentFailures(S).find((x) => x.ruleName === "Other")!.count, 2, "count continues from the saved row");
  assert.equal(posts.filter((p) => p.startsWith("LOG|")).length, 0, "not re-posted: it was reported moments ago");

  // removing a rule removes its failures
  await again.removeRule((await again.find(S, "Other"))!.id);
  assert.equal(again.recentFailures(S).some((x) => x.ruleName === "Other"), false);
  assert.equal([...store.failureRows.values()].some((x) => x.ruleName === "Other"), false);

  // pruning: old failures go, and only the newest 50 per server are kept
  store.now = () => Date.now() + 31 * 86_400_000;
  assert.equal(await store.pruneFailures(30, 50), 31, "a month without repeats: forgotten");
  store.now = () => Date.now();
}

// ---------- history
{
  const store = new FakeStore();
  const svc = new RulesService(store.asStore);
  await svc.init(env);
  const added = await svc.addFromText(S, `"Wins" when message contains "SWS" do react "🎉"`, "alice");
  assert(added.ok);
  const id = added.rule.id;
  await svc.editFromText(S, "Wins", `when message contains "SWS" do react "👀"`, "bob");
  await svc.rename(S, "Wins", "Small Wins", "alice");
  await svc.rename(S, "Small Wins", "small wins", "alice"); // case-only rename still counts
  await svc.setEnabled(S, id, false, "bob");
  await svc.setEnabled(S, id, false, "bob"); // no change: not recorded
  await svc.setEnabled(S, id, true, "bob");
  await svc.editFromText(S, id, `"SWS" when message contains "SWS" do react "👀"`, "carol");

  let h = (await svc.history(S, id))!;
  assert.deepEqual(
    h.map((e) => [e.action, e.userId]),
    [["edited", "carol"], ["enabled", "bob"], ["disabled", "bob"], ["renamed", "alice"], ["renamed", "alice"], ["edited", "bob"], ["added", "alice"]],
    "every change, newest first, with who",
  );
  assert.equal(h[0].ruleName, "SWS");
  assert.match(h[0].detail!, /renamed from "small wins"/, "edit that renames says so");
  assert.equal(h[3].detail, "Small Wins → small wins");
  assert.equal(h.at(-1)!.detail, `when message contains "SWS" do react "🎉"`, "added: the rule's text");

  // look up by an old name, and after removal
  assert.equal((await svc.history(S, "Wins"))?.[0].ruleId, id, "old name finds the rule");
  await svc.removeRule(id, "dave");
  h = (await svc.history(S, "SWS"))!;
  assert.deepEqual([h[0].action, h[0].userId, h[0].detail], ["removed", "dave", `when message contains "SWS" do react "👀"`], "removed rule still has history, with its text");
  assert.equal(await svc.history(S, "never existed"), undefined);

  // server-wide list, limit
  assert.equal((await svc.history(S))!.length, 8); // added, edited, 2 renames, off, on, edited, removed
  assert.equal((await svc.history(S, undefined, 3))!.length, 3);
  assert.deepEqual(await svc.history("elsewhere"), [], "per server");

  // import records too
  const imp = await svc.importRules(S, [{ name: "Imp", enabled: true, schemaVersion: 1, trigger: { type: "message.created", params: {} }, conditions: [], actions: [{ type: "message.reply", params: { text: "x" } }] }], { by: "erin" });
  assert.deepEqual(imp.added, ["Imp"]);
  assert.deepEqual((await svc.history(S, "Imp"))!.map((e) => [e.action, e.userId]), [["imported", "erin"]]);

  // a failed change records nothing
  const before = store.historyRows.length;
  await svc.addFromText(S, `"Bad" when foo do bar`, "x");
  await svc.rename(S, "Imp", "", "x");
  assert.equal(store.historyRows.length, before, "failures aren't history");

  // pruning: entries older than a year go, but each rule's newest entry stays (even for removed rules)
  const rows = store.historyRows.length;
  store.now = () => Date.now() + 400 * 86_400_000;
  const pruned = await store.pruneHistory(365);
  store.now = () => Date.now();
  const left = new Set(store.historyRows.map((h) => h.ruleId));
  assert.equal(store.historyRows.length, left.size, "one entry left per rule");
  assert.equal(pruned, rows - left.size);
  assert.equal((await svc.history(S, "SWS"))?.[0].action, "removed", "a long-removed rule can still be found and added back");

  // history store down: the change still goes through
  store.addHistory = async () => { throw new Error("db down"); };
  assert((await svc.addFromText(S, `"Still" when message contains "s" do react "✅"`, "x")).ok, "history failure doesn't block");
}

console.log("service tests passed");
