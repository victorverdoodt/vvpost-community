import { createElement } from 'react'
import { BookOpen } from 'lucide-react'
import type { DocScope } from '@shared/ipc'
import type { ContextMenuItem } from '../../design-system'

/** Evento que abre a documentação rica por cima do módulo ativo (o App escuta). */
export const OPEN_DOCS = 'vvpost:open-docs'

export function openDocs(scope: DocScope): void {
  window.dispatchEvent(new CustomEvent<DocScope>(OPEN_DOCS, { detail: scope }))
}

const SCOPE_LABEL: Record<DocScope['kind'], string> = {
  project: 'do projeto',
  connector: 'do conector',
  endpoint: 'do endpoint',
  request: 'da request'
}

/** Item "Gerar documentação" do menu de contexto, com o escopo do nível da hierarquia. */
export function docsMenuItem(scope: DocScope): ContextMenuItem {
  return {
    id: `docs-${scope.kind}`,
    label: `Gerar documentação ${SCOPE_LABEL[scope.kind]}`,
    icon: createElement(BookOpen, { size: 14, 'aria-hidden': true }),
    hint: 'PDF · .md',
    run: () => openDocs(scope)
  }
}

/**
 * Itens do menu de contexto de um nível: primeiro o do próprio nível, depois os dos níveis
 * acima (a request também documenta o endpoint, o conector e o projeto).
 */
export function docsMenuItems(scope: DocScope): ContextMenuItem[] {
  const scopes: DocScope[] = [scope]
  if (scope.kind === 'request') scopes.push({ kind: 'endpoint', connectorId: scope.connectorId, endpointId: scope.endpointId })
  if (scope.kind === 'request' || scope.kind === 'endpoint') scopes.push({ kind: 'connector', connectorId: scope.connectorId })
  if (scope.kind !== 'project') scopes.push({ kind: 'project' })
  return scopes.map((s, i) => ({ ...docsMenuItem(s), ...(i > 0 && { icon: undefined, hint: undefined }) }))
}
