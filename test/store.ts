import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import "../features/index.js";
import { PostgresRuleStore, RuleIdTakenError } from "../db/PostgresRuleStore.js";
import { Database } from "../db/Database.js";
import { runMigrations } from "../db/migrate.js";
import { RulesService } from "../bot/RulesService.js";
import type { Env, RuleEvent } from "../engine/index.js";

/*
  Integration test against a real Postgres. Skipped when DATABASE_URL is not set,
  so `mise run test` still works without Docker running.
  Uses throwaway server ids and cleans up after itself.
*/

if (!process.env.DATABASE_URL) {
  console.log("store tests skipped (DATABASE_URL not set)");
  process.exit(0);
}

const sent: string[] = [];
const env: Env = {
  send: async (c, t) => {
    sent.push(`${c}|${t}`);
    return { channelId: c, messageId: `sent${sent.length}` };
  },
  react: async () => {},
  channelServerId: async () => SERVER,
  log: () => {},
};
const run = randomUUID().slice(0, 6);
const SERVER = `test-${run}-a`;
const OTHER = `test-${run}-b`;
const ev = (o: Partial<RuleEvent>): RuleEvent => ({
  type: "message.created", serverId: SERVER, channelId: "c1", messageId: "m1", authorId: "u1",
  authorIsBot: false, content: "", mentionedChannelIds: [], authorName: "Alice", attachments: [], authorRoles: [], timestamp: Date.now(), ...o,
});

const db = new Database();
const store = new PostgresRuleStore(db);

