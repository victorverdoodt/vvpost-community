import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { BookOpen, FolderOpen, Palette, Send } from 'lucide-react'
import type { DocScope } from '@shared/ipc'
import { Button, controlClass, EmptyState, SegmentedControl } from '../../design-system'
import { useNavigation } from '../../lib/navigate'
import { useWorkspace } from '../../panels/useWorkspace'
import { DiagramEditContext } from '../../design-system/content/Markdown'
import { splitDiagramOrigin } from '@vvpost/core/docs/diagram-origin'
import type { DiagramTarget } from './diagram/DiagramStudio'

// O gerador (marked, Mermaid) é o mesmo chunk do "Gerar documentação" dos menus.
const DocsViewer = lazy(() => import('./DocsViewer'))
// O editor (Monaco, pdf.js) só carrega quando a pessoa abre a aba Editor.
const DocsEditor = lazy(() => import('./DocsEditor'))
// O editor de diagramas (Monaco, paleta) só carrega quando um diagrama é aberto.
const DiagramStudio = lazy(() => import('./diagram/DiagramStudio'))
// O "Enviar para…" só aparece com um publicador instalado (VVPost Enterprise) ou destinos no repo.
const PublishDialog = lazy(() => import('./PublishDialog'))

type Mode = 'view' | 'edit' | 'diagram'

/**
 * Documentação: a documentação viva do projeto inteiro, de um conector
 * ou de um endpoint, sem passar pelo menu de contexto de outro módulo. É o mesmo documento do
 * "Gerar documentação" (herança efetiva, auth, schemas, cenários, fluxos e diagramas), com
 * exportação em .md e PDF. A aba Editor escreve o documento do projeto (fonte e prévia em PDF lado a
 * lado, como no Overleaf) e o modelo que todo documento segue.
 */
