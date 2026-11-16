import type { Client, Message, TextChannel } from "stoatx";
import type { RuleEvent } from "../engine/index.js";

/**
 * Turn a stoatx Message into the engine's RuleEvent. Returns null for DMs.
 * `content` lets `rule test` run a rule against sample text instead of the command message itself.
 */
export function toEvent(message: Message, overrides: { content?: string } = {}): RuleEvent | null {
  if (!message.serverId || !message.author) return null;
  const content = overrides.content ?? message.content ?? "";
  const roles = message.server?.roles.cache;
  return {
    type: "message.created",
    serverId: message.serverId,
    channelId: message.channelId,
    messageId: message.id,
    authorId: message.authorId,
    authorIsBot: !!message.author.bot,
    content,
    mentionedChannelIds: [...content.matchAll(/<#(\w+)>/g)].map((x) => x[1]),
    authorName: message.member?.nickname || message.author.displayName || message.author.username,
    authorAvatarUrl: message.member?.avatarURL ?? message.author.avatar?.url ?? undefined,
    attachments: (message.attachments ?? []).map((a) => ({ name: a.filename, url: a.url, size: a.size })),
    authorRoles: (message.member?.roleIds ?? []).map((id) => ({ id, name: roles?.get(id)?.name ?? id })),
    timestamp: Date.now(),
  };
}

/**
 * Build a "reaction.added" event: the reacted message is the event's message, and `reaction` says
 * who reacted and how many users have used that emoji. Returns null for DMs, bot reactors, and
 * messages that can't be fetched (e.g. deleted). Reactions by the bot itself don't count toward the total.
 */
export async function toReactionEvent(
  client: Client,
  target: Message | { id: string; channelId: string },
  emoji: string,
  userId: string,
): Promise<RuleEvent | null> {
  // Uncached messages arrive as just ids; fetching gets the current reactions, including this one.
  const message = "authorId" in target ? target : await fetchMessage(client, target.channelId, target.id);
  if (!message) return null;
  const base = toEvent(message);
  if (!base || base.authorIsBot) return null; // e.g. a starboard repost: never star the bot's own messages

  const member = await message.server?.members.fetch(userId).catch(() => undefined);
  const user = member?.user ?? (await client.users.fetch(userId).catch(() => undefined));
  if (!user || user.bot) return null;

  const roles = message.server?.roles.cache;
  const users = message.reactions?.[emoji] ?? [];
  return {
    ...base,
    type: "reaction.added",
    reaction: {
      emoji,
      // Count at least this reaction, in case the cached message hasn't caught up yet.
      count: Math.max(1, users.filter((id) => id !== client.user?.id).length),
      userId,
      userName: member?.nickname || user.displayName || user.username,
      userRoles: (member?.roleIds ?? []).map((id) => ({ id, name: roles?.get(id)?.name ?? id })),
    },
  };
}

async function fetchMessage(client: Client, channelId: string, messageId: string): Promise<Message | null> {
  try {
    const channel = (client.channels.cache.get(channelId) ?? (await client.channels.fetch(channelId))) as TextChannel;
    return await channel.messages.fetch(messageId);
  } catch {
    return null;
  }
}
