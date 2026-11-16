import { AttachmentBuilder } from "stoatx";
import type { FileRef } from "../engine/index.js";

/** Stoat allows up to 5 attachments per message. */
export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

export type DownloadOptions = {
  maxBytes?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch; // for tests
  allowInsecure?: boolean; // tests only: permit http://
};

/**
 * Download files so they can be uploaded again as new attachments (Stoat does not let a message
 * reuse another message's uploads). Never throws for a bad file: that file is returned in `skipped`
 * with a reason, so the rest of the submission still goes through.
 */
export async function downloadFiles(
  files: FileRef[],
  opts: DownloadOptions = {},
): Promise<{ builders: AttachmentBuilder[]; skipped: string[] }> {
  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES;
  const doFetch = opts.fetchFn ?? fetch;
  const builders: AttachmentBuilder[] = [];
  const skipped: string[] = [];

  for (const [i, file] of files.entries()) {
    if (i >= MAX_FILES) {
      skipped.push(`${file.name} (more than ${MAX_FILES} files)`);
      continue;
    }
    if (file.size > maxBytes) {
      skipped.push(`${file.name} (too large)`);
      continue;
    }
    try {
      const url = new URL(file.url);
      if (url.protocol !== "https:" && !opts.allowInsecure) throw new Error("not https");
      const res = await doFetch(url, { redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > maxBytes) throw new Error("too large");
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > maxBytes) throw new Error("too large");
      builders.push(new AttachmentBuilder(data, file.name));
    } catch (e) {
      skipped.push(`${file.name} (${(e as Error).message})`);
    }
  }
  return { builders, skipped };
}
