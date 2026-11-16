// Inside a quoted string only \" and \\ are escapes, so regex text like \b or \d survives untouched.
export type Token = { kind: "str" | "chan" | "user" | "word"; v: string };

export function tokenize(src: string): Token[] {
  const re = /"((?:[^"\\]|\\.)*)"|<#(\w+)>|<@!?(\w+)>|(\S+)/g;
  const out: Token[] = [];
  for (const m of src.matchAll(re)) {
    if (m[1] !== undefined) out.push({ kind: "str", v: m[1].replace(/\\(["\\])/g, "$1") });
    else if (m[2] !== undefined) out.push({ kind: "chan", v: m[2] });
    else if (m[3] !== undefined) out.push({ kind: "user", v: m[3] });
    else out.push({ kind: "word", v: m[4] });
  }
  return out;
}

export const isWord = (t: Token | undefined, w: string) => t?.kind === "word" && t.v.toLowerCase() === w;

/** Tokens back to rule text: the inverse of tokenize (quotes and escapes restored). */
export function renderTokens(tokens: Token[]): string {
  return tokens
    .map((t) =>
      t.kind === "str" ? `"${t.v.replace(/[\\"]/g, "\\$&")}"` : t.kind === "chan" ? `<#${t.v}>` : t.kind === "user" ? `<@${t.v}>` : t.v,
    )
    .join(" ");
}
