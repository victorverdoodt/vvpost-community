import { useEffect, useRef } from 'react'
import { WORKSPACE_CHANGED } from '../panels/useWorkspace'
import { FILES_CHANGED } from '../app/workspace/docs'

/** Arquivos do workspace que mudaram no disco (detail: caminhos relativos ao projeto aberto). */
export const DISK_CHANGED = 'vvpost:disk-changed'

/**
 * Liga o aviso do main process (o watcher do workspace) aos eventos do renderer: um agente pelo
 * MCP, o CLI, um editor ou o Git gravou; o catálogo e o explorador releem, e cada aba aberta
 * confere o próprio arquivo. Chamado uma vez, pelo App.
 */
export function listenDiskChanges(): () => void {
  return window.vvpost.onWorkspaceFilesChanged(({ files }) => {
    window.dispatchEvent(new CustomEvent<string[]>(DISK_CHANGED, { detail: files }))
    window.dispatchEvent(new Event(WORKSPACE_CHANGED))
    window.dispatchEvent(new Event(FILES_CHANGED))
  })
}

/** Chama `handler` quando algum arquivo que `match` aceita muda no disco. */
export function useDiskChange(match: (file: string) => boolean, handler: () => void): void {
  const ref = useRef({ match, handler })
  ref.current = { match, handler }
  useEffect(() => {
    const listener = (e: Event) => {
      if ((e as CustomEvent<string[]>).detail.some((f) => ref.current.match(f))) ref.current.handler()
    }
    window.addEventListener(DISK_CHANGED, listener)
    return () => window.removeEventListener(DISK_CHANGED, listener)
  }, [])
}

/** O mesmo texto, sem contar CRLF nem quebras de linha no fim (o app grava com "\n" final). */
export const sameText = (a: string, b: string): boolean => a.replace(/\r\n/g, '\n').replace(/\n+$/, '') === b.replace(/\r\n/g, '\n').replace(/\n+$/, '')
