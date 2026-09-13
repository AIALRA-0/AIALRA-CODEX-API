import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const helper = fileURLToPath(
  new URL("../../../deploy/chatgpt-browser/normalize-profile-exit.mjs", import.meta.url),
);

describe("Chromium restore prompt prevention", () => {
  it("changes only the crash markers in an existing profile", () => {
    const root = mkdtempSync(join(tmpdir(), "aialra-chromium-"));
    try {
      mkdirSync(join(root, "Default"));
      const preferencesPath = join(root, "Default", "Preferences");
      const original = {
        profile: { exit_type: "Crashed", exited_cleanly: false, avatar_index: 7 },
        extensions: { settings: { bridge: { active: true } } },
        account_info: [{ account_id: "example" }],
      };
      writeFileSync(preferencesPath, JSON.stringify(original));
      execFileSync(process.execPath, [helper, root]);
      expect(JSON.parse(readFileSync(preferencesPath, "utf8"))).toEqual({
        ...original,
        profile: { ...original.profile, exit_type: "Normal", exited_cleanly: true },
      });
      expect(readdirSync(join(root, "Default"))).toEqual(["Preferences"]);
      execFileSync(process.execPath, [helper, root]);
      expect(readdirSync(join(root, "Default"))).toEqual(["Preferences"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not create a profile or overwrite malformed preferences", () => {
    const root = mkdtempSync(join(tmpdir(), "aialra-chromium-"));
    try {
      execFileSync(process.execPath, [helper, root]);
      expect(readdirSync(root)).toEqual([]);
      mkdirSync(join(root, "Default"));
      const preferencesPath = join(root, "Default", "Preferences");
      writeFileSync(preferencesPath, "{invalid json");
      const result = spawnSync(process.execPath, [helper, root]);
      expect(result.status).not.toBe(0);
      expect(readFileSync(preferencesPath, "utf8")).toBe("{invalid json");
      expect(readdirSync(join(root, "Default"))).toEqual(["Preferences"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
