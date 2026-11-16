import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { downloadFiles, MAX_FILES } from "../bot/files.js";

/* Tests the file copier against a throwaway local HTTP server (no Stoat, no Docker). */

const server = createServer((req, res) => {
  if (req.url === "/ok") return void res.end("hello");
  if (req.url === "/big") return void res.end(Buffer.alloc(3000));
  if (req.url === "/redirect") return void res.writeHead(302, { location: "/ok" }).end();
  res.writeHead(404).end("nope");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const f = (path: string, name = path.slice(1), size = 10) => ({ name, url: `${base}${path}`, size });
const opts = { allowInsecure: true, maxBytes: 1000 };

try {
  let r = await downloadFiles([f("/ok", "a.txt")], opts);
  assert.equal(r.builders.length, 1);
  assert.equal(r.builders[0].filename, "a.txt");
  assert.equal(Buffer.from(r.builders[0].file as Buffer).toString(), "hello", "content copied");
  assert.deepEqual(r.skipped, []);

  r = await downloadFiles([f("/ok", "small.txt", 5000)], opts);
  assert.deepEqual([r.builders.length, r.skipped], [0, ["small.txt (too large)"]], "declared size too large");

  r = await downloadFiles([f("/big", "big.bin", 10)], opts);
  assert.equal(r.builders.length, 0, "actual size too large even if metadata lied");
  assert.match(r.skipped[0], /big\.bin \(too large\)/);

  r = await downloadFiles([f("/missing", "gone.txt")], opts);
  assert.match(r.skipped[0], /gone\.txt \(HTTP 404\)/, "http errors skipped");

  r = await downloadFiles([f("/redirect", "r.txt")], opts);
  assert.equal(r.builders.length, 0, "redirects are refused");

  r = await downloadFiles([f("/ok", "plain.txt")], { maxBytes: 1000 });
  assert.match(r.skipped[0], /plain\.txt \(not https\)/, "http:// refused by default");

  r = await downloadFiles([f("/ok", "good.txt"), f("/missing", "bad.txt")], opts);
  assert.deepEqual([r.builders.length, r.skipped.length], [1, 1], "one bad file does not stop the rest");

  r = await downloadFiles(Array.from({ length: MAX_FILES + 2 }, (_, i) => f("/ok", `f${i}.txt`)), opts);
  assert.equal(r.builders.length, MAX_FILES, "at most MAX_FILES copied");
  assert.equal(r.skipped.length, 2);

  console.log("file tests passed");
} finally {
  server.close();
}
