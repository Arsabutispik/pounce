import { z } from "zod";

const UNICODE_EMOJI = new RegExp("^\\p{RGI_Emoji}$", "v");
const CUSTOM_EMOJI = /^:?([0-9A-HJKMNP-TV-Z]{26}):?$/i; // Stoat custom emoji ids are ULIDs

/** A unicode emoji ("🎉") or a custom emoji id ("01J..." or ":01J...:"), stored as the bare uppercase id. */
export const emojiSchema = z
  .string()
  .trim()
  .refine((e) => UNICODE_EMOJI.test(e) || CUSTOM_EMOJI.test(e), {
    message: "Emoji must be a single unicode emoji (like 🎉) or a custom emoji id",
  })
  .transform((e) => e.match(CUSTOM_EMOJI)?.[1].toUpperCase() ?? e);

/** Compare emoji as the platform sends them: ids ignore case, and "⭐️" equals "⭐" (variation selector). */
export function sameEmoji(a: string, b: string): boolean {
  const norm = (e: string) => e.replace(/\uFE0F/g, "").toUpperCase();
  return norm(a) === norm(b);
}

/** How to show an emoji in chat: custom ids as :id: (renders as the emoji), unicode as is. */
export const showEmoji = (e: string) => (CUSTOM_EMOJI.test(e) ? `:${e}:` : e);
