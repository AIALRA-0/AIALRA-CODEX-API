import { Inject, Injectable } from "@nestjs/common";

import type { QuotaSnapshot } from "@aialra/contracts";
import type { JobRepository } from "@aialra/persistence";

import { QUOTA_PROVIDER } from "../tokens.js";

export interface QuotaProvider {
  read(): Promise<QuotaSnapshot>;
}

export class UnavailableQuotaProvider implements QuotaProvider {
  async read(): Promise<QuotaSnapshot> {
    return {
      provider: "codex",
      usedPercent: null,
      windowDurationMinutes: null,
      resetsAt: null,
      planType: null,
      fetchedAt: new Date().toISOString(),
      source: "unavailable",
      windows: [],
      stale: true,
    };
  }
}

export class RepositoryQuotaProvider implements QuotaProvider {
  constructor(private readonly repository: JobRepository) {}

  async read(): Promise<QuotaSnapshot> {
    const snapshot = await this.repository.latestQuotaSnapshot();
    if (!snapshot) return new UnavailableQuotaProvider().read();
    return {
      ...snapshot,
      windows: snapshot.windows ?? [],
      stale: Date.now() - Date.parse(snapshot.fetchedAt) > 45_000,
    };
  }
}

@Injectable()
export class QuotaService {
  constructor(@Inject(QUOTA_PROVIDER) private readonly provider: QuotaProvider) {}

  async read(): Promise<QuotaSnapshot> {
    return this.provider.read();
  }
}