try {
  // migrations are idempotent
  await runMigrations();
  assert.deepEqual(await runMigrations(), [], "second run applies nothing");

  // round trip through jsonb
  const svc1 = new RulesService(store);
  await svc1.init(env);
  const added = await svc1.addFromText(SERVER, `"Small Wins" when message contains "SWS" do send "Thanks {author}"`);
  assert(added.ok, added.ok ? "" : added.error);

  // "restart": a brand new service loads the rule from the database and it fires
  const svc2 = new RulesService(store);
  await svc2.init(env);
  assert.equal((await svc2.list(SERVER)).length, 1, "rule survived restart");
  sent.length = 0;
  await svc2.handleEvent(ev({ content: "SWS my win" }));
  assert.deepEqual(sent, ["c1|Thanks <@u1>"], "loaded rule runs");

  // rename persists
  const renamed = await svc2.rename(SERVER, "Small Wins", "Wins");
  assert(renamed.ok);
  const svc3 = new RulesService(store);
  await svc3.init(env);
  assert.equal((await svc3.list(SERVER))[0].name, "Wins", "rename persisted");

  // duplicate name rejected (engine check), case-insensitive
  const dup = await svc3.addFromText(SERVER, `"wins" when message contains "x" do send "y"`);
  assert(!dup.ok && /already exists/.test(dup.error), "duplicate name rejected");

  // same name in another server is fine
  const otherServer = await svc3.addFromText(OTHER, `"Wins" when message contains "x" do send "y"`);
  assert(otherServer.ok, "same name allowed in a different server");

  // database unique index is a backstop even if the engine check is bypassed
  const raw = await store.load();
  const base = raw.find((r) => r.serverId === SERVER)!;
  await assert.rejects(
    store.save({ ...base, id: `x-${run}`, name: "  WINS " }),
    (e: any) => e.code === "23505",
    "db unique index rejects a duplicate name",
  );

  // a rule id owned by another server cannot be taken over
  await assert.rejects(
    store.save({ ...base, serverId: OTHER, name: "Hijack" }),
    RuleIdTakenError,
    "cannot overwrite another server's rule id",
  );
  assert.equal((await store.load()).find((r) => r.id === base.id)!.serverId, SERVER, "original untouched");

  // save failure rolls the in-memory engine back
  const flaky = new RulesService(Object.assign(Object.create(store), { save: async () => { throw new Error("db down"); } }));
  await flaky.init(env);
  const failed = await flaky.addFromText(SERVER, `"Temp" when message contains "t" do send "t"`);
  assert(!failed.ok && /try again/.test(failed.error), "save failure reported");
  assert.equal((await flaky.list(SERVER)).some((r) => r.name === "Temp"), false, "memory rolled back");

  // scheduled rules round-trip through the database too
  const sched = await svc3.addFromText(SERVER, `"Weekly" every sunday at 09:00 in "Europe/Istanbul" do send "Wins!" to <#c9>`);
  assert(sched.ok, sched.ok ? "" : sched.error);
  const svc4 = new RulesService(store);
  await svc4.init(env);
  const loaded = (await svc4.list(SERVER)).find((r) => r.name === "Weekly");
  assert.deepEqual(loaded?.trigger, { type: "schedule", params: { days: ["sun"], at: "09:00", tz: "Europe/Istanbul" } }, "schedule trigger persisted");

  // enable/disable persists
  const off = await svc4.setEnabled(SERVER, "Weekly", false);
  assert(off.ok);
  const svc5 = new RulesService(store);
  await svc5.init(env);
  assert.equal((await svc5.find(SERVER, "weekly"))?.enabled, false, "disabled state persisted");

  // remove deletes from the database
  await svc3.removeRule(base.id);
  assert.equal((await store.load()).some((r) => r.id === base.id), false, "removed from db");

  // reaction rules remember what they fired on across a restart
  const star = await svc5.addFromText(SERVER, `"Stars" on reaction "⭐" reaches 2 do send "{message}" to <#star>`);
  assert(star.ok, star.ok ? "" : star.error);
  const starEv = (messageId: string) =>
    ev({ type: "reaction.added", messageId, content: "nice", reaction: { emoji: "⭐", count: 2, userId: "u2", userName: "Bob", userRoles: [] } });
  const msg = `m-${run}`;
  sent.length = 0;
  await svc5.handleEvent(starEv(msg));
  assert.deepEqual(sent, ["star|nice"], "reaction rule fires");
  const svc6 = new RulesService(store); // "restart": empty memory
  await svc6.init(env);
  await svc6.handleEvent(starEv(msg));
  assert.equal(sent.length, 1, "after a restart, the same message doesn't fire again");
  await svc6.handleEvent(starEv(`${msg}-2`));
  assert.equal(sent.length, 2, "a new message still fires");

  // concurrent reactions in two processes: exactly one wins the claim
  const race = `${msg}-race`;
  const claims = await Promise.all([store.claimFire(star.rule.id, race), store.claimFire(star.rule.id, race)]);
  assert.deepEqual(claims.sort(), [false, true], "claim is atomic");

  // the database being down doesn't drop reactions (falls back to memory)
  const down = new RulesService(Object.assign(Object.create(store), { claimFire: async () => { throw new Error("db down"); } }));
  await down.init(env);
  sent.length = 0;
  await down.handleEvent(starEv(`${msg}-3`));
  await down.handleEvent(starEv(`${msg}-3`));
  assert.equal(sent.length, 1, "fires once using memory when the db is down");

  // pruning removes only old firings; removing a rule removes its firings
  await db.query("update rule_fires set fired_at = now() - interval '100 days' where message_id = $1", [msg]);
  assert((await store.pruneFires(90)) >= 1, "old firing pruned");
  assert.equal(await store.claimFire(star.rule.id, msg), true, "pruned message can be claimed again");
  assert.equal(await store.claimFire(star.rule.id, `${msg}-2`), false, "recent firing kept");
  await svc6.removeRule(star.rule.id);
  const left = await db.query("select 1 from rule_fires where rule_id = $1", [star.rule.id]);
  assert.equal(left.rowCount, 0, "firings deleted with their rule");

  // cooldowns: saved, upserted, loaded only while running, gone with their rule
  const cd = await svc6.addFromText(SERVER, `"CD" when message contains "cd" do send "ok" with cooldown 1h per user`, "u-admin");
  assert(cd.ok, cd.ok ? "" : cd.error);
  sent.length = 0;
  await svc6.handleEvent(ev({ content: "cd", authorId: "u7" }));
  await new Promise((r) => setTimeout(r, 50)); // the save runs in the background
  const svc7 = new RulesService(store); // restart
  await svc7.init(env);
  await svc7.handleEvent(ev({ content: "cd", authorId: "u7" }));
  assert.equal(sent.length, 1, "cooldown survived a restart (postgres)");
  await store.saveCooldown(cd.rule.id, "u8", Date.now() - 1000); // already over
  await store.saveCooldown(cd.rule.id, "u9", Date.now() + 5000);
  await store.saveCooldown(cd.rule.id, "u9", Date.now() + 9000); // upsert
  const mine = (await store.loadCooldowns()).filter((c) => c.ruleId === cd.rule.id);
  assert.deepEqual(mine.map((c) => c.scope).sort(), ["u7", "u9"], "expired ones aren't loaded");
  assert(Math.abs(mine.find((c) => c.scope === "u9")!.until - (Date.now() + 9000)) < 2000, "upsert keeps the latest, ms precision kept");
  assert((await store.pruneCooldowns()) >= 1, "expired pruned");

  // history (postgres): who/what/when, old names, survives removal
  await svc7.rename(SERVER, "CD", "Cooldown", "u-mod");
  let hist = (await svc7.history(SERVER, "CD"))!;
  assert.deepEqual(hist.map((h) => [h.action, h.userId]), [["renamed", "u-mod"], ["added", "u-admin"]], "history via old name");
  assert(Math.abs(hist[0].at - Date.now()) < 60_000, "timestamps in ms");
  await svc7.removeRule(cd.rule.id, "u-mod");
  assert.equal((await store.loadCooldowns()).some((c) => c.ruleId === cd.rule.id), false, "cooldowns removed with the rule");
  hist = (await svc7.history(SERVER, "Cooldown"))!;
  assert.equal(hist[0].action, "removed", "removed rule's history kept");
  assert.equal(hist[0].detail, `when message contains "cd" do send "ok" with cooldown 1h per user`);

  // failures (postgres): upsert per rule + error, newest per server, prune
  const fr = await svc7.addFromText(SERVER, `"FR" when message contains "fr" do reply "x"`);
  assert(fr.ok);
  const t0 = Date.now();
  await store.saveFailure({ serverId: SERVER, ruleId: fr.rule.id, ruleName: "FR", error: "boom", first: t0 - 5000, last: t0 - 5000, count: 1 });
  await store.saveFailure({ serverId: SERVER, ruleId: fr.rule.id, ruleName: "FR", error: "boom", first: t0 - 5000, last: t0, count: 4 });
  await store.saveFailure({ serverId: SERVER, ruleId: fr.rule.id, ruleName: "FR", error: "other", first: t0 - 1000, last: t0 - 1000, count: 1 });
  let fails = (await store.loadFailures(50)).filter((f) => f.serverId === SERVER);
  assert.deepEqual(fails.map((f) => [f.error, f.count]).sort(), [["boom", 4], ["other", 1]], "upserted per rule + error");
  assert(Math.abs(fails.find((f) => f.error === "boom")!.first - (t0 - 5000)) < 5, "first kept, ms precision");
  assert.deepEqual((await store.loadFailures(1)).filter((f) => f.serverId === SERVER).map((f) => f.error), ["boom"], "newest per server");
  await store.pruneFailures(30, 1);
  fails = (await store.loadFailures(50)).filter((f) => f.serverId === SERVER);
  assert.deepEqual(fails.map((f) => f.error), ["boom"], "only the newest kept per server");
  await db.query("update rule_failures set last_at = now() - interval '40 days' where rule_id = $1", [fr.rule.id]);
  await store.pruneFailures(30, 50);
  assert.equal((await store.loadFailures(50)).some((f) => f.ruleId === fr.rule.id), false, "old failures pruned");

  // history pruning (postgres): old entries go, each rule's newest stays
  await svc7.rename(SERVER, "FR", "FR2", "u-mod");
  await svc7.rename(SERVER, "FR2", "FR3", "u-mod");
  await db.query("update rule_history set at = now() - interval '400 days' where rule_id = $1", [fr.rule.id]);
  await store.pruneHistory(365);
  const frHist = (await store.history(SERVER, { ruleId: fr.rule.id }))!;
  assert.deepEqual(frHist.map((h) => [h.action, h.detail]), [["renamed", "FR2 → FR3"]], "only the newest entry kept");

  // log channel setting round-trips
  await store.setLogChannel(SERVER, "chan-1");
  await store.setLogChannel(SERVER, "chan-2");
  assert.equal((await store.loadSettings()).find((x) => x.serverId === SERVER)?.logChannelId, "chan-2", "setting upserted");
  await store.setLogChannel(SERVER, null);
  assert.equal((await store.loadSettings()).find((x) => x.serverId === SERVER)?.logChannelId, null, "turned off");

  console.log("store tests passed");
} finally {
  await db.query("delete from rules where server_id like $1", [`test-${run}-%`]);
  await db.query("delete from rule_history where server_id like $1", [`test-${run}-%`]);
  await db.query("delete from server_settings where server_id like $1", [`test-${run}-%`]);
  await db.close();
}
