import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import {
  DashboardSessions,
  DEFAULT_DASHBOARD_PASSWORD,
  checkDashboardPassword,
  dashboardPasswordState,
  setDashboardPassword,
} from "../src/ingress/dashboardAuth.js";

function freshStore(): Store {
  return new Store(mkdtempSync(join(tmpdir(), "llmswitch-dashauth-")));
}

describe("dashboard password auth", () => {
  it("default password works until changed", () => {
    const store = freshStore();
    expect(dashboardPasswordState(store).isDefault).toBe(true);
    expect(checkDashboardPassword(store, DEFAULT_DASHBOARD_PASSWORD)).toBe(true);
    expect(checkDashboardPassword(store, "nope")).toBe(false);
    store.close();
  });

  it("changed password replaces the default and persists hashed", () => {
    const store = freshStore();
    setDashboardPassword(store, "my-new-secret");
    expect(dashboardPasswordState(store).isDefault).toBe(false);
    expect(checkDashboardPassword(store, "my-new-secret")).toBe(true);
    expect(checkDashboardPassword(store, DEFAULT_DASHBOARD_PASSWORD)).toBe(false);
    const raw = store.getSetting("dashboard_pw_hash")!;
    expect(raw.startsWith("scrypt:")).toBe(true);
    expect(raw.includes("my-new-secret")).toBe(false);
    store.close();
  });

  it("sessions issue, validate and revoke", () => {
    const sessions = new DashboardSessions();
    const token = sessions.issue();
    expect(sessions.valid(token)).toBe(true);
    expect(sessions.valid("bogus")).toBe(false);
    expect(sessions.valid(undefined)).toBe(false);
    sessions.revoke(token);
    expect(sessions.valid(token)).toBe(false);
    const t2 = sessions.issue();
    sessions.revokeAll();
    expect(sessions.valid(t2)).toBe(false);
  });
});
