export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, "0")).join("");
}
export function constantEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let v = 0;
  for (let i = 0; i < a.length; i++) v |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return v === 0;
}
export async function secretMatches(value: string | undefined, expected: string | undefined) {
  return !!value && !!expected && expected.length >= 32 && constantEqual(await digest(value), await digest(expected));
}
export const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
export function clean(v: unknown, max: number): string { return typeof v === "string" ? v.trim().slice(0, max) : ""; }
