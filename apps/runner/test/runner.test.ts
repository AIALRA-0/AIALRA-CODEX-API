import { describe, expect, it } from "vitest";

import { codexEnvironment } from "../src/environment.js";

describe("runner boundary", () => {
  it("does not inherit control-plane secrets", () => {
    const result = codexEnvironment({
      PATH: "/usr/bin",
      CODEX_HOME: "/codex-auth",
      DATABASE_URL: "synthetic-database-value",
      PAYLOAD_MASTER_KEY: "synthetic-master-key",
      API_KEY_PEPPER: "synthetic-pepper",
    });
    expect(result.PATH).toBe("/usr/bin");
    expect(result.CODEX_HOME).toBe("/codex-auth");
    expect(result).not.toHaveProperty("DATABASE_URL");
    expect(result).not.toHaveProperty("PAYLOAD_MASTER_KEY");
    expect(result).not.toHaveProperty("API_KEY_PEPPER");
  });
});
