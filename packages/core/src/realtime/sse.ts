/** Um evento de um stream text/event-stream. */
export interface SseEvent {
  /** Campo event: (padrão "message"). */
  event: string
  data: string
  id?: string
  retry?: number
}

/**
 * Parser de Server-Sent Events no formato do HTML Living Standard: linhas `campo: valor`,
 * evento a cada linha em branco, `data:` repetido junta com \n, comentários com `:`. Recebe o
 * texto em pedaços quaisquer (um chunk pode cortar uma linha no meio).
 */
export function createSseParser(onEvent: (event: SseEvent) => void): { feed(chunk: string): void; end(): void } {
  let buffer = ''
  let event = ''
  let data: string[] = []
  let id: string | undefined
  let retry: number | undefined
  let first = true

  const dispatch = () => {
    if (data.length) onEvent({ event: event || 'message', data: data.join('\n'), ...(id !== undefined && { id }), ...(retry !== undefined && { retry }) })
    event = ''
    data = []
    retry = undefined
  }
  const line = (text: string) => {
    if (text === '') return dispatch()
    if (text.startsWith(':')) return
    const at = text.indexOf(':')
    const field = at < 0 ? text : text.slice(0, at)
    let value = at < 0 ? '' : text.slice(at + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    else if (field === 'id' && !value.includes('\0')) id = value
    else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value)
  }

  return {
    feed(chunk) {
      buffer += chunk
      if (first && buffer.length) {
        buffer = buffer.replace(/^﻿/, '')
        first = false
      }
      let at: number
      while ((at = buffer.search(/\r\n|\r|\n/)) >= 0) {
        // Um \r no fim do pedaço pode ser metade de um \r\n: espera o próximo.
        if (buffer[at] === '\r' && at === buffer.length - 1) break
        line(buffer.slice(0, at))
        buffer = buffer.slice(at + (buffer.startsWith('\r\n', at) ? 2 : 1))
      }
    },
    end() {
      // O evento sem a linha em branco final é descartado, como no EventSource.
      buffer = ''
      data = []
    }
  }
}
