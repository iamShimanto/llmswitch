import { type Request, type Response, type Express } from "express";
import { z } from "zod";
import { MitmProxy } from "./index.js";
import type { Inspector } from "../inspect/index.js";
import type { ResolvedProvider } from "../providers/types.js";
import type { Store } from "../store/db.js";

/**
 * MITM debugging-proxy management routes.
 * All under /api/* so the existing createAuth middleware admin-gates them
 * whenever ADMIN_KEY is set. The proxy itself only binds 127.0.0.1.
 */

const StartBody = z.object({
  provider: z.string().min(1),
  port: z.number().int().min(0).max(65535), // 0 = random free port
});

export interface MitmRouteDeps {
  providers: ResolvedProvider[];
  inspector: Inspector;
  store: Store;
}

export function registerMitmRoutes(app: Express, deps: MitmRouteDeps): void {
  const { providers, inspector, store } = deps;
  const mitm = new MitmProxy(inspector);

  app.post("/api/mitm/start", async (req: Request, res: Response) => {
    const parsed = StartBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.message, type: "bad_request" } });
      return;
    }
    const p = providers.find((x) => x.id === parsed.data.provider);
    if (!p) {
      res.status(404).json({
        error: { message: `provider not connected: ${parsed.data.provider}`, type: "not_found" },
      });
      return;
    }
    try {
      const info = await mitm.start(p, parsed.data.port);
      store.audit("mitm.start", p.id, `port=${parsed.data.port}`);
      res.json({ ...info, url: `http://127.0.0.1:${info.port}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: { message, type: "bad_request" } });
    }
  });

  app.get("/api/mitm/sessions", (_req: Request, res: Response) => {
    res.json({ sessions: mitm.list() });
  });

  app.post("/api/mitm/stop/:id", (req: Request, res: Response) => {
    const ok = mitm.stop(req.params.id);
    if (!ok) {
      res.status(404).json({ error: { message: "session not found", type: "not_found" } });
      return;
    }
    store.audit("mitm.stop", req.params.id, "");
    res.json({ stopped: true });
  });

  app.get("/api/mitm/:id/log", (req: Request, res: Response) => {
    const log = mitm.getLog(req.params.id);
    if (!log) {
      res.status(404).json({ error: { message: "session not found", type: "not_found" } });
      return;
    }
    res.json({ entries: log });
  });
}
