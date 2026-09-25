import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";

/** Only operator-provided, nonempty regular files can authorize a batch size. */
export async function availablePlates(directory: string): Promise<number[]> {
  const names = await readdir(directory).catch(() => [] as string[]);
  const sizes: number[] = [];
  for (const name of names) {
    const match = /^proof-token-([1-9][0-9]{0,3})\.gcode$/.exec(name);
    if (!match || Number(match[1]) > 1000) continue;
    const stat = await lstat(join(directory, name)).catch(() => null);
    if (stat?.isFile() && stat.size > 0) sizes.push(Number(match[1]));
  }
  return sizes.sort((a, b) => a - b);
}
