import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cx } from '../cx'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent font-semibold text-surface hover:bg-accent-hover active:bg-accent-pressed',
  secondary: 'border border-border bg-elevated text-fg hover:border-faint hover:bg-border/60 active:bg-border',
  ghost: 'text-muted hover:bg-border/50 hover:text-fg active:bg-border',
  danger: 'border border-danger/40 bg-danger/10 text-danger hover:bg-danger/20 active:bg-danger/30'
}

const sizes: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1.5 px-2.5 text-xs',
  md: 'h-8 gap-2 px-3 text-[13px]'
}

/**
 * Classes do botão para elementos que não podem ser um <Button> (um <label> de upload, um link)
 * ou código ainda em migração. Prefira o componente.
 */
export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'sm'): string {
  return cx(
    'inline-flex shrink-0 items-center justify-center rounded-[var(--radius-control)] font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50',
    variants[variant],
    sizes[size]
  )
}

/** Campo de texto e select do design system (o fundo, a borda e o foco vêm dos estilos base). */
export const controlClass = 'h-7 min-w-0 border px-2 text-xs disabled:opacity-50'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
}

/** Botão do design system: primário (ação principal da tela), secundário, fantasma e destrutivo. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, className, children, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(buttonClass(variant, size), className)}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
})

/** Botão só de ícone; o rótulo vira o nome acessível e a dica. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }
>(function IconButton({ label, active, className, children, type = 'button', ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-control)] transition-colors disabled:opacity-50',
        active ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-border/50 hover:text-fg',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
})
