import "reflect-metadata";
import assert from "node:assert/strict";
import type { CommandContext } from "stoatx";
import "../features/index.js";
import type { Env } from "../engine/index.js";
import { RuleCommands } from "../bot/commands.js";
import { RulesService } from "../bot/RulesService.js";
import { FakeStore } from "./fakeStore.js";

/* The `rule` command end to end, through the router, with a fake chat context (no Stoat). */

const S = "srv";
const env: Env = {
  send: async (c) => ({ channelId: c, messageId: "x" }),
  react: async () => {},
  channelServerId: async (id) => (id === "THEIRS" ? "other" : S),
  log: () => {},
};
const store = new FakeStore();
const rules = new RulesService(store.asStore);
await rules.init(env);
const cmd = new RuleCommands(rules);

let replies: string[] = [];
async function run(text: string, opts: { serverId?: string | undefined } = {}) {
  replies = [];
  const content = `!${text}`;
  const ctx = {
    content, prefix: "!", authorId: "admin", channelId: "c1", serverId: "serverId" in opts ? opts.serverId : S,
    reply: async (t: string) => void replies.push(t),
    message: {
      id: "m1", channelId: "c1", serverId: S, authorId: "admin", content,
      author: { bot: false, username: "admin" }, attachments: [], server: { channelIds: [], roles: { cache: new Map() } },
    },
    client: { users: { fetch: async (id: string) => ({ username: `user-${id}` }) }, channels: { cache: new Map() } },
  } as unknown as CommandContext;
  await cmd.rule(text.split(/\s+/)[1] ?? "", ctx);
  return replies.join("\n");
}

assert.match(await run("rule list"), /No rules yet/);
assert.match(await run(`rule add "Hi" when message contains "hi" do reply "hey"`), /Rule \*\*Hi\*\* .* added/);
assert.match(await run("rule list"), /● \*\*Hi\*\*/);
assert.match(await run(`rule add "Bad" when mesage contains "x" do reply "y"`), /Did you mean\?[\s\S]*"mesage" → "message"/, "suggestions");
assert.match(await run("rule show hi"), /\*\*When:\*\* a message is sent[\s\S]*Last change: added by user-admin/);
assert.match(await run("rule test Hi oh hi there"), /Would run/);
assert.match(await run("rule disable Hi"), /now off/);
assert.match(await run("rule enable Hi"), /now on/);
assert.match(await run(`rule edit Hi when message contains "hi" do reply "hello"`), /Updated \*\*Hi\*\*/);
assert.match(await run(`rule rename Hi "Greeting"`), /Renamed to \*\*Greeting\*\*/);
assert.match(await run("rule history Greeting"), /History of Greeting[\s\S]*renamed by user-admin: Hi → Greeting[\s\S]*added by user-admin/);
assert.match(await run("rule logs"), /No recent rule failures/);
assert.match(await run("rule logs channel <#THEIRS>"), /isn't in this server/);
assert.match(await run("rule logs channel <#LOG>"), /will be posted in <#LOG>/);
assert.match(await run("rule logs channel"), /posted in <#LOG>/);
assert.match(await run("rule logs channel off"), /Stopped/);
assert.match(await run("rule remove Greeting"), /removed/);
assert.match(await run("rule history Greeting"), /removed by user-admin[\s\S]*To add it back:\n```\n!rule add "Greeting" when message contains "hi" do reply "hello"\n```/);
assert.match(await run("rule import"), /Attach a rules file/);
assert.match(await run("rule nope"), /^Commands:/, "unknown subcommand: usage");
assert.match(await run("rule constructor"), /^Commands:/, "object keys aren't subcommands");
assert.match(await run("rule list", { serverId: undefined }), /only work inside a server/);

console.log("command tests passed");
