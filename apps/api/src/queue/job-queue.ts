import { PgBoss } from "pg-boss";

export interface JobQueue {
  enqueue(jobId: string): Promise<void>;
  enqueueChatGptWebQualification(runId: string): Promise<void>;
  cancel(jobId: string): Promise<void>;
  close(): Promise<void>;
}

export class NoopJobQueue implements JobQueue {
  readonly enqueued: string[] = [];
  readonly enqueuedQualifications: string[] = [];

  async enqueue(jobId: string): Promise<void> {
    this.enqueued.push(jobId);
  }

  async enqueueChatGptWebQualification(runId: string): Promise<void> {
    this.enqueuedQualifications.push(runId);
  }

  async cancel(): Promise<void> {
    return;
  }

  async close(): Promise<void> {
    return;
  }
}

export class PgBossJobQueue implements JobQueue {
  private readonly boss: PgBoss;
  private started = false;

  constructor(connectionString: string) {
    this.boss = new PgBoss({ connectionString, schema: "pgboss" });
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    await this.boss.start();
    await this.boss.createQueue("model-router-jobs");
    await this.boss.createQueue("chatgpt-web-qualifications");
    this.started = true;
  }

  async enqueue(jobId: string): Promise<void> {
    await this.start();
    await this.boss.send(
      "model-router-jobs",
      { jobId },
      { id: jobId, singletonKey: jobId, retryLimit: 0 },
    );
  }

  async enqueueChatGptWebQualification(runId: string): Promise<void> {
    await this.start();
    await this.boss.send(
      "chatgpt-web-qualifications",
      { runId },
      { id: runId, singletonKey: runId, retryLimit: 0 },
    );
  }

  async cancel(jobId: string): Promise<void> {
    if (!this.started) {
      return;
    }
    await this.boss.cancel("model-router-jobs", jobId).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.started) {
      await this.boss.stop({ graceful: true, timeout: 10_000 });
    }
  }
}
