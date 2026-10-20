/**
 * Built-in `auto/*` routing catalog (OmniRoute-style).
 *
 * Zero-setup virtual combos: each template id (e.g. `auto/best-coding`)
 * resolves dynamically from the CONNECTED providers — models are scored
 * by capability patterns and cost tier, and the top matches become a
 * weighted combo with the template's system prompt. Template ids follow
 * OmniRoute's advertised catalog (see LICENSE attribution).
 */
import type { ResolvedProvider } from "../providers/types.js";
import type { ComboTarget } from "./index.js";

export type AutoCategory = "coding" | "reasoning" | "fast" | "vision" | "chat";
export type AutoTier = "free" | "balanced" | "premium";

export interface AutoTemplate {
  id: string;
  title: string;
  tags: string[];
  systemPrompt: string;
  category: AutoCategory;
  tier: AutoTier;
}

const P = {
  coding:
    "You are an expert coding assistant. Write clean, efficient, well-documented code.",
  reasoning:
    "You are a deep reasoning assistant. Think carefully step by step before answering.",
  fast: "You are a fast, concise assistant. Answer directly and briefly.",
  vision:
    "You are a vision-capable assistant. Describe and analyze images carefully and precisely.",
  chat: "You are a helpful, friendly assistant. Answer clearly and naturally.",
  free: "You are a helpful assistant. Be accurate and concise.",
  pro: "You are a top-tier expert assistant. Give thorough, high-quality answers.",
};

export const AUTO_TEMPLATES: AutoTemplate[] = [
  { id: "auto/best-coding", title: "Best Coding", tags: ["coding", "premium", "balanced"], systemPrompt: P.coding, category: "coding", tier: "premium" },
  { id: "auto/best-reasoning", title: "Best Reasoning", tags: ["reasoning_deep", "reasoning", "premium"], systemPrompt: P.reasoning, category: "reasoning", tier: "premium" },
  { id: "auto/best-fast", title: "Best Fast", tags: ["fast", "balanced"], systemPrompt: P.fast, category: "fast", tier: "balanced" },
  { id: "auto/best-vision", title: "Best Vision", tags: ["vision", "premium", "balanced"], systemPrompt: P.vision, category: "vision", tier: "premium" },
  { id: "auto/best-chat", title: "Best Chat", tags: ["chat", "balanced", "premium"], systemPrompt: P.chat, category: "chat", tier: "balanced" },
  { id: "auto/best-free", title: "Best Free", tags: ["free", "chat"], systemPrompt: P.free, category: "chat", tier: "free" },
  { id: "auto/pro-coding", title: "Pro Coding", tags: ["coding", "pro"], systemPrompt: P.coding, category: "coding", tier: "premium" },
  { id: "auto/pro-reasoning", title: "Pro Reasoning", tags: ["reasoning", "pro"], systemPrompt: P.reasoning, category: "reasoning", tier: "premium" },
  { id: "auto/pro-vision", title: "Pro Vision", tags: ["vision", "pro"], systemPrompt: P.vision, category: "vision", tier: "premium" },
  { id: "auto/pro-chat", title: "Pro Chat", tags: ["chat", "pro"], systemPrompt: P.pro, category: "chat", tier: "premium" },
  { id: "auto/pro-fast", title: "Pro Fast", tags: ["fast", "pro"], systemPrompt: P.fast, category: "fast", tier: "premium" },
  { id: "auto/coding", title: "Coding", tags: ["coding"], systemPrompt: P.coding, category: "coding", tier: "balanced" },
  { id: "auto/fast", title: "Fast", tags: ["fast"], systemPrompt: P.fast, category: "fast", tier: "balanced" },
  { id: "auto/chat", title: "Chat", tags: ["chat"], systemPrompt: P.chat, category: "chat", tier: "balanced" },
  { id: "auto/cheap", title: "Cheap", tags: ["cheap", "chat"], systemPrompt: P.free, category: "chat", tier: "free" },
  { id: "auto/smart", title: "Smart", tags: ["reasoning", "smart"], systemPrompt: P.reasoning, category: "reasoning", tier: "balanced" },
  { id: "auto/subscription", title: "Subscription", tags: ["subscription", "chat"], systemPrompt: P.chat, category: "chat", tier: "balanced" },
];

export function autoTemplate(id: string): AutoTemplate | undefined {
  return AUTO_TEMPLATES.find((t) => t.id === id);
}

const RE = {
  coding: /cod(er|ex|ing)?\b|code-|dev(stral)?|swe|program/i,
  reasoning: /thinking|reason|o1|o3|o4|r1\b|deepseek-r|qwq|think/i,
  fast: /flash|haiku|lite|mini|small|fast|nano|8b|7b|instant|turbo/i,
  vision: /vision|\bvl\b|gpt-4o|gpt-5|gemini|claude|llama-4|qwen.*vl/i,
  flagship: /opus|ultra|max\b|pro\b|gpt-5|o3|405b|70b|large|frontier/i,
  weak: /embed|rerank|whisper|tts|stt|audio|image|moderation/i,
};

