export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Best-effort guard for user-supplied regular expressions. Node has no regex timeout, so one
 * catastrophic pattern could freeze the whole bot. This rejects the usual culprits (nested
 * quantifiers, quantified alternation, back-references) and long patterns. It is not a proof of
 * safety: for untrusted users at scale, switch to a linear-time engine such as RE2.
 * Returns an error message, or undefined if the pattern is acceptable.
 */
export function regexProblem(pattern: string): string | undefined {
  if (pattern.length > 100) return "Pattern is too long (max 100 characters)";
  if (/\\[1-9]|\\k</.test(pattern)) return "Back-references are not allowed";
  if (/\([^)]*[+*}][^)]*\)[+*{]/.test(pattern)) return "Pattern is too complex (nested repetition)";
  if (/\([^)]*\|[^)]*\)[+*{]/.test(pattern)) return "Pattern is too complex (repeated alternation)";
  try {
    new RegExp(pattern, "i");
  } catch (e) {
    return `Invalid pattern: ${(e as Error).message}`;
  }
  return undefined;
}
