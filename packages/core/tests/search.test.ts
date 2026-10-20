import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { fetchPageText, isPrivateIp, mapSiteLinks, webSearch } from "../src/search/index.js";

describe("isPrivateIp", () => {
  it("flags private ranges", () => {
    for (const ip of ["10.0.0.1", "172.16.5.4", "172.31.255.1", "192.168.1.1", "127.0.0.1", "169.254.10.20", "0.0.0.0", "::1", "fc00::1", "fe80::1"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });
  it("allows public IPs", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "93.184.216.34"]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
});

describe("webSearch (mock upstream)", () => {
  let server: http.Server;
  let base: string;
  afterEach(() => {
    server?.close();
    delete process.env.TAVILY_BASE_URL;
    delete process.env.BRAVE_BASE_URL;
    delete process.env.SEARCH_API_KEY;
  });

  function mock(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
    server = http.createServer(handler);
    return new Promise<void>((r) => server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      r();
    }));
  }

  it("tavily shape normalized", async () => {
    await mock((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [{ title: "T", url: "https://x.y", content: "snippet here" }] }));
    });
    process.env.TAVILY_BASE_URL = base;
    process.env.SEARCH_API_KEY = "k";
    const out = await webSearch("hello", 5);
    expect(out.provider).toBe("tavily");
    expect(out.results[0]).toEqual({ title: "T", url: "https://x.y", snippet: "snippet here" });
  });

  it("brave shape normalized", async () => {
    await mock((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ web: { results: [{ title: "B", url: "https://a.b", description: "desc" }] } }));
    });
    process.env.BRAVE_BASE_URL = base;
    process.env.SEARCH_PROVIDER = "brave";
    process.env.SEARCH_API_KEY = "k";
    const out = await webSearch("hello", 5);
    expect(out.provider).toBe("brave");
    expect(out.results[0]!.snippet).toBe("desc");
    delete process.env.SEARCH_PROVIDER;
  });

  it("throws without SEARCH_API_KEY", async () => {
    await expect(webSearch("x")).rejects.toThrow(/SEARCH_API_KEY/);
  });
});

describe("fetchPageText + mapSiteLinks (local server)", () => {
  let server: http.Server;
  let base: string;
  const html = `<html><head><title>Hi</title></head><body><h1>Hello</h1><script>evil()</script><a href="/p2">two</a><a href="https://ext.com/x">ext</a></body></html>`;
  afterEach(() => server?.close());

  async function start() {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      r();
    }));
  }

  it("extracts title + text, strips scripts", async () => {
    await start();
    process.env.ALLOW_PRIVATE_FETCH = "1";
    const p = await fetchPageText(`${base}/`);
    expect(p.title).toBe("Hi");
    expect(p.text).toContain("Hello");
    expect(p.text).not.toContain("evil()");
    delete process.env.ALLOW_PRIVATE_FETCH;
  });

  it("SSRF guard blocks loopback without opt-in", async () => {
    await start();
    await expect(fetchPageText(`${base}/`)).rejects.toThrow(/private IP/);
  });

  it("rejects non-http(s)", async () => {
    await expect(fetchPageText("ftp://x.y/z")).rejects.toThrow(/only http/);
  });

  it("mapSiteLinks absolutizes hrefs", async () => {
    await start();
    process.env.ALLOW_PRIVATE_FETCH = "1";
    const m = await mapSiteLinks(`${base}/`);
    expect(m.links).toContain(`${base}/p2`);
    expect(m.links).toContain("https://ext.com/x");
    delete process.env.ALLOW_PRIVATE_FETCH;
  });
});
