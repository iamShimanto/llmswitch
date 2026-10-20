/** PII redaction for stored logs (inspector, audit). Regex-based, no deps. */

const PATTERNS: Array<{ name: string; re: RegExp; label: string }> = [
  { name: "email", re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/g, label: "[EMAIL]" },
  { name: "card", re: /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, label: "[CARD]" },
  { name: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g, label: "[SSN]" },
  {
    name: "api_key",
    re: /\b(sk-[A-Za-z0-9-_]{8,}|lsk_[A-Za-z0-9]{16,}|api[_-]?key\s*[:=]\s*["']?[\w-]{8,}["']?)/gi,
    label: "[API_KEY]",
  },
  {
    name: "phone",
    // conservative: +880 1XXX-XXXXXX / (555) 123-4567 style, 9+ digits with separators
    re: /(\+\d{1,3}[- ]?)?(\(\d{2,4}\)[- ]?)?\d{3,5}[- ]\d{4,}/g,
    label: "[PHONE]",
  },
];

export interface RedactResult {
  text: string;
  redactions: number;
  kinds: string[];
}

export function redactPii(input: string): RedactResult {
  let text = input;
  let redactions = 0;
  const kinds = new Set<string>();
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = p.re.exec(text)) !== null) {
      count++;
      if (count > 1000) break; // safety
    }
    if (count > 0) {
      p.re.lastIndex = 0;
      text = text.replace(p.re, p.label);
      redactions += count;
      kinds.add(p.name);
    }
  }
  return { text, redactions, kinds: [...kinds] };
}

/** Redaction enabled by default; set PII_REDACT=0 to store raw text. */
export function redactEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PII_REDACT !== "0";
}
