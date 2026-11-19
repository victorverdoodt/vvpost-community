import { useEffect, useMemo, useRef, useState } from 'react'
import { ChartColumn } from 'lucide-react'
import type { HttpResponseData } from '@shared/ipc'
import { CodeEditor } from '../editors/CodeEditor'
import { EmptyState } from '../feedback/EmptyState'
import { Button } from '../primitives/Button'
import { EXAMPLE_TEMPLATE, renderTemplate } from './template'

/**
 * Modo Visualize (o pm.visualizer do Postman): o template do usuário, em HTML com a sintaxe do
 * Handlebars, recebe a resposta em JSON e roda em `visualizer.html`, num iframe sandbox só com
 * allow-scripts. A origem é opaca (sem acesso ao app, ao preload ou ao Node) e o CSP da página
 * corta a rede; a resposta chega por postMessage.
 */
export function Visualizer(props: {
  response: HttpResponseData
  template: string
  onTemplateChange: (template: string) => void
}) {
  const { response } = props
  const [editing, setEditing] = useState(false)
  const [rendered, setRendered] = useState(props.template)
  const frame = useRef<HTMLIFrameElement>(null)
  const [generation, setGeneration] = useState(0)

  // Re-renderiza 400 ms depois da última tecla, recriando o iframe (documento limpo a cada vez).
  useEffect(() => {
    const t = setTimeout(() => {
      setRendered(props.template)
      setGeneration((g) => g + 1)
    }, 400)
    return () => clearTimeout(t)
  }, [props.template])

  const output = useMemo(() => {
    let data: unknown = {}
    try {
      data = JSON.parse(response.body)
    } catch {
      data = { body: response.body }
    }
    try {
      return { html: renderTemplate(rendered, data) }
    } catch (err) {
      return { error: (err as Error).message }
    }
  }, [rendered, response.body])

  useEffect(() => {
    if (!('html' in output)) return
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || (e.data as { type?: string })?.type !== 'vvpost-visualizer-ready') return
      frame.current?.contentWindow?.postMessage(
        {
          type: 'vvpost-visualize',
          html: output.html,
          response: {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            body: response.body,
            ms: response.timings.totalMs
          }
        },
        '*'
      )
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [output, response, generation])

  if (!props.template.trim() && !editing) {
    return (
      <EmptyState
        icon={<ChartColumn size={20} aria-hidden />}
        title="Visualize a resposta com um template"
        description="Escreva HTML com {{campos}} da resposta, como no pm.visualizer do Postman. O template roda isolado, sem rede e sem acesso ao app."
      >
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            props.onTemplateChange(EXAMPLE_TEMPLATE)
            setEditing(true)
          }}
        >
          Criar template
        </Button>
      </EmptyState>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border-subtle px-2 text-xs text-muted">
        <span>Template (Handlebars) · roda isolado, sem rede</span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
          {editing ? 'Esconder template' : 'Editar template'}
        </Button>
      </div>
      {editing && (
        <CodeEditor
          ariaLabel="Template do Visualize"
          value={props.template}
          onChange={props.onTemplateChange}
          language="text"
          className="max-h-[45%] min-h-24 border-b border-border"
        />
      )}
      {'error' in output ? (
        <p role="alert" className="p-3 text-xs text-danger">
          Erro no template: {output.error}
        </p>
      ) : (
        <iframe
          key={generation}
          ref={frame}
          title="Visualização da resposta"
          src="./visualizer.html"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 border-0 bg-surface"
        />
      )}
    </div>
  )
}
