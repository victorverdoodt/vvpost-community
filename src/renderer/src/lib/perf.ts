import { useEffect } from 'react'
import { track } from './ux-study'

/**
 * Desempenho como requisito de UX: quanto cada módulo leva para
 * aparecer na primeira vez (com o chunk carregado) e na volta, e quanto dura a primeira execução
 * de cada módulo. As medidas vão para o Performance Timeline (`vvpost:module:<id>:first|return`,
 * `vvpost:run:<módulo>:first`), lidas por scripts/bench-modules.mjs, e para o teste com usuários.
 */
const opening = new Map<string, number>()
const shown = new Set<string>()
const ran = new Set<string>()

const measure = (name: string, start: number): number => {
  const duration = performance.now() - start
  try {
    performance.measure(name, { start, duration })
  } catch {
    // sem User Timing (testes de componente): só não registra
  }
  return Math.round(duration)
}

/** O usuário pediu o módulo (clique, atalho, paleta, navegação). */
export function moduleOpening(id: string): void {
  opening.set(id, performance.now())
}

/** O módulo pedido aparece: conta depois do paint, com o módulo já montado. */
export function useModuleShown(id: string, active: boolean): void {
  useEffect(() => {
    if (!active) return
    const start = opening.get(id)
    // O módulo da abertura do app não foi pedido: o cold start já mede, e a próxima vez é volta.
    if (start === undefined) return void shown.add(id)
    let frame = requestAnimationFrame(() => {
      frame = window.setTimeout(() => {
        opening.delete(id)
        const first = !shown.has(id)
        shown.add(id)
        const ms = measure(`vvpost:module:${id}:${first ? 'first' : 'return'}`, start)
        track('module-ready', { id, ms, first })
      }) as unknown as number
    })
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(frame)
    }
  }, [id, active])
}

/** Roda `task` e, se for a primeira execução do módulo na sessão, mede quanto ela levou. */
export async function timedRun<T>(module: string, task: () => Promise<T>): Promise<T> {
  const start = performance.now()
  try {
    return await task()
  } finally {
    if (!ran.has(module)) {
      ran.add(module)
      track('first-run', { module, ms: measure(`vvpost:run:${module}:first`, start) })
    }
  }
}
