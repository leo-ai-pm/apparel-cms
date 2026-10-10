import { AlertCircle, LoaderCircle } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost"; busy?: boolean };
export function Button({ children, className = "", variant = "secondary", busy, disabled, ...props }: ButtonProps) {
  return <button type="button" {...props} className={`button button-${variant} ${className}`} disabled={disabled || busy} aria-busy={busy || undefined}>
    {busy && <LoaderCircle size={16} className="spin" aria-hidden="true" />}{children}
  </button>;
}

export function Tag({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "success" | "warning" | "danger" }) {
  return <span className={`tag tag-${tone}`}>{children}</span>;
}

const ID_PATTERN = /((?:SIG|PKG|DSG)-[A-Za-z0-9_-]+)/;

export function MonoText({ text }: { text: string }) {
  return text.split(ID_PATTERN).map((part, index) => (
    /^(?:SIG|PKG|DSG)-[A-Za-z0-9_-]+$/.test(part)
      ? <span className="mono" key={`${part}-${index}`}>{part}</span>
      : part
  ));
}

export function ErrorNotice({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return <div className="error-notice" role="alert"><AlertCircle size={18} aria-hidden="true" /><span>{children}</span>{onRetry && <Button onClick={onRetry}>重试</Button>}</div>;
}

export function EmptyState({ title, children, icon }: { title: string; children: ReactNode; icon: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon" aria-hidden="true">{icon}</div><h3>{title}</h3><p>{children}</p></div>;
}
