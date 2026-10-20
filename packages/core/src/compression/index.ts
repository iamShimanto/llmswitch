import { cavemanCompress } from "./caveman.js";
import { rtkCompress } from "./rtk.js";

export type CompressionMode = "caveman" | "rtk" | "stacked";

export interface CompressionStats {
  mode: CompressionMode;
  charsBefore: number;
  charsAfter: number;
  savedChars: number;
  savedPct: number;
  /** rough token estimate (~4 chars/token for English) */
  estTokensBefore: number;
  estTokensAfter: number;
}

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export function compressText(input: string, mode: CompressionMode): { text: string; stats: CompressionStats } {
  let text = input;
  if (mode === "caveman" || mode === "stacked") text = cavemanCompress(text);
  if (mode === "rtk" || mode === "stacked") text = rtkCompress(text);

  const charsBefore = input.length;
  const charsAfter = text.length;
  const savedChars = Math.max(0, charsBefore - charsAfter);
  return {
    text,
    stats: {
      mode,
      charsBefore,
      charsAfter,
      savedChars,
      savedPct: charsBefore === 0 ? 0 : Math.round((savedChars / charsBefore) * 1000) / 10,
      estTokensBefore: estimateTokens(charsBefore),
      estTokensAfter: estimateTokens(charsAfter),
    },
  };
}

export function isCompressionMode(v: unknown): v is CompressionMode {
  return v === "caveman" || v === "rtk" || v === "stacked";
}
