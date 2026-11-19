import type { DocScope, WorkspaceInfo } from '@shared/ipc'
import type { DocRef } from './docs'

/**
 * O que identifica o projeto aberto: a pasta do workspace e o projeto escolhido nela (null é o
 * Compartilhado). Muda quando a pessoa troca de pasta ou de projeto; null antes de ler o workspace.
 */
export function projectIdentity(ws: WorkspaceInfo | null): string | null {
  if (!ws) return null
  return `${ws.dir}\n${ws.projects?.current ?? ''}`
}

/**
 * Abas de arquivo que saem ao trocar de projeto: todo documento aberto numa aba (conector, endpoint,
 * cenário, .md, diagrama) é do projeto anterior. As que têm mudanças não salvas ficam, para o texto
 * não se perder.
 */
export function tabsLeavingProject(tabs: ReadonlyMap<string, DocRef>, dirty: ReadonlySet<string>): string[] {
  return [...tabs.keys()].filter((key) => !dirty.has(key))
}

/**
 * A documentação gerada aberta por cima ao trocar de projeto: a do projeto continua, gerada de novo
 * para o projeto novo; a de um conector, endpoint ou request fecha (ele é do projeto anterior).
 */
export function docsAfterProjectSwitch(scope: DocScope | null): DocScope | null {
  return scope?.kind === 'project' ? scope : null
}

/** Módulos que leem o projeto uma vez ao abrir: remontam ao trocar de projeto, em vez de mostrar o anterior. */
export const PROJECT_PANELS: ReadonlySet<string> = new Set(['docs'])
