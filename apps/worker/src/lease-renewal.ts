export const CHATGPT_WEB_ACCOUNT_LEASE_MS = 60_000;
export const CHATGPT_WEB_ACCOUNT_LEASE_RENEW_MS = 20_000;

export function startLeaseRenewal(
  renew: () => Promise<boolean>,
  onLost: () => void,
  intervalMs = CHATGPT_WEB_ACCOUNT_LEASE_RENEW_MS,
): () => void {
  let stopped = false;
  let running = false;
  const timer = setInterval(
    () => {
      if (stopped || running) return;
      running = true;
      void renew()
        .then((renewed) => {
          if (!stopped && !renewed) onLost();
        })
        .catch(() => {
          if (!stopped) onLost();
        })
        .finally(() => {
          running = false;
        });
    },
    Math.max(1_000, intervalMs),
  );
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
