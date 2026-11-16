import assert from "node:assert/strict";
import "../features/index.js";
import { actions, render, RuleEngine, summarizeRule, type Env, type Rule, type RuleEvent } from "../engine/index.js";
import { parseRule } from "../parser/index.js";

const sent: string[] = [];
const env: Env = {
  send: async (c, t, o) => {
    sent.push(`${c}|${t}${o?.replyTo ? "|reply" : ""}`);
    return { channelId: c, messageId: `sent${sent.length}` };
  },
  react: async () => {},
  channelServerId: async () => "s", // every channel in these tests is in server "s"
  log: () => {},
};

const SUN = Date.UTC(2026, 10, 15, 12, 0);
const MON = Date.UTC(2026, 10, 16, 12, 0);
const NIGHT = Date.UTC(2026, 10, 16, 23, 0);
const ev = (o: Partial<RuleEvent>): RuleEvent => ({
  type: "message.created", serverId: "s", channelId: "c1", messageId: "m1", authorId: "u1",
  authorIsBot: false, content: "", mentionedChannelIds: [], authorName: "Alice", attachments: [], authorRoles: [], timestamp: SUN, ...o,
});
const add = (engine: RuleEngine, id: string, text: string) => {
  const p = parseRule(text, { id, serverId: "s" });
  assert(p.ok, p.ok ? "" : p.error);
  engine.addRule(p.rule);
};