export default function DocsModule() {
  const ws = useWorkspace()
  const [connectorId, setConnectorId] = useState('')
  const [endpointId, setEndpointId] = useState('')
  const [mode, setModeState] = useState<Mode>('view')
  // As abas abertas ficam montadas: o texto não salvo do editor sobrevive a uma ida aos diagramas.
  const [visited, setVisited] = useState<ReadonlySet<Mode>>(() => new Set<Mode>(['view']))
  const [diagram, setDiagram] = useState<DiagramTarget | null>(null)
  const [returnTo, setReturnTo] = useState<Exclude<Mode, 'diagram'>>('view')
  const [viewVersion, setViewVersion] = useState(0)
  const [filesVersion, setFilesVersion] = useState(0)
  const [styleRequest, setStyleRequest] = useState(0)
  const [diagramFiles, setDiagramFiles] = useState<string[]>([])
  const [canPublish, setCanPublish] = useState(false)
  const [publishing, setPublishing] = useState(false)
  useEffect(() => {
    void window.vvpost.publishTargets().then((r) => setCanPublish(r.ok && (r.value.providers.length > 0 || r.value.targets.length > 0)))
  }, [ws])
  const setMode = useCallback((next: Mode) => {
    setModeState(next)
    setVisited((v) => (v.has(next) ? v : new Set([...v, next])))
  }, [])
  const refreshDiagramFiles = useCallback(() => {
    void window.vvpost.docsProject().then((r) => r.ok && setDiagramFiles(r.value.diagramFiles))
  }, [])
  useEffect(() => {
    if (mode === 'diagram') refreshDiagramFiles()
  }, [mode, refreshDiagramFiles])
  const openDiagram = useCallback(
    (target: DiagramTarget, from: Exclude<Mode, 'diagram'>) => {
      setDiagram(target)
      setReturnTo(from)
      setMode('diagram')
    },
    [setMode]
  )
  // Botão Editar de um diagrama da visualização: a marca de origem diz onde gravar.
  const editFromView = useCallback(
    (raw: string, label: string) => {
      const { origin, code } = splitDiagramOrigin(raw)
      openDiagram(
        origin
          ? {
              code,
              label: origin.line ? `${label} de ${origin.file}` : origin.file,
              origin,
              previous: code
            }
          : { code, label: `${label} (gerado do projeto)` },
        'view'
      )
    },
    [openDiagram]
  )
  const connectors = ws.workspace?.connectors ?? []
  const connector = connectors.find((c) => c.id === connectorId)

  useNavigation('docs', (t) => {
    setConnectorId(t.connectorId ?? '')
    setEndpointId(t.endpointId ?? '')
  })

  // O escopo só muda com a escolha: um objeto novo a cada render (o workspace relido quando a
  // janela volta ao foco) gerava a documentação e redesenhava todos os diagramas de novo, mesmo
  // com o módulo oculto.
  const scopeConnector = connector?.id ?? ''
  const scopeEndpoint = connector?.endpoints.some((e) => e.id === endpointId) ? endpointId : ''
  const scope = useMemo<DocScope>(
    () =>
      scopeConnector
        ? scopeEndpoint
          ? {
              kind: 'endpoint',
              connectorId: scopeConnector,
              endpointId: scopeEndpoint
            }
          : { kind: 'connector', connectorId: scopeConnector }
        : { kind: 'project' },
    [scopeConnector, scopeEndpoint]
  )

  if (ws.result && !ws.result.ok)
    return <EmptyState icon={<BookOpen size={20} aria-hidden />} title={ws.result.message} />
  if (!ws.workspace) {
    return (
      <EmptyState
        icon={<BookOpen size={20} aria-hidden />}
        title="Nenhum workspace aberto"
        description="Abra o workspace para gerar a documentação dos conectores, endpoints e fluxos."
      >
        <Button size="sm" icon={<FolderOpen size={14} aria-hidden />} onClick={ws.open}>
          Abrir workspace…
        </Button>
      </EmptyState>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs">
        <SegmentedControl
          label="Modo da documentação"
          size="xs"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'view', label: 'Visualizar' },
            { value: 'edit', label: 'Editor' },
            { value: 'diagram', label: 'Diagramas' }
          ]}
        />
        {mode === 'view' && (
          <>
            <span className="text-muted">Escopo</span>
            <select
              aria-label="Conector da documentação"
              className={`max-w-64 ${controlClass}`}
              value={connector?.id ?? ''}
              onChange={(e) => {
                setConnectorId(e.target.value)
                setEndpointId('')
              }}
            >
              <option value="">Projeto inteiro</option>
              {connectors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {connector && (
              <select
                aria-label="Endpoint da documentação"
                className={`max-w-64 ${controlClass}`}
                value={endpointId}
                onChange={(e) => setEndpointId(e.target.value)}
              >
                <option value="">Conector inteiro</option>
                {connector.endpoints.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.method} {e.name}
                  </option>
                ))}
              </select>
            )}
          </>
        )}
        <span className="flex-1" />
        <Button
          size="sm"
          icon={<Palette size={14} aria-hidden />}
          title="Metodologia (C4, arc42...), logo, cores, fontes, página, cabeçalho e rodapé"
          onClick={() => {
            setStyleRequest((n) => n + 1)
            setMode('edit')
          }}
        >
          Estilo da documentação
        </Button>
        {canPublish && (
          <Button size="sm" icon={<Send size={14} aria-hidden />} title="Exportar como site HTML ou publicar nos destinos do vvpost.publish.json" onClick={() => setPublishing(true)}>
            Enviar para…
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <Suspense fallback={null}>
          {visited.has('view') && (
            <div className={mode === 'view' ? 'h-full' : 'hidden'}>
              <DiagramEditContext.Provider value={editFromView}>
                <DocsViewer key={`${JSON.stringify(scope)}:${viewVersion}`} scope={scope} />
              </DiagramEditContext.Provider>
            </div>
          )}
          {visited.has('edit') && (
            <div className={mode === 'edit' ? 'h-full' : 'hidden'}>
              <DocsEditor
                onOpenDiagram={(t) => openDiagram(t, 'edit')}
                onSaved={() => setViewVersion((v) => v + 1)}
                externalChange={filesVersion}
                showStyle={styleRequest}
              />
            </div>
          )}
          {visited.has('diagram') && (
            <div className={mode === 'diagram' ? 'h-full' : 'hidden'}>
              <DiagramStudio
                target={diagram}
                diagramFiles={diagramFiles}
                onBack={() => setMode(returnTo)}
                onSaved={() => {
                  setViewVersion((v) => v + 1)
                  setFilesVersion((v) => v + 1)
                  refreshDiagramFiles()
                }}
              />
            </div>
          )}
        </Suspense>
      </div>
      {publishing && (
        <Suspense fallback={null}>
          <PublishDialog onClose={() => setPublishing(false)} />
        </Suspense>
      )}
    </div>
  )
}
