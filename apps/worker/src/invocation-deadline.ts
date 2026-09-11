export class InvocationDeadline {
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private readonly controller = new AbortController();

  constructor(private readonly deadlineMs: number) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  start(): void {
    if (this.started || this.controller.signal.aborted) return;
    this.started = true;
    this.timer = setTimeout(
      () => {
        this.controller.abort(new Error("deadline_exceeded"));
      },
      Math.max(1_000, this.deadlineMs),
    );
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
