import { z } from "zod";
import { STRATEGY_NAMES } from "./router/strategies.js";

/** Gateway configuration. Env vars win; everything has a sane default. */
const ConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(6000),
  dataDir: z.string().default("./data"),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  strategy: z.enum(STRATEGY_NAMES).default("priority"),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse({
    port: env.PORT,
    dataDir: env.DATA_DIR,
    logLevel: env.LOG_LEVEL,
    strategy: env.ROUTING_STRATEGY,
  });
  if (!parsed.success) {
    throw new Error(`Invalid config: ${parsed.error.message}`);
  }
  return parsed.data;
}
