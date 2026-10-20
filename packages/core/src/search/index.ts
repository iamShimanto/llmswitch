import { lookup } from "node:dns/promises";

/**
 * Web search + fetch utilities.
 * Search needs SEARCH_API_KEY (Tavily or Brave). Fetch has an SSRF guard.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  query: string;
  provider: string;
  results: SearchResult[];
}

async function tavilySearch(key: string, query: string, maxResults: number): Promise<SearchResponse> {
  const base = process.env.TAVILY_BASE_URL ?? "https://api.tavily.com";
  const res = await fetch(`${base}/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: key, query, max_results: maxResults, search_depth: "basic" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`tavily error ${res.status}`);
  const j = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return {
    query,
    provider: "tavily",
    results: (j.results ?? []).slice(0, maxResults).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.content ?? "",
    })),
  };
}

async function braveSearch(key: string, query: string, maxResults: number): Promise<SearchResponse> {
  const base = process.env.BRAVE_BASE_URL ?? "https://api.search.brave.com";
  const u = new URL(`${base}/res/v1/web/search`);
  u.searchParams.set("q", query);
  u.searchParams.set("count", String(Math.min(20, Math.max(1, maxResults))));
  const res = await fetch(u, {
    headers: { "X-Subscription-Token": key, accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`brave error ${res.status}`);
  const j = (await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
  return {
    query,
    provider: "brave",
    results: (j.web?.results ?? []).slice(0, maxResults).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.description ?? "",
    })),
  };
}

export async function webSearch(query: string, maxResults = 5): Promise<SearchResponse> {
  const key = (process.env.SEARCH_API_KEY ?? "").trim();
  if (!key) throw new Error("SEARCH_API_KEY is not set — web search is unavailable");
  const provider = (process.env.SEARCH_PROVIDER ?? "tavily").toLowerCase();
  if (provider === "brave") return braveSearch(key, query, maxResults);
  return tavilySearch(key, query, maxResults);
}

/** True for private/loopback/link-local IPs (SSRF guard). */
export function isPrivateIp(ip: string): boolean {
  if (ip === "::1" || ip === "::") return true;
  const low = ip.toLowerCase();
  if (low.startsWith("fc") || low.startsWith("fd")) return true; // unique-local
  if (low.startsWith("fe80")) return true; // link-local
  const parts = ip.split(".").map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
  }
  return false;
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
}

function htmlToText(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const noScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const text = noScripts
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return { title, text };
}

export async function fetchPageText(rawUrl: string, maxChars = 20000): Promise<FetchedPage> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("invalid url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("only http(s) urls are allowed");
  }
  if (process.env.ALLOW_PRIVATE_FETCH !== "1") {
    const { address } = await lookup(u.hostname);
    if (isPrivateIp(address)) {
      throw new Error("blocked: url resolves to a private IP (SSRF guard)");
    }
  }
  const res = await fetch(u, {
    headers: { "user-agent": "llmswitch/0.1 (+https://github.com/llmswitch)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const ct = res.headers.get("content-type") ?? "";
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 1024 * 1024) throw new Error("page too large (>1MB)");
  const body = buf.toString("utf8");
  if (!/html/i.test(ct)) {
    return { url: u.toString(), title: "", text: body.slice(0, maxChars) };
  }
  const { title, text } = htmlToText(body);
  return { url: u.toString(), title, text: text.slice(0, maxChars) };
}

export async function mapSiteLinks(rawUrl: string, limit = 50): Promise<{ url: string; links: string[] }> {
  const u = new URL(rawUrl);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) urls are allowed");
  if (process.env.ALLOW_PRIVATE_FETCH !== "1") {
    const { address } = await lookup(u.hostname);
    if (isPrivateIp(address)) throw new Error("blocked: url resolves to a private IP (SSRF guard)");
  }
  const res = await fetch(u, {
    headers: { "user-agent": "llmswitch/0.1" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const html = await res.text();
  const links = new Set<string>();
  const re = /<a[^>]+href=["']([^"'#]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && links.size < limit) {
    try {
      const abs = new URL(m[1], u);
      if (abs.protocol === "http:" || abs.protocol === "https:") links.add(abs.toString());
    } catch { /* skip bad hrefs */ }
  }
  return { url: u.toString(), links: [...links] };
}