export interface ModelCaps {
  coding: boolean;
  reasoning: boolean;
  fast: boolean;
  vision: boolean;
}

export function classifyModel(model: string): ModelCaps {
  return {
    coding: RE.coding.test(model),
    reasoning: RE.reasoning.test(model),
    fast: RE.fast.test(model),
    vision: RE.vision.test(model),
  };
}

/**
 * Score and pick the top targets for a template from connected
 * providers. Subscription templates prefer OAuth/subscription
 * providers (authType oauth) over pay-per-token API providers.
 */
export function buildAutoTargets(
  template: AutoTemplate,
  providers: ResolvedProvider[],
  limit = 6,
): ComboTarget[] {
  /** Score one model for a category; null = not eligible for it. */
  const scoreFor = (p: ResolvedProvider, m: string, category: AutoCategory): number | null => {
    if (RE.weak.test(m)) return null;
    const caps = classifyModel(m);
    let score = 0;
    // category fit (chat accepts everything)
    if (category === "coding") {
      if (!caps.coding) return null;
      score += 6;
    } else if (category === "reasoning") {
      if (!caps.reasoning) return null;
      score += 6;
    } else if (category === "vision") {
      if (!caps.vision) return null;
      score += 6;
    } else if (category === "fast") {
      score += caps.fast ? 6 : 2;
    } else {
      score += 3;
      if (caps.coding) score += 1;
      if (caps.reasoning) score += 1;
    }
    // tier fit (costTier: 1 cheapest … 5 premium)
    const tier = p.costTier ?? 3;
    if (template.tier === "free") {
      if (tier > 2 && p.authType !== "none") return null;
      score += 6 - tier;
      if (m.includes(":free") || m.includes("free")) score += 2;
    } else if (template.tier === "premium") {
      score += tier;
      if (RE.flagship.test(m)) score += 3;
    } else {
      score += 3 - Math.abs(tier - 3);
    }
    if (template.id === "auto/subscription") {
      if (p.authType === "oauth" || p.authType === "cookie") score += 5;
      else score -= 2;
    }
    if (m === p.defaultModel) score += 1;
    return score;
  };

  const primary: Array<{ model: string; weight: number }> = [];
  for (const p of providers) {
    for (const m of p.models) {
      const s = scoreFor(p, m, template.category);
      if (s !== null) primary.push({ model: `${p.id}:${m}`, weight: Math.max(1, Math.round(s)) });
    }
  }
  primary.sort((a, b) => b.weight - a.weight);

  // Category backfill (coding/reasoning): when too few specialist-named
  // models are connected, strong GENERAL models fill the remaining slots
  // at demoted weight — frontier chat models (Claude, Gemini, GPT) are
  // genuinely excellent at coding and reasoning even though their names
  // carry no "coder"/"thinking" marker. Without this, auto/best-coding
  // was 0/6 live: every name-matched candidate sat behind one provider's
  // sign-in wall while the user's best models were never candidates.
  let scored = primary;
  let backfillAdded = 0;
  if (template.category === "coding" || template.category === "reasoning") {
    const have = new Set(primary.map((t) => t.model));
    const backfill: Array<{ model: string; weight: number }> = [];
    for (const p of providers) {
      for (const m of p.models) {
        const key = `${p.id}:${m}`;
        if (have.has(key)) continue;
        const s = scoreFor(p, m, "chat");
        if (s !== null) {
          backfill.push({ model: key, weight: Math.max(1, Math.round(s * 0.8)) });
        }
      }
    }
    backfill.sort((a, b) => b.weight - a.weight);
    backfillAdded = backfill.length;
    scored = [...primary, ...backfill];
  }
  // When backfill candidates exist, the list may run up to 3 past the
  // usual limit: the specialists keep priority, and the general models
  // are extra fallbacks for when every specialist is walled/dead
  // (exactly the live failure: 6/6 name-matched candidates unusable).
  const pickLimit = limit + Math.min(3, backfillAdded);
  // Provider diversity: cap any single provider at 3 of the slots. A
  // monoculture candidate list collapses when that one provider has a
  // bad day (observed live: Kilo's catalog filled all 6 slots of
  // auto/best-fast, and when Kilo started demanding sign-in for most
  // models the combo looked dead even though other providers were fine).
  const providerOf = (model: string) => model.slice(0, model.indexOf(":"));
  const counts = new Map<string, number>();
  const picked: typeof scored = [];
  for (const t of scored) {
    if (picked.length >= pickLimit) break;
    const pid = providerOf(t.model);
    const n = counts.get(pid) ?? 0;
    if (n >= 3) continue;
    counts.set(pid, n + 1);
    picked.push(t);
  }
  if (picked.length < pickLimit) {
    for (const t of scored) {
      if (picked.length >= pickLimit) break;
      if (!picked.includes(t)) picked.push(t);
    }
  }
  return picked;
}
