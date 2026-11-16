/* ---------- Data model (this is what the website + text parser both produce) ---------- */

export type Block = {
  type: string;
  params: Record<string, unknown>;
  not?: boolean; // negate a condition without needing a separate block
};

export const MAX_RULE_NAME = 60;

/** Longest allowed cooldown (7 days). */
export const MAX_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Triggers whose events are about a message (content, author, attachments are filled in).
 * Message blocks list these in `triggers`, so they work on new messages and on reacted-to messages.
 */
export const MESSAGE_TRIGGERS = ["message.created", "reaction.added"];

export type Rule = {
  id: string;
  /** Human-readable label shown in lists and on the website. Unique per server (case-insensitive). */
  name: string;
  schemaVersion: 1;
  serverId: string;
  enabled: boolean;
  trigger: Block; // { type: "message.created", params: {} }
  conditions: Block[]; // all must pass
  actions: Block[]; // run in order
  /** After the rule runs, it won't run again for this long. */
  cooldownMs?: number;
  /** Cooldown counts separately for each author, instead of once for the whole rule. */
  cooldownPerUser?: boolean;
  /**
   * The text the rule was written in, without its name (`when ... do ...`), so `rule show` can offer it
   * for editing. Informational only: the blocks above are what runs. Anything that changes the blocks
   * without going through the text parser must drop it (import checks it still matches).
   */
  source?: string;
};

/** A file attached to a message, as the platform describes it. */
export type FileRef = { name: string; url: string; size: number };

/**
 * What a block sees. Message fields are empty ("" / [] / 0) for events that are not about a message,
 * e.g. scheduled ones. Blocks that need a message declare `triggers: MESSAGE_TRIGGERS`.
 * On "reaction.added" the message fields describe the message that was reacted to, and `reaction` says who reacted.
 */
export interface RuleEvent {
  type: string; // "message.created" | "reaction.added" | "schedule"
  serverId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  authorIsBot: boolean;
  content: string;
  mentionedChannelIds: string[];
  authorName: string; // display name: server nickname, else display name, else username
  authorAvatarUrl?: string; // server avatar, else profile avatar
  attachments: FileRef[];
  authorRoles: { id: string; name: string }[]; // roles the author has in this server
  timestamp: number; // epoch ms, used by time conditions
  reaction?: ReactionInfo; // only on "reaction.added"
}

export interface ReactionInfo {
  emoji: string; // unicode emoji, or a custom emoji id
  count: number; // how many users have reacted with this emoji now, including this one
  userId: string; // who reacted
  userName: string;
  userRoles: { id: string; name: string }[];
}

export interface SendOptions {
  replyTo?: string; // message id to reply to
  masquerade?: { name: string; avatarUrl?: string }; // show the message as coming from this name/avatar
  files?: FileRef[]; // files to copy into the new message
}

/** Where a message the bot posted ended up. */
export type SentMessage = { channelId: string; messageId: string };

/**
 * State for one run of one rule, shared by its actions in order. Created fresh by the engine
 * for every run, so nothing leaks between runs or rules.
 */
export interface RunState {
  /** The most recent message this run posted with `message.send`. */
  sent?: SentMessage;
}

/**
 * Durable memory for the engine, so a restart doesn't forget what it promised.
 * - `claim`: "once per message" triggers. Records that a rule fired on a message and returns false if it
 *   already had. Must be atomic, so two reactions arriving together can't both win.
 * - `saveCooldown`: a cooldown just started (scope "" = whole rule, or the user id for "per user").
 *   Saved ones come back through `RuleEngine.restoreCooldowns` at startup.
 */
export interface RuleMemory {
  claim(ruleId: string, messageId: string): Promise<boolean>;
  saveCooldown?(ruleId: string, scope: string, until: number): Promise<void>;
}

/** Everything the engine needs from the outside world. Implement once per platform. */
export interface Env {
  /** Post a message and say where it landed (so later actions can react to it, etc.). */
  send(channelId: string, text: string, opts?: SendOptions): Promise<SentMessage>;
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  /** Which server a channel belongs to; undefined for DMs and unknown channels. Rules may only act in their own server. */
  channelServerId(channelId: string): Promise<string | undefined>;
  log(msg: string): void;
}