(async () => {
  // (contains AND sunday) OR mentions
  let engine = new RuleEngine(env);
  add(engine, "r1", `when message contains "SWS" and day is sunday or message mentions <#C2> do send "Submission from {author}" to <#C2>`);

  sent.length = 0; await engine.handle(ev({ content: "SWS my win" }));
  assert.deepEqual(sent, ["C2|Submission from <@u1>"], "SWS on Sunday");

  sent.length = 0; await engine.handle(ev({ content: "SWS my win", timestamp: MON }));
  assert.equal(sent.length, 0, "SWS on Monday should not match");

  sent.length = 0; await engine.handle(ev({ content: "hi <#C2>", mentionedChannelIds: ["C2"], timestamp: MON }));
  assert.equal(sent.length, 1, "OR branch (mention) matches on Monday");

  sent.length = 0; await engine.handle(ev({ content: "SWS", authorIsBot: true }));
  assert.equal(sent.length, 0, "bots ignored");

  // overnight window + reply
  engine = new RuleEngine(env);
  add(engine, "r2", `when time between "22:00" to "06:00" do reply "go to bed"`);
  sent.length = 0; await engine.handle(ev({ timestamp: NIGHT }));
  assert.deepEqual(sent, ["c1|go to bed|reply"], "overnight window");
  sent.length = 0; await engine.handle(ev({ timestamp: MON }));
  assert.equal(sent.length, 0, "noon is outside overnight window");

  // not
  engine = new RuleEngine(env);
  add(engine, "r3", `when not message contains "x" do react "👀"`);
  const dry = await engine.handle(ev({ content: "hello" }), { dryRun: true });
  assert.deepEqual(dry[0].steps, ["react with 👀"], "dry run + not");

  // errors
  const bad = parseRule(`when foo do bar`, { id: "x", serverId: "s" });
  assert(!bad.ok && /Unknown condition/.test(bad.error), "unknown condition");
  const tz = parseRule(`when day is sunday in "Mars/Base" do reply "x"`, { id: "y", serverId: "s" });
  assert(tz.ok);
  assert.throws(() => new RuleEngine(env).addRule(tz.rule), /timezone/i, "bad timezone rejected");

  // names
  engine = new RuleEngine(env);
  const named = parseRule(`"Small Wins" when message contains "SWS" do react "🎉"`, { id: "n1", serverId: "s" });
  assert(named.ok && named.rule.name === "Small Wins", "quoted name parsed");
  engine.addRule(named.rule);
  const unnamed = parseRule(`when message contains "x" do react "👀"`, { id: "n2", serverId: "s" });
  assert(unnamed.ok && unnamed.rule.name === "Rule n2", "default name");
  const dup = parseRule(`"small wins" when message contains "y" do react "👀"`, { id: "n3", serverId: "s" });
  assert(dup.ok);
  assert.throws(() => engine.addRule(dup.rule), /already exists/, "duplicate name (case-insensitive) rejected");
  const long = parseRule(`"${"x".repeat(61)}" when message contains "y" do react "👀"`, { id: "n4", serverId: "s" });
  assert(long.ok);
  assert.throws(() => new RuleEngine(env).addRule(long.rule), /too long/, "long name rejected");
  engine.addRule({ ...named.rule, name: "Renamed" }); // same id: replaces, no duplicate error
  assert.equal(parseRule(`"Other" when message contains "z" do react "👀"`, { id: "n5", serverId: "s" }).ok, true);

  // ---- new conditions
  const addTo = (e: RuleEngine, id: string, text: string) => {
    const p = parseRule(text, { id, serverId: "s" });
    assert(p.ok, p.ok ? "" : p.error);
    e.addRule(p.rule);
    return p.rule;
  };
  const rejects = (text: string, pattern: RegExp, why: string) => {
    const p = parseRule(text, { id: "bad", serverId: "s" });
    assert(p.ok, `${why}: should parse (${p.ok ? "" : p.error})`);
    assert.throws(() => new RuleEngine(env).addRule(p.rule), pattern, why);
  };

  engine = new RuleEngine(env);
  addTo(engine, "c1", `"In channel" when message in <#c1> do send "in c1"`);
  addTo(engine, "c2", `"Attach" when message has attachment do send "has file"`);
  addTo(engine, "c3", `"Regex" when message matches "^sws\\b" do send "regex"`);
  addTo(engine, "c4", `"Mods" when author has role "moderator" do send "mod"`);
  sent.length = 0; await engine.handle(ev({ content: "x", channelId: "c1" }));
  assert.deepEqual(sent, ["c1|in c1"], "message in <#c1>");
  sent.length = 0; await engine.handle(ev({ content: "x", channelId: "other" }));
  assert.equal(sent.length, 0, "other channel does not match");
  sent.length = 0; await engine.handle(ev({ content: "x", channelId: "other", attachments: [{ name: "a.png", url: "https://cdn/a.png", size: 10 }] }));
  assert.deepEqual(sent, ["other|has file"], "attachment");
  sent.length = 0; await engine.handle(ev({ content: "SWS: my win", channelId: "other" }));
  assert.deepEqual(sent, ["other|regex"], "regex matches");
  sent.length = 0; await engine.handle(ev({ content: "x", channelId: "other", authorRoles: [{ id: "r1", name: "Moderator" }] }));
  assert.deepEqual(sent, ["other|mod"], "role by name, case-insensitive");
  sent.length = 0; await engine.handle(ev({ content: "x", channelId: "other", authorRoles: [{ id: "moderator", name: "x" }] }));
  assert.deepEqual(sent, ["other|mod"], "role by id");

  rejects(`when message matches "(a+)+$" do send "x"`, /too complex/, "nested quantifier regex rejected");
  rejects(`when message matches "(a|aa)+" do send "x"`, /too complex/, "repeated alternation rejected");
  rejects(`when message matches "(a)\\1" do send "x"`, /Back-references/, "backreference rejected");
  rejects(`when message matches "[" do send "x"`, /Invalid pattern/, "invalid regex rejected");
  rejects(`when message matches "${"a".repeat(101)}" do send "x"`, /too long/, "long regex rejected");

  // ---- scheduled trigger
  const SUN_0600 = Date.UTC(2026, 10, 15, 6, 0); // 09:00 in Istanbul (UTC+3)
  engine = new RuleEngine(env);
  addTo(engine, "s1", `"SWS reminder" every sunday at 09:00 in "Europe/Istanbul" do send "Post your small wins!" to <#C9>`);
  sent.length = 0;
  assert.equal((await engine.tick(SUN_0600)).length, 1, "fires at 09:00 Istanbul on Sunday");
  assert.deepEqual(sent, ["C9|Post your small wins!"]);
  assert.equal((await engine.tick(SUN_0600 + 20_000)).length, 0, "not twice in the same minute");
  assert.equal((await engine.tick(SUN_0600 + 60_000)).length, 0, "not a minute later");
  assert.equal((await engine.tick(SUN_0600 + 24 * 3600_000)).length, 0, "not on Monday");
  assert.equal((await engine.tick(SUN_0600 + 7 * 24 * 3600_000)).length, 1, "fires again next Sunday");

  engine = new RuleEngine(env);
  const wk = addTo(engine, "s2", `every weekday at 17:30 do send "Stand-up" to <#C9>`);
  assert.deepEqual(wk.trigger.params, { days: ["mon", "tue", "wed", "thu", "fri"], at: "17:30" }, "weekday group");
  assert.equal((await engine.tick(Date.UTC(2026, 10, 18, 17, 30))).length, 1, "Wednesday fires (UTC default)");
  assert.equal((await engine.tick(Date.UTC(2026, 10, 21, 17, 30))).length, 0, "Saturday does not");
  engine = new RuleEngine(env);
  engine.addRule({ ...(wk as Rule), enabled: false });
  assert.equal((await engine.tick(Date.UTC(2026, 10, 18, 17, 30))).length, 0, "disabled rule never ticks");

  rejects(`every day at 09:00 do reply "x"`, /can't be used with a schedule/, "message action rejected on schedule");
  rejects(`every day at 09:00 do send "x"`, /must say where to send/, "schedule send needs a channel");
  rejects(`every day at 09:00 when message contains "x" do send "x" to <#C9>`, /can't be used with a schedule/, "message condition rejected on schedule");
  rejects(`every day at 25:00 do send "x" to <#C9>`, /HH:MM/, "bad time rejected");
  const nope = parseRule(`foo do send "x"`, { id: "x", serverId: "s" });
  assert(!nope.ok && /every sunday at 09:00/.test(nope.error), "helpful error for a bad start");

  // time conditions still work inside a scheduled rule
  engine = new RuleEngine(env);
  addTo(engine, "s3", `every day at 06:00 when day is sunday do send "sunday only" to <#C9>`);
  sent.length = 0; await engine.tick(SUN_0600); assert.deepEqual(sent, ["C9|sunday only"], "schedule + condition on Sunday");
  sent.length = 0; await engine.tick(SUN_0600 + 24 * 3600_000); assert.equal(sent.length, 0, "condition blocks Monday");

  // ---- summaries and simulation
  engine = new RuleEngine(env);
  const sws = addTo(engine, "sum", `"SWS" when message contains "SWS" and day is sunday in "Europe/Istanbul" or message in <#C2> do send "hi {author}" to <#C2> then react "🎉"`);
  const sum = summarizeRule(sws);
  assert.equal(sum.trigger, "a message is sent");
  assert.deepEqual(sum.conditions, ['(message contains "SWS" and the day is Sunday (Europe/Istanbul)) or message is sent in <#C2>']);
  assert.deepEqual(sum.actions, ['send "hi {author}" to <#C2>', "react with 🎉"]);
  const sim = engine.simulate(sws, ev({ content: "hello", timestamp: MON }));
  assert.equal(sim.matched, false, "simulation: no match");
  assert.equal(sim.conditions.length, 1);
  assert.deepEqual(sim.steps, ["send \"hi <@u1>\" to <#C2>", "react with 🎉"], "simulation renders templates");
  const sim2 = engine.simulate(addTo(new RuleEngine(env), "sim2", `when message contains "a" and message contains "b" do reply "x"`), ev({ content: "a only" }));
  assert.deepEqual(sim2.conditions.map((c) => c.passed), [true, false], "per-condition results");

  // ---- masquerade and files
  const calls: { c: string; t: string; o?: unknown }[] = [];
  const env2: Env = { ...env, send: async (c, t, o) => (calls.push({ c, t, o }), { channelId: c, messageId: "x" }) };
  const file = { name: "win.png", url: "https://cdn.example/win.png", size: 100 };

  engine = new RuleEngine(env2);
  const fwd = addTo(engine, "f1", `"SWS" when message contains "SWS" do send "{message}" to <#C2> with masquerade and files`);
  assert.deepEqual(fwd.actions[0].params, { text: "{message}", channel: "C2", masquerade: true, files: true });
  await engine.handle(ev({ content: "SWS my win", authorName: "Alice", authorAvatarUrl: "https://cdn.example/a.png", attachments: [file] }));
  assert.deepEqual(calls, [{
    c: "C2", t: "SWS my win",
    o: { masquerade: { name: "Alice", avatarUrl: "https://cdn.example/a.png" }, files: [file] },
  }], "masquerade + files passed to the platform");

  // every spelling of the optional parts
  const paramsOf = (text: string) => addTo(new RuleEngine(env2), "p", text).actions[0].params;
  assert.deepEqual(paramsOf(`when message contains "a" do send "x" to <#C2> with files and masquerade`), { text: "x", channel: "C2", masquerade: true, files: true });
  assert.deepEqual(paramsOf(`when message contains "a" do send "x" to <#C2> with masquerade`), { text: "x", channel: "C2", masquerade: true });
  assert.deepEqual(paramsOf(`when message contains "a" do send "x" to <#C2> with files`), { text: "x", channel: "C2", files: true });
  assert.deepEqual(paramsOf(`when message contains "a" do send "x" with masquerade`), { text: "x", masquerade: true });
  assert.deepEqual(paramsOf(`when message contains "a" do send "x" to <#C2>`), { text: "x", channel: "C2" });

  // a file-only message still goes through; a truly empty one fails loudly
  engine = new RuleEngine(env2);
  addTo(engine, "f2", `when message in <#c1> do send "{message}" to <#C2> with files`);
  calls.length = 0;
  await engine.handle(ev({ content: "", attachments: [file] }));
  assert.equal(calls.length, 1, "file-only submission forwarded");
  const empty = await engine.handle(ev({ content: "", attachments: [] }));
  assert.match(empty[0].error ?? "", /nothing to send/, "empty message with no files errors");

  // fallback name, and {author.name}
  engine = new RuleEngine(env2);
  addTo(engine, "f3", `when message contains "hi" do send "Thanks {author.name}!" with masquerade`);
  calls.length = 0;
  await engine.handle(ev({ content: "hi", authorName: "" }));
  assert.deepEqual(calls[0], { c: "c1", t: "Thanks !", o: { masquerade: { name: "Unknown", avatarUrl: undefined }, files: undefined } }, "masquerade falls back to Unknown");

  rejects(`every day at 09:00 do send "x" to <#C9> with masquerade`, /only work on message rules/, "masquerade on a scheduled rule rejected");
  rejects(`every day at 09:00 do send "x" to <#C9> with files`, /only work on message rules/, "files on a scheduled rule rejected");
  rejects(`when message contains "a" do send "" to <#C2>`, /can't be empty/, "empty literal text rejected");
  addTo(new RuleEngine(env2), "ok", `when message has attachment do send "" to <#C2> with files`); // allowed: files carry the message

  // ---- react to the message the rule sent
  const reacts: string[] = [];
  let sendCount = 0;
  let failSend = false;
  const env3: Env = {
    send: async (c) => {
      if (failSend) throw new Error("no permission");
      return { channelId: c, messageId: `posted${++sendCount}` };
    },
    react: async (c, m, e) => void reacts.push(`${c}/${m}/${e}`),
    channelServerId: env.channelServerId,
    log: () => {},
  };

  const both = addTo(new RuleEngine(env3), "rs0", `when message contains "SWS" do send "{message}" to <#chan> with masquerade and files then react "🎉" then react "🎉" to sent`);
  assert.deepEqual(both.actions.slice(1).map((a) => a.params), [{ emoji: "🎉" }, { emoji: "🎉", target: "sent" }], "both react syntaxes parse");

  engine = new RuleEngine(env3);
  addTo(engine, "rs1", `when message contains "SWS" do send "{message}" to <#C2> then react "🎉" then react "🔥" to sent`);
  reacts.length = 0;
  const rs = await engine.handle(ev({ content: "SWS win" }));
  assert.equal(rs[0].error, undefined);
  assert.deepEqual(reacts, ["c1/m1/🎉", `C2/posted${sendCount}/🔥`], "react to the original, then to the sent message by its returned id");

  // a second send moves the target to the newest message
  engine = new RuleEngine(env3);
  addTo(engine, "rs2", `when message contains "a" do send "one" to <#C2> then send "two" to <#C3> then react "👀" to sent`);
  reacts.length = 0; await engine.handle(ev({ content: "a" }));
  assert.deepEqual(reacts, [`C3/posted${sendCount}/👀`], "reacts to the most recent send");

  rejects(`when message contains "a" do react "🎉" to sent`, /needs a send action before it/, "react to sent with no send rejected");
  rejects(`when message contains "a" do react "🎉" to sent then send "x" to <#C2>`, /needs a send action before it/, "react to sent before the send rejected");
  rejects(`when message contains "a" do reply "x" then react "🎉" to sent`, /needs a send action before it/, "reply does not count as a send");
  rejects(`when message contains "a" do react "smile"`, /single unicode emoji/, "word instead of emoji rejected");
  rejects(`when message contains "a" do react "🎉🎉"`, /single unicode emoji/, "two emoji rejected");
  rejects(`every day at 09:00 do send "x" to <#C9> then react "🎉"`, /can't be used with a schedule/, "plain react still needs a message");

  const custom = addTo(new RuleEngine(env3), "rs3", `when message contains "a" do react ":01J9Z8Y7X6W5V4T3S2R1Q0P9N8:"`);
  assert.equal(engine.simulate(custom, ev({ content: "a" })).steps[0], "react with 01J9Z8Y7X6W5V4T3S2R1Q0P9N8", "custom emoji id accepted, colons stripped");

  // the send fails: the rule stops there and nothing is reacted to
  engine = new RuleEngine(env3);
  addTo(engine, "rs4", `when message contains "a" do send "x" to <#C2> then react "🎉" to sent`);
  failSend = true; reacts.length = 0;
  const failed = await engine.handle(ev({ content: "a" }));
  failSend = false;
  assert.match(failed[0].error ?? "", /message.send failed: no permission/, "send error reported");
  assert.equal(reacts.length, 0, "no react after a failed send");

  // called with an empty run state (as if the send was skipped), react to sent fails clearly
  const reactDef = actions.get("message.react")!;
  await assert.rejects(reactDef.run(ev({}), { emoji: "🎉", target: "sent" }, env3, {}), /nothing was sent earlier/, "react to sent without a sent message errors");

  // scheduled rule: send, then react to what it sent
  engine = new RuleEngine(env3);
  addTo(engine, "rs5", `every sunday at 06:00 do send "Post your wins!" to <#C9> then react "🎉" to sent`);
  reacts.length = 0;
  const sched = await engine.tick(SUN_0600);
  assert.equal(sched[0].error, undefined);
  assert.deepEqual(reacts, [`C9/posted${sendCount}/🎉`], "scheduled rule reacts to its own message");

  // dry run and simulation never touch env
  const before = sendCount;
  reacts.length = 0;
  engine = new RuleEngine(env3);
  const simRule = addTo(engine, "rs6", `when message contains "a" do send "x" to <#C2> then react "🎉" to sent`);
  const dryRun = await engine.handle(ev({ content: "a" }), { dryRun: true });
  assert.deepEqual(dryRun[0].steps, ['send "x" to <#C2>', "react with 🎉 to the sent message"], "dry run steps");
  assert.deepEqual(engine.simulate(simRule, ev({ content: "a" })).steps, ['send "x" to <#C2>', "react with 🎉 to the sent message"], "simulation steps");
  assert.equal(sendCount, before, "dry run does not send");
  assert.equal(reacts.length, 0, "dry run does not react");
  assert.deepEqual(summarizeRule(simRule).actions[1], "react with 🎉 to the sent message", "rule show text");

  // ---- cooldown syntax
  {
    const cd = (text: string) => parseRule(text, { id: "cd", serverId: "s" });
    const r1 = cd(`when message contains "hi" do reply "hey" with cooldown 5m`);
    assert(r1.ok && r1.rule.cooldownMs === 300_000 && !r1.rule.cooldownPerUser, "cooldown 5m");
    const r2 = cd(`when message contains "hi" do send "x" to <#C2> with masquerade then react "🎉" with cooldown 1h30m per user`);
    assert(r2.ok && r2.rule.cooldownMs === 5_400_000 && r2.rule.cooldownPerUser, "cooldown after send modifiers, per user");
    assert.equal(r2.ok && r2.rule.actions[0].params.masquerade, true, "send modifiers still parsed");
    const r3 = cd(`when message contains "hi" do reply "x" with cooldown soon`);
    assert(!r3.ok && /duration/.test(r3.error), "bad duration");
    const r4 = cd(`when message contains "hi" do reply "x" with cooldown 8d`);
    assert(r4.ok);
    assert.throws(() => new RuleEngine(env).addRule(r4.rule), /at most 7 days/, "cooldown max");
    const r5 = cd(`every day at 09:00 do send "x" to <#C2> with cooldown 1m per user`);
    assert(r5.ok);
    assert.throws(() => new RuleEngine(env).addRule(r5.rule), /per user/, "per user needs a message rule");
    assert.equal(summarizeRule(r2.ok ? r2.rule : (null as never)).cooldown, "1h30m per user", "rule show cooldown");

    engine = new RuleEngine(env);
    add(engine, "cd1", `when message contains "hi" do reply "hey" with cooldown 1m`);
    sent.length = 0;
    await engine.handle(ev({ content: "hi", timestamp: SUN }));
    await engine.handle(ev({ content: "hi", timestamp: SUN + 30_000, authorId: "u2" }));
    assert.equal(sent.length, 1, "second message within cooldown is skipped, for everyone");
    await engine.handle(ev({ content: "hi", timestamp: SUN + 61_000 }));
    assert.equal(sent.length, 2, "runs again after the cooldown");
    await engine.handle(ev({ content: "nope", timestamp: SUN + 200_000 }));
    await engine.handle(ev({ content: "hi", timestamp: SUN + 200_001 }));
    assert.equal(sent.length, 3, "non-matching messages don't start the cooldown");
    await engine.handle(ev({ content: "hi", timestamp: SUN + 400_000 }), { dryRun: true });
    await engine.handle(ev({ content: "hi", timestamp: SUN + 400_001 }));
    assert.equal(sent.length, 4, "dry runs don't start the cooldown");

    engine = new RuleEngine(env);
    add(engine, "cd2", `when message contains "SWS" do reply "got it" with cooldown 10m per user`);
    sent.length = 0;
    await engine.handle(ev({ content: "SWS", authorId: "u1", timestamp: SUN }));
    await engine.handle(ev({ content: "SWS", authorId: "u2", timestamp: SUN + 1000 }));
    await engine.handle(ev({ content: "SWS", authorId: "u1", timestamp: SUN + 2000 }));
    assert.equal(sent.length, 2, "per user: other users aren't blocked, the same user is");
  }

  // ---- reaction trigger
  {
    const rev = (count: number, o: Partial<RuleEvent> = {}, r: Partial<NonNullable<RuleEvent["reaction"]>> = {}) =>
      ev({ type: "reaction.added", content: "my win", reaction: { emoji: "⭐", count, userId: "u9", userName: "Bob", userRoles: [], ...r }, ...o });

    engine = new RuleEngine(env);
    const star = addTo(engine, "st", `"Starboard" on reaction "⭐" reaches 3 do send "{message} (starred by {reactor.name})" to <#STAR> with masquerade and files`);
    assert.deepEqual(star.trigger, { type: "reaction.added", params: { emoji: "⭐", count: 3 } }, "trigger parsed");
    assert.equal(summarizeRule(star).trigger, "a message reaches 3 ⭐ reactions");
    sent.length = 0;
    await engine.handle(rev(2));
    assert.equal(sent.length, 0, "below threshold");
    await engine.handle(rev(3));
    assert.deepEqual(sent, ["STAR|my win (starred by Bob)"], "fires at threshold with message + reactor");
    await engine.handle(rev(4));
    await engine.handle(rev(3));
    assert.equal(sent.length, 1, "only once per message (more stars, or unreact + react)");
    await engine.handle(rev(3, { messageId: "m2" }));
    assert.equal(sent.length, 2, "another message fires on its own");
    await engine.handle(rev(3, { messageId: "m3" }, { emoji: "🎉" }));
    assert.equal(sent.length, 2, "other emoji ignored");
    await engine.handle(rev(3, { messageId: "m4" }, { emoji: "⭐️" }));
    assert.equal(sent.length, 3, "variation selector ignored");
    await engine.handle(rev(3, { messageId: "m5", authorIsBot: true }));
    assert.equal(sent.length, 3, "bot messages (e.g. reposts) ignored");
    await engine.handle(ev({ content: "my win" }));
    assert.equal(sent.length, 3, "new messages don't fire reaction rules");

    // approval: plain "on reaction" fires on any add, gated by the reactor's role; custom emoji ids
    engine = new RuleEngine(env);
    const ok = addTo(engine, "ap", `on reaction ":01KJJV6Z86D3R2ANPMY078V6PK:" when reactor has role "Mod" and message has attachment do send "{message}" to <#OK> then react "✅"`);
    assert.equal(ok.trigger.params.emoji, ":01KJJV6Z86D3R2ANPMY078V6PK:");
    const custom = { emoji: "01KJJV6Z86D3R2ANPMY078V6PK" };
    const file = { name: "a.png", url: "https://cdn/a.png", size: 1 };
    sent.length = 0;
    await engine.handle(rev(1, { attachments: [file] }, custom));
    assert.equal(sent.length, 0, "non-mod reaction does nothing");
    await engine.handle(rev(2, { attachments: [file] }, { ...custom, userRoles: [{ id: "r", name: "mod" }] }));
    assert.deepEqual(sent, ["OK|my win"], "mod reacting second still approves");
    await engine.handle(rev(3, { attachments: [file] }, { ...custom, userRoles: [{ id: "r", name: "mod" }] }));
    assert.equal(sent.length, 1, "a second mod doesn't approve twice");

    // validation: reactor condition only on reaction rules; message blocks allowed on reaction rules
    const bad = parseRule(`when reactor has role "Mod" do reply "x"`, { id: "b", serverId: "s" });
    assert(bad.ok);
    assert.throws(() => new RuleEngine(env).addRule(bad.rule), /can't be used/, "reactor condition needs a reaction rule");
    const badEmoji = parseRule(`on reaction "star" do reply "x"`, { id: "b2", serverId: "s" });
    assert(badEmoji.ok);
    assert.throws(() => new RuleEngine(env).addRule(badEmoji.rule), /Emoji must be/, "bad emoji rejected");
    assert.equal(render("{reactor} {reactor.name}", ev({})), "{reactor} {reactor.name}", "reactor vars only on reaction events");

    // durable fired log: consulted on the first firing per message, skipped when it says "already fired"
    const claimed: string[] = [];
    let alreadyFired = new Set<string>(["old"]);
    const log = { claim: async (r: string, m: string) => (claimed.push(`${r}:${m}`), !alreadyFired.has(m)) };
    engine = new RuleEngine(env, undefined, log);
    addTo(engine, "dl", `on reaction "⭐" reaches 2 do send "x" to <#S>`);
    sent.length = 0;
    await engine.handle(rev(2, { messageId: "old" }));
    assert.equal(sent.length, 0, "fired before a restart: skipped");
    await engine.handle(rev(2, { messageId: "new" }));
    await engine.handle(rev(2, { messageId: "new" }));
    assert.equal(sent.length, 1, "fires once");
    assert.deepEqual(claimed, ["dl:old", "dl:new"], "memory answers repeats without asking the log");
    await engine.handle(rev(1, { messageId: "below" }));
    assert.equal(claimed.length, 2, "no claim when the rule doesn't run");
    await engine.handle(rev(2, { messageId: "dry" }), { dryRun: true });
    assert.equal(claimed.length, 2, "dry runs don't claim");

    // two reactions at once in the same process: one fires
    sent.length = 0;
    await Promise.all([engine.handle(rev(2, { messageId: "race" })), engine.handle(rev(2, { messageId: "race" }))]);
    assert.equal(sent.length, 1, "concurrent events fire once");

    // log down: fall back to memory instead of dropping the event
    engine = new RuleEngine(env, undefined, { claim: async () => { throw new Error("db down"); } });
    addTo(engine, "dl2", `on reaction "⭐" reaches 2 do send "x" to <#S>`);
    sent.length = 0;
    await engine.handle(rev(2, { messageId: "a" }));
    await engine.handle(rev(2, { messageId: "a" }));
    assert.equal(sent.length, 1, "log down: fires once, from memory");

    // a cooldown skip doesn't use up the message
    alreadyFired = new Set();
    engine = new RuleEngine(env, undefined, log);
    addTo(engine, "dl3", `on reaction "⭐" do send "x" to <#S> with cooldown 1m`);
    sent.length = 0;
    await engine.handle(rev(1, { messageId: "p", timestamp: SUN }));
    await engine.handle(rev(1, { messageId: "q", timestamp: SUN + 1000 }));
    await engine.handle(rev(2, { messageId: "q", timestamp: SUN + 61_000 }));
    assert.equal(sent.length, 2, "message skipped by cooldown fires on a later reaction");
  }

  // editing a rule's trigger forgets which messages it fired on (in memory)
  {
    engine = new RuleEngine(env);
    const r1 = addTo(engine, "tr", `on reaction "⭐" do send "x" to <#S>`);
    const star = ev({ type: "reaction.added", reaction: { emoji: "⭐", count: 1, userId: "u2", userName: "B", userRoles: [] } });
    sent.length = 0;
    await engine.handle(star);
    engine.addRule({ ...r1, name: "renamed" }); // same trigger: still remembered
    await engine.handle(star);
    assert.equal(sent.length, 1, "same trigger keeps the memory");
    engine.addRule({ ...r1, trigger: { type: "reaction.added", params: { emoji: "✅" } } });
    engine.addRule(r1);
    await engine.handle(star);
    assert.equal(sent.length, 2, "changed trigger starts fresh");
  }

  // ---- author is
  {
    const ALICE = "01KJJV6Z86D3R2ANPMY078V6PK";
    const BOB = "01KPZPT2D9Q4FG4M2SVZZAMBXA";
    engine = new RuleEngine(env);
    const r1 = addTo(engine, "ai", `when author is <@${ALICE}> do reply "hi boss"`);
    assert.deepEqual(r1.conditions[0], { type: "author.is", params: { user: ALICE } }, "mention parsed");
    assert.equal(summarizeRule(r1).conditions[0], `author is the user \`${ALICE}\``, "rule show doesn't ping");
    sent.length = 0;
    await engine.handle(ev({ authorId: ALICE }));
    await engine.handle(ev({ authorId: BOB }));
    assert.deepEqual(sent, ["c1|hi boss|reply"], "only that user");

    // other spellings: <@!id>, a bare id, lower case
    for (const spelled of [`<@!${ALICE}>`, ALICE, ALICE.toLowerCase()]) {
      const r = parseRule(`when author is ${spelled} do reply "x"`, { id: "sp", serverId: "s" });
      assert(r.ok, spelled);
      new RuleEngine(env).addRule(r.rule);
    }
    // not a user
    const me = parseRule(`when author is me do reply "x"`, { id: "me", serverId: "s" });
    assert(me.ok);
    assert.throws(() => new RuleEngine(env).addRule(me.rule), /Pick the user with @/, "non-id rejected");

    // or / not
    engine = new RuleEngine(env);
    add(engine, "ao", `when author is <@${ALICE}> or author is <@${BOB}> do reply "team"`);
    add(engine, "an", `when message contains "SWS" and not author is <@${ALICE}> do reply "thanks"`);
    sent.length = 0;
    await engine.handle(ev({ authorId: BOB, content: "SWS" }));
    await engine.handle(ev({ authorId: ALICE, content: "SWS" }));
    await engine.handle(ev({ authorId: "01KZZZZZZZZZZZZZZZZZZZZZZZ", content: "SWS" }));
    assert.deepEqual(sent, ["c1|team|reply", "c1|thanks|reply", "c1|team|reply", "c1|thanks|reply"], "or + not");

    // on reaction rules it's the reacted message's author; mentions inside text stay text
    engine = new RuleEngine(env);
    const rr = addTo(engine, "ar", `on reaction "⭐" when author is <@${ALICE}> do send "star for <@${ALICE}>" to <#S>`);
    assert.equal(rr.actions[0].params.text, `star for <@${ALICE}>`);
    sent.length = 0;
    const react = (authorId: string) => ev({ type: "reaction.added", messageId: authorId, authorId, reaction: { emoji: "⭐", count: 1, userId: BOB, userName: "B", userRoles: [] } });
    await engine.handle(react(ALICE));
    await engine.handle(react(BOB));
    assert.deepEqual(sent, [`S|star for <@${ALICE}>`], "reaction rule: author of the reacted message");

    // scheduled rules have no author
    const sch = parseRule(`every day at 09:00 when author is <@${ALICE}> do send "x" to <#S>`, { id: "as", serverId: "s" });
    assert(sch.ok);
    assert.throws(() => new RuleEngine(env).addRule(sch.rule), /can't be used/, "needs a message");
  }

  // ---- abuse guards
  {
    // a fake Stoat that sends every bot post back in as a new message, like the gateway does
    const feedback = (opts: { botFlag: boolean; owner?: (c: string) => string | undefined }) => {
      const queue: RuleEvent[] = [];
      const posted: string[] = [];
      const fake: Env = {
        send: async (c, t) => {
          posted.push(`${c}|${t}`);
          queue.push(ev({ channelId: c, messageId: `b${posted.length}`, authorId: "BOT", authorIsBot: opts.botFlag, content: t, timestamp: SUN }));
          return { channelId: c, messageId: `b${posted.length}` };
        },
        react: async (c) => void posted.push(`${c}|react`),
        channelServerId: async (c) => (opts.owner ? opts.owner(c) : "s"),
        log: () => {},
      };
      return { fake, queue, posted };
    };
    const drain = async (e: RuleEngine, q: RuleEvent[], cap = 500) => {
      for (let i = 0; q.length && i < cap; i++) await e.handle(q.shift()!);
    };

    // loops: stopped by "ignore bots"
    let f = feedback({ botFlag: true });
    engine = new RuleEngine(f.fake);
    add(engine, "l1", `when message contains "ping" do send "pong"`);
    add(engine, "l2", `when message contains "pong" do send "ping"`);
    await engine.handle(ev({ content: "ping", timestamp: SUN }));
    await drain(engine, f.queue);
    assert.deepEqual(f.posted, ["c1|pong"], "ping-pong stops after one message");

    // ...and if the bot flag were ever missing, the rate limit still ends it (burst 30)
    f = feedback({ botFlag: false });
    engine = new RuleEngine(f.fake);
    add(engine, "l3", `when message contains "ping" do send "ping"`);
    await engine.handle(ev({ content: "ping", timestamp: SUN }));
    await drain(engine, f.queue);
    assert.equal(f.posted.length, 30, "runaway loop capped by the rate limit");
    assert.equal(f.queue.length, 0, "and it actually stops");

    // amplification: 50 rules x 5 sends from one message is capped too
    f = feedback({ botFlag: true });
    engine = new RuleEngine(f.fake);
    for (let i = 0; i < 50; i++) add(engine, `a${i}`, `when message contains "go" do send "x" then send "x" then send "x" then send "x" then send "x"`);
    const reports = await engine.handle(ev({ content: "go", timestamp: SUN }));
    assert.equal(f.posted.length, 30, "250 sends capped at 30");
    assert(reports.some((r) => /rate limited/.test(r.error ?? "")), "skipped runs say why");

    // the budget refills over time (3 per second), per server
    f.posted.length = 0;
    await engine.handle(ev({ content: "go", timestamp: SUN + 2000 }));
    assert.equal(f.posted.length, 6, "after 2s: 6 more");
    await engine.handle(ev({ content: "go", serverId: "other", timestamp: SUN + 2000 }));
    assert.equal(f.posted.length, 6, "other server has no rules here, and isn't charged for ours");

    // cross-server: a rule may only act in its own server, checked when it runs...
    f = feedback({ botFlag: true, owner: (c) => (c === "THEIRS" ? "victim" : "s") });
    engine = new RuleEngine(f.fake);
    add(engine, "x1", `when message contains "hi" do send "spam" to <#THEIRS>`);
    add(engine, "x2", `when message contains "hi" do send "ok" to <#MINE> then react "👍" to sent`);
    const xr = await engine.handle(ev({ content: "hi", timestamp: SUN }));
    assert.deepEqual(f.posted, ["MINE|ok", "MINE|react"], "own channel works, other server's is refused");
    assert.match(xr[0].error ?? "", /isn't in this server/);
    // ...including unknown/deleted channels
    f = feedback({ botFlag: true, owner: () => undefined });
    engine = new RuleEngine(f.fake);
    add(engine, "x3", `when message contains "hi" do send "x" to <#GONE> then reply "same channel is fine"`);
    await engine.handle(ev({ content: "hi", timestamp: SUN }));
    assert.deepEqual(f.posted, [], "unknown channel refused (and the rule stops there)");
    add(engine, "x4", `when message contains "yo" do reply "same channel is fine"`);
    await engine.handle(ev({ content: "yo", timestamp: SUN }));
    assert.deepEqual(f.posted, ["c1|same channel is fine"], "the event's own channel needs no lookup");
  }

  console.log("all smoke tests passed");
})();
