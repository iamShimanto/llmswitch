/**
 * RTK (redundancy-trimming kernel) compressor: structural slimming —
 * dedupe repeated lines/paragraphs, collapse whitespace, trim quoted
 * context that adds no new information.
 */

export function rtkCompress(input: string): string {
  // 1. collapse horizontal whitespace, normalize newlines
  let out = input.replace(/[ \t]+/g, " ").replace(/\r\n/g, "\n");

  // 2. drop exact-duplicate non-empty lines (keep first occurrence)
  const seen = new Set<string>();
  const lines = out.split("\n");
  const deduped: string[] = [];
  for (const line of lines) {
    const key = line.trim();
    if (key.length > 0 && seen.has(key)) continue;
    if (key.length > 0) seen.add(key);
    deduped.push(line);
  }
  out = deduped.join("\n");

  // 3. collapse 3+ newlines to 2
  out = out.replace(/\n{3,}/g, "\n\n");

  // 4. trim trailing whitespace per line
  out = out
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();

  return out;
}
