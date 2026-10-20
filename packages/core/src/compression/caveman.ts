/**
 * Caveman compressor: aggressive prompt slimming by removing low-signal tokens —
 * pleasantries, hedging, filler adverbs, redundant phrasing — while preserving
 * code blocks, quoted text, and URLs. Original implementation inspired by the
 * technique (not copied from any source).
 */

const CODE_FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]+`/g;
const URL_RE = /https?:\/\/[^\s)]+/g;

interface Preserved {
  text: string;
  blocks: string[];
}

function extractPreserved(text: string): Preserved {
  const blocks: string[] = [];
  const replacer = (m: string) => {
    blocks.push(m);
    return `\u0000${blocks.length - 1}\u0000`;
  };
  let out = text.replace(CODE_FENCE, replacer).replace(INLINE_CODE, replacer).replace(URL_RE, replacer);
  return { text: out, blocks };
}

function restore(text: string, blocks: string[]): string {
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)] ?? "");
}

// ordered longest-first so "thank you very much" beats "thank you"
const STRIP_PHRASES: string[] = [
  "thank you very much",
  "thanks in advance",
  "i would appreciate it if you could",
  "would you be able to",
  "is it possible for you to",
  "due to the fact that",
  "the reason is because",
  "it is important to note that",
  "please note that",
  "keep in mind that",
  "as you may know",
  "in order to",
  "i was wondering if",
  "would it be possible",
  "could you please",
  "would you please",
  "can you please",
  "please kindly",
  "it seems like",
  "it appears that",
  "i think that",
  "i believe that",
  "provide a detailed",
  "give me a comprehensive",
  "explain in detail",
  "thank you",
  "thanks",
  "please",
  "kindly",
  "sorry",
  "actually",
  "basically",
  "essentially",
  "literally",
  "simply",
  "just",
  "really",
  "very",
  "quite",
  "rather",
  "perhaps",
  "maybe",
  "probably",
];

const STRIP_WORDS = new Set([
  "hello",
  "hi",
  "hey",
  "dear",
  "sure",
  "certainly",
  "absolutely",
  "of",
  "course",
]);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface CavemanOptions {
  /** 0..1 — fraction of strip phrases to apply (1 = all). Default 1. */
  aggressiveness?: number;
}

export function cavemanCompress(input: string, opts: CavemanOptions = {}): string {
  const { text, blocks } = extractPreserved(input);
  const aggr = opts.aggressiveness ?? 1;

  let out = ` ${text} `;
  const n = Math.floor(STRIP_PHRASES.length * aggr);
  for (let i = 0; i < n; i++) {
    const phrase = STRIP_PHRASES[i]!;
    out = out.replace(new RegExp(`\\s${escapeRe(phrase)}(?=[\\s.,!?;:])`, "gi"), " ");
  }

  // drop standalone filler words at sentence starts
  out = out
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => {
      const words = sentence.split(/\s+/);
      const kept = words.filter((w, idx) => {
        if (idx > 2) return true;
        return !STRIP_WORDS.has(w.toLowerCase().replace(/[.,!?;:]+$/, ""));
      });
      return kept.join(" ");
    })
    .join(" ");

  out = out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return restore(out, blocks);
}
