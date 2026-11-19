import { lazy, Suspense, useEffect, useState } from 'react'

const SHOW = 'vvpost:new-item'

// O modal é um chunk à parte: só carrega na primeira vez que abre.
const NewItemDialog = lazy(() => import('./NewItemDialog'))

/** O que dá para criar pelo modal Novo. */
export type NewItemKind = 'request' | 'flow' | 'connector' | 'endpoint' | 'scenario' | 'environment' | 'markdown' | 'diagram' | 'project'
/** Os tipos que pedem algo no modal antes de criar. */
export type NewItemStep = Extract<NewItemKind, 'flow' | 'endpoint' | 'scenario' | 'markdown'>

/** Botão Novo do explorador, Ctrl+Shift+N e a paleta: abre o modal no App. */
export function showNewItem(): void {
  window.dispatchEvent(new CustomEvent<NewItemStep | undefined>(SHOW))
}

/** Menu de uma seção do explorador: abre o modal já no passo do tipo (nome ou conector). */
export function showNewItemStep(kind: NewItemStep): void {
  window.dispatchEvent(new CustomEvent<NewItemStep | undefined>(SHOW, { detail: kind }))
}

/**
 * Modal "Novo" (estilo editor de código): escolher o que criar, um fluxo, uma requisição, um
 * documento... O que precisa de um nome ou de um conector pergunta ali mesmo; o resto abre na aba
 * do editor do tipo.
 */
export function NewItem(props: { onNewRequest: () => void }) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<NewItemStep | undefined>()
  useEffect(() => {
    const show = (e: Event) => {
      setKind((e as CustomEvent<NewItemStep | undefined>).detail)
      setOpen(true)
    }
    window.addEventListener(SHOW, show)
    return () => window.removeEventListener(SHOW, show)
  }, [])
  if (!open) return null
  return (
    <Suspense fallback={null}>
      <NewItemDialog key={kind ?? ''} initial={kind} onClose={() => setOpen(false)} onNewRequest={props.onNewRequest} />
    </Suspense>
  )
}
