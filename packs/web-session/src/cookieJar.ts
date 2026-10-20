/** Minimal cookie jar for web-session packs. */

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number | null; // unix ms, null = session
}

export class CookieJar {
  private cookies: Cookie[] = [];

  /** Load cookies from a Netscape cookie file or a raw Cookie header value. */
  load(text: string, defaultDomain: string): void {
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      if (t.includes("\t")) {
        // Netscape format: domain, flag, path, secure, expiry, name, value
        const parts = t.split("\t");
        if (parts.length >= 7) {
          this.set({
            name: parts[5]!,
            value: parts[6]!,
            domain: parts[0]!.replace(/^\./, ""),
            path: parts[2]!,
            expires: parts[4] === "0" ? null : Number(parts[4]) * 1000,
          });
        }
      } else {
        // raw "a=1; b=2" header
        for (const pair of t.split(";")) {
          const [n, ...rest] = pair.trim().split("=");
          if (n) this.set({ name: n.trim(), value: rest.join("=").trim(), domain: defaultDomain, path: "/", expires: null });
        }
      }
    }
  }

  set(c: Cookie): void {
    this.cookies = this.cookies.filter(
      (x) => !(x.name === c.name && x.domain === c.domain && x.path === c.path),
    );
    this.cookies.push(c);
  }

  /** Cookie header value for a URL, dropping expired cookies. */
  headerFor(url: string, now = Date.now()): string {
    const u = new URL(url);
    const host = u.hostname.replace(/^\./, "");
    const valid = this.cookies.filter(
      (c) =>
        (c.expires == null || c.expires > now) &&
        (host === c.domain || host.endsWith(`.${c.domain}`)) &&
        u.pathname.startsWith(c.path),
    );
    return valid.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  /** Ingest Set-Cookie response headers. */
  ingest(setCookies: string[], fromUrl: string): void {
    const host = new URL(fromUrl).hostname;
    for (const sc of setCookies) {
      const [pair, ...attrs] = sc.split(";");
      const [n, ...rest] = (pair ?? "").split("=");
      if (!n?.trim()) continue;
      const c: Cookie = { name: n.trim(), value: rest.join("=").trim(), domain: host, path: "/", expires: null };
      for (const a of attrs) {
        const [k, v] = a.trim().split("=");
        const kl = (k ?? "").toLowerCase();
        if (kl === "domain" && v) c.domain = v.trim().replace(/^\./, "");
        if (kl === "path" && v) c.path = v.trim();
        if (kl === "max-age" && v) c.expires = Date.now() + Number(v) * 1000;
        if (kl === "expires" && v) c.expires = Date.parse(v);
      }
      this.set(c);
    }
  }

  size(): number {
    return this.cookies.length;
  }
}
