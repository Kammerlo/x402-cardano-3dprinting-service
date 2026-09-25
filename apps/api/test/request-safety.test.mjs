import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.ts";
import { durableWrite } from "../../gateway/src/journal.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("rejects oversized JSON before opening a database connection", async () => {
  const response = await app.request(
    "http://localhost/api/orders",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(17000) }),
    },
    {},
  );
  assert.equal(response.status, 413);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});
test("journal replacement preserves a complete recovery record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "print-journal-"));
  try {
    const path = join(dir, "batch.json");
    await durableWrite(path, JSON.stringify({ stage: "reserved" }));
    await durableWrite(path, JSON.stringify({ stage: "started" }));
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      stage: "started",
    });
  } finally {
    await rm(dir, { recursive: true });
  }
});
