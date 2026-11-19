import type { WebhookEvent, WebhookSource } from '@vvpost/core/types'

export type WebhookChange = 'added' | 'updated' | 'cleared'

/**
 * Caixa de entrada do servidor de webhooks: os últimos eventos, só em memória, e quem
 * espera por eles (nós webhook dos fluxos). Os ids nunca voltam a zero, nem ao limpar:
 * são o cursor de quem espera "o que chegar daqui em diante".
 */
export interface WebhookInbox extends WebhookSource {
  add(event: Omit<WebhookEvent, 'id'>): WebhookEvent
  update(id: number, patch: Partial<Omit<WebhookEvent, 'id'>>): WebhookEvent | undefined
  /** Do mais novo para o mais antigo. */
  list(): WebhookEvent[]
  get(id: number): WebhookEvent | undefined
  clear(): void
  subscribe(listener: (change: WebhookChange, event?: WebhookEvent) => void): () => void
  readonly size: number
}

interface Waiter {
  accept: (event: WebhookEvent) => boolean
  since: number
  skip?: ReadonlySet<number>
  resolve: (event: WebhookEvent | null) => void
}

export const DEFAULT_MAX_EVENTS = 200

export function createWebhookInbox(options: { maxEvents?: number } = {}): WebhookInbox {
  const max = Math.max(1, options.maxEvents ?? DEFAULT_MAX_EVENTS)
  const events: WebhookEvent[] = []
  const waiters = new Set<Waiter>()
  const listeners = new Set<(change: WebhookChange, event?: WebhookEvent) => void>()
  let next = 1

  const emit = (change: WebhookChange, event?: WebhookEvent) => {
    for (const listener of listeners) {
      try {
        listener(change, event)
      } catch (err) {
        console.error('Falha num ouvinte de webhooks:', err)
      }
    }
  }
  const fits = (w: Waiter, e: WebhookEvent) => !e.rejected && e.id >= w.since && !w.skip?.has(e.id) && w.accept(e)

  return {
    get size() {
      return events.length
    },
    cursor: () => next,
    add(input) {
      const event: WebhookEvent = { ...input, id: next++ }
      events.push(event)
      if (events.length > max) events.splice(0, events.length - max)
      // Quem espera é atendido antes dos ouvintes: o fluxo já tem o evento quando a interface o mostra.
      for (const w of waiters) {
        if (fits(w, event)) {
          waiters.delete(w)
          w.resolve(event)
        }
      }
      emit('added', event)
      return event
    },
    update(id, patch) {
      const i = events.findIndex((e) => e.id === id)
      if (i < 0) return undefined
      const event = { ...events[i]!, ...patch, id }
      events[i] = event
      emit('updated', event)
      return event
    },
    list: () => [...events].reverse(),
    get: (id) => events.find((e) => e.id === id),
    clear() {
      events.length = 0
      emit('cleared')
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    wait(accept, { since, timeoutMs, skip, signal }) {
      const found = events.find((e) => fits({ accept, since, ...(skip && { skip }), resolve: () => {} }, e))
      if (found) return Promise.resolve(found)
      if (signal?.aborted) return Promise.reject(signal.reason)
      return new Promise<WebhookEvent | null>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer)
          waiters.delete(waiter)
          signal?.removeEventListener('abort', onAbort)
        }
        const waiter: Waiter = {
          accept,
          since,
          ...(skip && { skip }),
          resolve: (event) => {
            done()
            resolve(event)
          }
        }
        const onAbort = () => {
          done()
          reject(signal!.reason)
        }
        const timer = setTimeout(() => waiter.resolve(null), timeoutMs)
        waiters.add(waiter)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
  }
}
