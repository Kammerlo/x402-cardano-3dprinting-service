import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availablePlates } from "../../gateway/src/plates.ts";
test("batch discovery accepts only nonempty operator G-code files and supports sparse sizes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plates-"));
  try {
    for (const size of [1, 3, 6, 12])
      await writeFile(join(dir, `proof-token-${size}.gcode`), "G28\n");
    await writeFile(join(dir, "proof-token-2.gcode"), "");
    await writeFile(join(dir, "proof-token-0.gcode"), "G28");
    await writeFile(join(dir, "proof-token-1001.gcode"), "G28");
    await mkdir(join(dir, "proof-token-7.gcode"));
    await symlink(
      join(dir, "proof-token-1.gcode"),
      join(dir, "proof-token-9.gcode"),
    );
    assert.deepEqual(await availablePlates(dir), [1, 3, 6, 12]);
  } finally {
    await rm(dir, { recursive: true });
  }
});
