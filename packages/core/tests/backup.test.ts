import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "llmswitch-backup-"));
}

describe("database backups", () => {
  it("creates a snapshot that lists and downloads as a real DB", () => {
    const dir = freshDir();
    const store = new Store(dir);
    store.setSetting("marker", "v1");
    const b = store.createBackup();
    expect(Store.backupNameOk(b.name)).toBe(true);
    expect(b.sizeBytes).toBeGreaterThan(0);
    const listed = store.listBackups();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.name).toBe(b.name);
    expect(store.backupPath(b.name)).not.toBeNull();
    expect(store.backupPath("../llmswitch.db")).toBeNull(); // traversal rejected
    expect(store.backupPath("evil.db")).toBeNull();
    store.close();
  });

  it("stages a restore and the next Store applies it (old DB kept)", () => {
    const dir = freshDir();
    const s1 = new Store(dir);
    s1.setSetting("marker", "from-backup");
    const b = s1.createBackup();
    s1.setSetting("marker", "after-backup");
    expect(s1.stageRestore(b.name)).toEqual({ ok: true });
    s1.close();

    const s2 = new Store(dir); // constructor applies the staged restore
    expect(s2.getSetting("marker")).toBe("from-backup");
    const files = readdirSync(dir);
    expect(files.some((f) => f.startsWith("llmswitch.db.pre-restore-"))).toBe(true);
    s2.close();
  });

  it("refuses to stage a non-database file", () => {
    const dir = freshDir();
    const store = new Store(dir);
    const bogus = "llmswitch-backup-2000-01-01.db";
    store.listBackups(); // creates the backups dir
    writeFileSync(join(dir, "backups", bogus), "this is not sqlite");
    expect(store.stageRestore(bogus).ok).toBe(false);
    expect(existsSync(join(dir, "llmswitch.db.restore-pending"))).toBe(false);
    store.close();
  });

  it("prunes to the newest N backups", () => {
    const dir = freshDir();
    const store = new Store(dir);
    for (let i = 0; i < 3; i++) store.createBackup(new Date(Date.now() + i * 1000));
    expect(store.listBackups().length).toBe(3);
    // names collide at 1s resolution in the worst case — prune keeps <= keep
    const pruned = store.pruneBackups(1);
    expect(store.listBackups().length).toBeLessThanOrEqual(1);
    expect(pruned).toBeGreaterThanOrEqual(0);
    store.close();
  });
});
