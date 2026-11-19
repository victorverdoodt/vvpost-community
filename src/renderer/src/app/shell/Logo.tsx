/** Marca do VVPost: o "VV" branco no quadrado violeta (o mesmo desenho de resources/icon.svg). */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="shrink-0">
      <rect x="1" y="1" width="22" height="22" rx="5.5" fill="var(--color-accent-pressed)" />
      <path
        d="M6 7.5 9.1 16.5 12 9.6l2.9 6.9L18 7.5"
        fill="none"
        stroke="#fff"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
