export function truncateSessionKey(sessionKey: string): string {
  return sessionKey.length > 12 ? `${sessionKey.slice(0, 12)}…` : sessionKey;
}

export function threadExpiryLabel(expiresAt: string, now: Date = new Date()): string {
  const remainingMs = new Date(expiresAt).getTime() - now.getTime();
  if (Number.isNaN(remainingMs) || remainingMs <= 0) return "已到期";
  const hours = remainingMs / 3_600_000;
  if (hours >= 1) return `约 ${Math.round(hours)} 小时后到期`;
  return `约 ${Math.max(1, Math.round(remainingMs / 60_000))} 分钟后到期`;
}
