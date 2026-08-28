import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { InMemoryJobRepository, PostgresJobRepository } from "@aialra/persistence";

import { ApiKeyGuard } from "./common/api-key.guard.js";
import { AuthController } from "./auth/auth.controller.js";
import { GovernanceController } from "./governance/governance.controller.js";
import { HealthController } from "./health/health.controller.js";
import { BatchesController, JobsController } from "./jobs/jobs.controller.js";
import { KeysController } from "./keys/keys.controller.js";
import { JobsService } from "./jobs/jobs.service.js";
import { NoopJobQueue, PgBossJobQueue } from "./queue/job-queue.js";
import { QuotaService, RepositoryQuotaProvider } from "./quota/quota.service.js";
import { ResponsesController } from "./responses/responses.controller.js";
import { JOB_QUEUE, JOB_REPOSITORY, QUOTA_PROVIDER } from "./tokens.js";

@Module({
  controllers: [
    HealthController,
    JobsController,
    BatchesController,
    ResponsesController,
    GovernanceController,
    KeysController,
    AuthController,
  ],
  providers: [
    JobsService,
    QuotaService,
    {
      provide: JOB_REPOSITORY,
      useFactory: async () => {
        const databaseUrl = process.env.DATABASE_URL;
        if (!databaseUrl || process.env.NODE_ENV === "test") {
          return new InMemoryJobRepository();
        }
        const masterKey = process.env.PAYLOAD_MASTER_KEY;
        if (!masterKey) {
          throw new Error("PAYLOAD_MASTER_KEY is required when DATABASE_URL is configured");
        }
        const repository = new PostgresJobRepository(databaseUrl, masterKey);
        await repository.migrate();
        return repository;
      },
    },
    {
      provide: JOB_QUEUE,
      useFactory: () => {
        const databaseUrl = process.env.DATABASE_URL;
        return databaseUrl && process.env.NODE_ENV !== "test"
          ? new PgBossJobQueue(databaseUrl)
          : new NoopJobQueue();
      },
    },
    {
      provide: QUOTA_PROVIDER,
      inject: [JOB_REPOSITORY],
      useFactory: (repository: InMemoryJobRepository | PostgresJobRepository) =>
        new RepositoryQuotaProvider(repository),
    },
    { provide: APP_GUARD, useClass: ApiKeyGuard },
  ],
  exports: [JobsService, QuotaService, JOB_REPOSITORY, JOB_QUEUE],
})
export class AppModule {}
