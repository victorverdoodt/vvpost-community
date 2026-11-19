// "Converter conectores para fluxos…" da paleta, fora do chunk do explorador: o pedido fica
// guardado até o explorador montar (ele pode estar fechado quando a paleta roda).
const EVENT = 'vvpost:convert-flows'
let pending = false

export function requestConvertToFlows(): void {
  pending = true
  window.dispatchEvent(new Event(EVENT))
}

/** O explorador atende o pedido, inclusive o que chegou antes dele montar. */
export function onConvertRequest(run: () => void): () => void {
  const handle = () => {
    if (!pending) return
    pending = false
    run()
  }
  handle()
  window.addEventListener(EVENT, handle)
  return () => window.removeEventListener(EVENT, handle)
}
