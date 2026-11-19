import { useEffect, useRef, useState } from 'react'
import { Shapes, TriangleAlert } from 'lucide-react'
import { Button, EmptyState } from '../../../design-system'
import DiagramStudio, { type DiagramTarget } from '../../../modules/docs/diagram/DiagramStudio'
import { sameText, useDiskChange } from '../../../lib/disk-changes'
import { filesChanged, type DocTab } from '../docs'

/** Aba de um diagrama .mmd: o editor Mermaid ao vivo. Sem arquivo, um diagrama novo (Salvar pede o nome). */
export default function DiagramTab(props: { file: string | null; tab: DocTab }) {
  const [target, setTarget] = useState<DiagramTarget | null | undefined>(props.file ? undefined : null)
  const [files, setFiles] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  // O que está no disco desde a última leitura ou gravação daqui, e se o editor tem mudanças.
  const disk = useRef<string | null>(null)
  const dirty = useRef(false)
  const [outside, setOutside] = useState(false)

  const read = (file: string) =>
    window.vvpost.readDiagram(file).then((r) => {
      if (!r.ok) return setError(r.message)
      disk.current = r.value
      setOutside(false)
      setTarget({ code: r.value.replace(/\s+$/, ''), label: file, origin: { file }, previous: r.value })
    })
  useEffect(() => {
    void window.vvpost.docsFiles().then((r) => r.ok && setFiles(r.value.diagrams))
    if (props.file) void read(props.file)
  }, [props.file])

  // Gravado fora do app (um agente pelo MCP, outro editor): sem mudanças no editor, a aba relê sozinha.
  useDiskChange(
    (f) => f === props.file,
    () => {
      const file = props.file
      if (!file) return
      void window.vvpost.readDiagram(file).then((r) => {
        if (!r.ok || (disk.current !== null && sameText(r.value, disk.current))) return
        if (dirty.current) setOutside(true)
        else void read(file)
      })
    }
  )

  if (error) return <EmptyState icon={<TriangleAlert size={20} aria-hidden />} title={`Não foi possível abrir ${props.file}`} description={error} />
  if (target === undefined) return <EmptyState icon={<Shapes size={20} aria-hidden />} title={`Abrindo ${props.file}…`} />
  return (
    <div className="flex h-full min-h-0 flex-col">
      {outside && props.file && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-border bg-warning/10 px-4 py-1.5 text-xs">
          <TriangleAlert size={14} className="shrink-0 text-warning" aria-hidden />
          <span className="min-w-0 flex-1">{props.file} mudou fora do app (um agente pelo MCP ou outro editor) e o editor tem mudanças não salvas.</span>
          <Button size="sm" onClick={() => void read(props.file!)} title="Descarta as mudanças do editor">
            Recarregar do disco
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOutside(false)}>
            Fechar aviso
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <DiagramStudio
          target={target}
          diagramFiles={files}
          onBack={props.tab.close}
          onDirty={(d) => {
            dirty.current = d
          }}
          onSaved={(file) => {
            filesChanged()
            // O que foi gravado vira a referência do disco: o aviso do watcher depois disso é desta gravação.
            const saved = file ?? props.file
            if (saved) void window.vvpost.readDiagram(saved).then((r) => r.ok && (disk.current = r.value))
            // Diagrama novo salvo: a aba passa a ser a do arquivo.
            if (file && file !== props.file) props.tab.replace({ kind: 'diagram', file })
          }}
        />
      </div>
    </div>
  )
}
