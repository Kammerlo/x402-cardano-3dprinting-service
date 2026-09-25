import { mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";

/** Durable replacement: never leave a partially written journal after a crash. */
export async function durableWrite(path: string, contents: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Serialize recurring async work, including when network calls exceed the interval. */
export async function repeat(task: () => Promise<void>, interval: number) {
  for (;;) {
    await task();
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
