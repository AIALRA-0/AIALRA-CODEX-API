import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const rootFile = (path: string) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

describe("production release serialization and provenance", () => {
  it("uses one shared lock for build and runtime switch operations", () => {
    const lock = rootFile("deploy/scripts/lib/deploy-lock.sh");
    expect(lock).toContain("flock -n");
    expect(lock).toContain("aialra-model-router-deploy.lock");
    for (const script of [
      "deploy/scripts/install-compose-release.sh",
      "deploy/scripts/enable-chatgpt-web.sh",
      "deploy/scripts/enable-codex-worker.sh",
    ]) {
      const source = rootFile(script);
      expect(source, script).toContain('source "$(dirname "$0")/lib/deploy-lock.sh"');
      expect(source, script).toContain("acquire_aialra_deploy_lock");
    }
  });

  it("binds every application image to one full Git revision", () => {
    const installer = rootFile("deploy/scripts/install-compose-release.sh");
    const compose = rootFile("deploy/compose.yaml");
    const containerfile = rootFile("deploy/Containerfile");
    const verifier = rootFile("deploy/scripts/verify-production-images.sh");

    expect(installer).toContain("^[a-f0-9]{40}$");
    expect(installer).toContain('export AIALRA_RELEASE_REVISION="$release_tag"');
    expect(compose.match(/AIALRA_RELEASE_REVISION: /g)).toHaveLength(6);
    expect(containerfile.match(/LABEL org\.opencontainers\.image\.revision=/g)).toHaveLength(6);
    expect(verifier).toContain("org.opencontainers.image.revision");
    expect(verifier).toContain("does not match AIALRA_RELEASE_REVISION");
  });
});
