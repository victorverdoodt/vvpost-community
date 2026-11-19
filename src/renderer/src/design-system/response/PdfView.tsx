import { useEffect, useRef, useState } from 'react'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

/** Páginas desenhadas no máximo; o resto fica para o arquivo salvo. */
const MAX_PAGES = 50

/**
 * Prévia de PDF com o pdf.js (carregado só quando uma resposta PDF é aberta). Desenha as páginas em
 * canvas, sem scripts do PDF, sem formulários e sem rede.
 */
export default function PdfView(props: {
  bytes: Uint8Array
  /** Mantém as páginas anteriores (e a rolagem) até as novas ficarem prontas: a prévia que recompila. */
  keepPages?: boolean
}) {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<{ pages: number; shown: number } | { error: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    let destroy: (() => void) | undefined
    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist')
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
        // O pdf.js transfere o buffer para o worker: manda uma cópia.
        const task = pdfjs.getDocument({
          data: props.bytes.slice(),
          enableXfa: false,
          useWasm: false,
          useSystemFonts: true
        })
        destroy = () => void task.destroy()
        const doc = await task.promise
        if (cancelled) return
        const shown = Math.min(doc.numPages, MAX_PAGES)
        setState({ pages: doc.numPages, shown })
        const width = Math.max(320, (host.current?.clientWidth ?? 800) - 32)
        // Recompilando: desenha fora da tela e troca tudo de uma vez no fim.
        const target: ParentNode | null = props.keepPages && host.current?.childElementCount ? document.createDocumentFragment() : host.current
        for (let n = 1; n <= shown && !cancelled; n++) {
          const page = await doc.getPage(n)
          const base = page.getViewport({ scale: 1 })
          const scale = Math.min(2, width / base.width)
          const viewport = page.getViewport({ scale: scale * devicePixelRatio })
          const canvas = document.createElement('canvas')
          canvas.width = viewport.width
          canvas.height = viewport.height
          canvas.style.width = `${viewport.width / devicePixelRatio}px`
          canvas.setAttribute('role', 'img')
          canvas.setAttribute('aria-label', `Página ${n} de ${doc.numPages}`)
          canvas.className = 'mx-auto shadow-[var(--shadow-overlay)]'
          target?.appendChild(canvas)
          await page.render({ canvas, viewport }).promise
        }
        if (!cancelled && target && target !== host.current) host.current?.replaceChildren(target)
      } catch (err) {
        if (!cancelled) setState({ error: (err as Error).message })
      }
    })()
    return () => {
      cancelled = true
      destroy?.()
      if (!props.keepPages) host.current?.replaceChildren()
    }
  }, [props.bytes, props.keepPages])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-elevated">
      <p className="sticky top-0 z-[1] border-b border-border-subtle bg-panel px-3 py-1 text-[11px] text-muted" aria-live="polite">
        {!state
          ? 'Abrindo o PDF…'
          : 'error' in state
            ? <span className="text-danger">Não deu para abrir o PDF: {state.error}</span>
            : state.shown < state.pages
              ? `PDF com ${state.pages} páginas; mostrando as ${state.shown} primeiras. Salve a resposta para ver todas.`
              : `PDF com ${state.pages} ${state.pages === 1 ? 'página' : 'páginas'}`}
      </p>
      <div ref={host} data-testid="pdf-pages" className="flex flex-col gap-4 p-4" />
    </div>
  )
}
