/**
 * Skills system — reusable system-prompt packs.
 *
 * A skill is a named system prompt (+ optional model override) that can be
 * executed against any input through the router:
 *   POST /v1/skills/:name/run { "input": "..." }
 *
 * Sources:
 *  - builtins (summarize, translate-bn, code-review)
 *  - files: ~/.llmswitch/skills/*.md (LLMSWITCH_SKILLS_DIR override),
 *    frontmatter: name, description, model (optional), then markdown body
 *    as the system prompt. API-created skills are also saved here as files.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Router } from "../router/index.js";
import type { ChatCompletionRequest } from "../providers/types.js";
import { costUsd } from "../billing/prices.js";

export interface Skill {
  name: string;
  description: string;
  instructions: string;
  model?: string;
  source: "builtin" | "file";
  createdAt: number;
}

export function skillsDir(): string {
  const dir = process.env.LLMSWITCH_SKILLS_DIR ?? join(homedir(), ".llmswitch", "skills");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Minimal frontmatter parser: ---\nkey: value\n---\nbody */
export function parseSkillMarkdown(md: string, fallbackName: string): Skill {
  let name = fallbackName;
  let description = "";
  let model: string | undefined;
  let body = md;
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
      if (!kv) continue;
      const k = kv[1].toLowerCase();
      const v = kv[2].trim();
      if (k === "name") name = v;
      else if (k === "description") description = v;
      else if (k === "model") model = v;
    }
    body = m[2];
  }
  return {
    name: name.trim() || fallbackName,
    description: description.trim(),
    instructions: body.trim(),
    model,
    source: "file",
    createdAt: Date.now(),
  };
}

const BUILTINS: Array<Omit<Skill, "source" | "createdAt">> = [
  {
    name: "summarize",
    description: "Concise summary of any text (3-5 bullet points).",
    instructions:
      "You are a precise summarizer. Summarize the user's text in 3-5 concise bullet points. " +
      "Capture the key facts and conclusions. No preamble, no fluff.",
  },
  {
    name: "translate-bn",
    description: "Translate English text to natural Bangla.",
    instructions:
      "You are an expert English-to-Bangla translator. Translate the user's text into natural, " +
      "fluent Bangla (Bangladesh standard). Preserve meaning, tone, and formatting. " +
      "Output only the translation.",
  },
  {
    name: "code-review",
    description: "Senior-engineer code review of a diff or snippet.",
    instructions:
      "You are a senior staff engineer doing code review. Review the user's code/diff for: " +
      "correctness bugs, security issues, performance problems, and readability. " +
      "Be specific with file/line references when possible. List findings as bullets " +
      "ordered by severity, then end with a one-line verdict (approve / request changes).",
  },
];

export interface SkillRunResult {
  skill: string;
  output: string;
  providerId: string;
  model: string;
  latencyMs: number;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  costUsd: number;
}

export class SkillRegistry {
  private skills = new Map<string, Skill>();

  constructor(private dir: string = skillsDir()) {
    for (const b of BUILTINS) {
      this.skills.set(b.name, { ...b, source: "builtin", createdAt: 0 });
    }
    this.loadFiles();
  }

  private loadFiles(): void {
    if (!existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const md = readFileSync(join(this.dir, f), "utf8");
        const s = parseSkillMarkdown(md, f.slice(0, -3));
        if (s.instructions) this.skills.set(s.name, s);
      } catch {
        /* skip unreadable files */
      }
    }
  }

  list(): Skill[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /** Create/update a skill (persisted as a .md file). Builtins can't be overwritten. */
  save(input: { name: string; description?: string; instructions: string; model?: string }): Skill {
    const name = input.name.trim();
    if (!/^[a-z0-9][a-z0-9-_]{1,63}$/.test(name)) {
      throw new Error("invalid skill name (lowercase letters, digits, - and _)");
    }
    if (this.skills.get(name)?.source === "builtin") {
      throw new Error(`"${name}" is a built-in skill and cannot be overwritten`);
    }
    if (!input.instructions.trim()) throw new Error("instructions are required");
    const skill: Skill = {
      name,
      description: (input.description ?? "").trim(),
      instructions: input.instructions.trim(),
      model: input.model?.trim() || undefined,
      source: "file",
      createdAt: Date.now(),
    };
    const front = ["---", `name: ${name}`];
    if (skill.description) front.push(`description: ${skill.description}`);
    if (skill.model) front.push(`model: ${skill.model}`);
    front.push("---", "");
    writeFileSync(join(this.dir, `${name}.md`), front.join("\n") + skill.instructions + "\n");
    this.skills.set(name, skill);
    return skill;
  }

  delete(name: string): boolean {
    const s = this.skills.get(name);
    if (!s || s.source === "builtin") return false;
    try {
      unlinkSync(join(this.dir, `${name}.md`));
    } catch {
      /* already gone */
    }
    return this.skills.delete(name);
  }

  /** Execute a skill: system prompt + user input through the router. */
  async run(skill: Skill, input: string, router: Router, modelOverride?: string): Promise<SkillRunResult> {
    const body: ChatCompletionRequest = {
      model: modelOverride?.trim() || skill.model || "auto",
      messages: [
        { role: "system", content: skill.instructions },
        { role: "user", content: input },
      ],
    };
    const r = await router.route(body);
    const choice = r.response?.choices?.[0]?.message?.content ?? "";
    const usage = r.response?.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    return {
      skill: skill.name,
      output: choice,
      providerId: r.providerId,
      model: r.model,
      latencyMs: r.latencyMs,
      usage,
      costUsd: costUsd(r.providerId, r.model, usage.prompt_tokens, usage.completion_tokens),
    };
  }
}
