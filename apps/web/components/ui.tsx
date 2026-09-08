import type { ReactNode } from "react";

export function Disclosure({
  title,
  children,
  className = "",
  open,
}: {
  title: string;
  children: ReactNode;
  className?: string;
  open?: boolean;
}) {
  return (
    <details className={`disclosure ${className}`.trim()} open={open}>
      <summary>{title}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}
