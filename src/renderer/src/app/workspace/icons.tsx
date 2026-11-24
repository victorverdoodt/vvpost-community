import type { ReactNode } from 'react'
import { BookOpen, FlaskConical, Network, Palette, Route, Shapes } from 'lucide-react'
import type { DocRef } from './docs'

const icon = { size: 13, strokeWidth: 1.75, 'aria-hidden': true } as const

/** Ícone da aba pelo tipo do documento (o mesmo do explorador). */
export function docIcon(kind: DocRef['kind']): ReactNode {
  switch (kind) {
    case 'connector':
      return <Network {...icon} />
    case 'endpoint':
      return <Route {...icon} />
    case 'scenario':
      return <FlaskConical {...icon} />
    case 'markdown':
      return <BookOpen {...icon} />
    case 'diagram':
      return <Shapes {...icon} />
    case 'brand':
      return <Palette {...icon} />
  }
}
