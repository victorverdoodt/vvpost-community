import type { ReactNode } from 'react'

/** Primeiro uso ou lista vazia: o que é a tela e o que fazer a seguir. */
export function EmptyState(props: { icon?: ReactNode; title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 p-8 text-center">
      {props.icon && (
        <div className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-card)] border border-border bg-elevated text-accent">
          {props.icon}
        </div>
      )}
      <div className="space-y-1">
        <p className="text-sm font-semibold text-fg">{props.title}</p>
        {props.description && <p className="max-w-sm text-xs text-muted">{props.description}</p>}
      </div>
      {props.children && <div className="flex flex-wrap justify-center gap-2">{props.children}</div>}
    </div>
  )
}
