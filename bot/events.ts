import { Stoat, On, Once, type Client } from "stoatx";
import type { Message, MessageOptions, TextChannel } from "stoatx";
import type { Env } from "../engine/index.js";
import { PREFIX } from "./config.js";
import { downloadFiles } from "./files.js";
import { RulesService } from "./RulesService.js";
import { toEvent, toReactionEvent } from "./toEvent.js";

async function textChannel(client: Client, channelId: string): Promise<TextChannel> {
  const channel = client.channels.cache.get(channelId) ?? (await client.channels.fetch(channelId));
  return channel as TextChannel;
}

export function makeEnv(client: Client): Env {
  return {
    send: async (channelId, text, opts) => {
      const channel = await textChannel(client, channelId);
      const message: MessageOptions = { content: text };
      if (opts?.replyTo) message.replies = [{ id: opts.replyTo, mention: false }];
      if (opts?.masquerade) {
        // Stoat limits masquerade names to 32 characters
        message.masquerade = { name: opts.masquerade.name.slice(0, 32), avatar: opts.masquerade.avatarUrl ?? null };
      }
      if (opts?.files?.length) {
        const { builders, skipped } = await downloadFiles(opts.files);
        if (builders.length) message.attachments = builders;
        // Don't lose a submission silently: say what couldn't be copied.
        if (skipped.length) message.content = `${text}\n_(Couldn't copy: ${skipped.join(", ")})_`.trim();
      }
      const posted = await channel.send(message);
      return { channelId: posted.channelId, messageId: posted.id };
    },
    react: async (channelId, messageId, emoji) => {
      const channel = await textChannel(client, channelId);
      const msg = await channel.messages.fetch(messageId);
      await msg.react(emoji);
    },
    channelServerId: async (channelId) => {
      try {
        const channel = client.channels.cache.get(channelId) ?? (await client.channels.fetch(channelId));
        return (channel as { serverId?: string }).serverId;
      } catch {
        return undefined; // deleted, or a channel the bot can't see
      }
    },
    log: (m) => console.log(m),
  };
}

/** Mirrors how stoatx decides a message is addressed to the bot: the prefix, or an @mention of the bot. */
function isCommandMessage(client: Client, content: string): boolean {
  if (content.startsWith(PREFIX)) return true;
  const mention = content.match(/^<@!?(\w+)>/);
  return !!mention && mention[1] === client.user?.id;
}

@Stoat()
export class BotEvents {
  constructor(private readonly rules: RulesService) {}

  /**
   * Load rules and start the scheduler as soon as the bot is online, so scheduled rules
   * work even if nobody has sent a message yet. (stoatx passes the client as the last argument.)
   */
  @Once("ready")
  async onReady(...args: unknown[]) {
    const client = args[args.length - 1] as Client;
    await this.rules.ensureInit(makeEnv(client));
    this.rules.startScheduler();
  }

  @On("messageCreate")
  async onMessage(message: Message, client: Client) {
    if (message.author?.bot) return;

    // Normally a no-op (already loaded on "ready"); a safety net if this runs first.
    await this.rules.ensureInit(makeEnv(client));

    await client.executeCommand(message);

    // Don't let commands (e.g. "!rule add ... SWS ...") trigger rules.
    if (isCommandMessage(client, message.content ?? "")) return;

    const ev = toEvent(message);
    if (ev) await this.rules.handleEvent(ev).catch((e) => console.error("rule engine error", e));
  }

  @On("messageReact")
  async onReact(target: Message | { id: string; channelId: string }, emoji: string, userId: string, client: Client) {
    if (userId === client.user?.id) return; // our own reactions (e.g. a rule's `react`)
    await this.rules.ensureInit(makeEnv(client));
    // Skip the fetches below when no server has a reaction rule.
    if (!this.rules.hasTrigger("reaction.added")) return;
    try {
      const ev = await toReactionEvent(client, target, emoji, userId);
      if (ev) await this.rules.handleEvent(ev);
    } catch (e) {
      console.error("rule engine error", e);
    }
  }
}
