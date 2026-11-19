import { useEffect, useMemo, useState } from 'react'
import { applyChoices, hasConflictMarkers, parseConflicts, type ConflictChoice } from '@shared/conflicts'
import type { ConflictFile, ConflictResolution, WorkspaceResult, WorkspaceState } from '@shared/ipc'
import { buttonClass as buttonClassFor } from '../../design-system'

const buttonClass = buttonClassFor('secondary', 'sm')
const chosenClass = 'border-accent bg-accent/15 text-fg'

/**
 * Resolve um arquivo em conflito no app: bloco a bloco, com a versão
 * local e a remota lado a lado, ou um lado inteiro. O resultado é editável antes
 * de marcar como resolvido.
 */
export function ConflictView(props: {
  path: string
  busy: boolean
  onResolve: (resolution: ConflictResolution, label: string) => Promise<WorkspaceResult<WorkspaceState> | void>
}) {
  const [file, setFile] = useState<ConflictFile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [choices, setChoices] = useState<(ConflictChoice | undefined)[]>([])
  const [manual, setManual] = useState<string | null>(null)

  useEffect(() => {
    setFile(null)
    setError(null)
    setChoices([])
    setManual(null)
    void window.vvpost.readConflict(props.path).then((r) => (r.ok ? setFile(r.value) : setError(r.message)))
  }, [props.path])

  const segments = useMemo(() => (file?.working ? parseConflicts(file.working) : []), [file])
  const blocks = segments.filter((s) => s.kind === 'conflict')
  const result = manual ?? applyChoices(segments, choices)
  const unresolved = hasConflictMarkers(result)
  const invalidJson = useMemo(() => {
    if (unresolved || !props.path.endsWith('.json')) return null
    try {
      JSON.parse(result)
      return null
    } catch (err) {
      return (err as Error).message
    }
  }, [result, unresolved, props.path])

  if (error) return <div className="p-4 text-sm text-danger">{error}</div>
  if (!file) return null

  const resolveSide = (use: 'ours' | 'theirs') =>
    void props.onResolve({ use }, `${props.path}: ficou a versão ${use === 'ours' ? 'local' : 'remota'}.`)
  const choose = (i: number, c: ConflictChoice) => {
    setManual(null)
    setChoices((prev) => {
      const next = [...prev]
      next[i] = c
      return next
    })
  }

  const sides = (
    <div className="flex flex-wrap items-center gap-1.5">
      <button type="button" className={buttonClass} disabled={props.busy} onClick={() => resolveSide('ours')}>
        {file.ours === null ? 'Apagar (como na local)' : 'Usar a minha inteira'}
      </button>
      <button type="button" className={buttonClass} disabled={props.busy} onClick={() => resolveSide('theirs')}>
        {file.theirs === null ? 'Apagar (como na remota)' : 'Usar a remota inteira'}
      </button>
    </div>
  )

  // Arquivo apagado de um lado, binário ou sem marcadores legíveis: só dá para escolher um lado.
  if (file.tooLarge || file.ours === null || file.theirs === null || blocks.length === 0) {
    const reason = file.tooLarge
      ? 'Arquivo grande ou binário: escolha uma das versões inteiras.'
      : file.ours === null
        ? 'A sua branch apagou este arquivo e a remota o alterou.'
        : file.theirs === null
          ? 'A remota apagou este arquivo e a sua branch o alterou.'
          : 'O arquivo não tem blocos de conflito legíveis: escolha uma das versões inteiras.'
    return (
      <div className="flex flex-col gap-3 p-4 text-sm" aria-label={`Conflito em ${props.path}`}>
        <p className="text-muted">{reason}</p>
        {sides}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label={`Conflito em ${props.path}`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs">
        <span className="text-muted">
          {blocks.length} bloco(s) em conflito; {choices.filter(Boolean).length} escolhido(s).
        </span>
        <span className="ml-auto" />
        <button
          type="button"
          className={buttonClass}
          onClick={() => (setManual(null), setChoices(blocks.map(() => 'ours')))}
        >
          Todos da minha
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={() => (setManual(null), setChoices(blocks.map(() => 'theirs')))}
        >
          Todos da remota
        </button>
        {sides}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <ol className="flex flex-col gap-3">
          {blocks.map((b, i) => (
            <li key={i} className="rounded-md border border-border" aria-label={`Bloco ${i + 1}`}>
              <div className="grid grid-cols-2 text-xs">
                <Side
                  title={`Minha (${b.oursLabel || 'HEAD'})`}
                  text={b.ours}
                  chosen={choices[i] === 'ours' || choices[i] === 'both'}
                />
                <Side
                  title={`Remota (${b.theirsLabel || 'remoto'})`}
                  text={b.theirs}
                  chosen={choices[i] === 'theirs' || choices[i] === 'both'}
                  border
                />
              </div>
              <div className="flex gap-1.5 border-t border-border px-2 py-1.5">
                {(['ours', 'theirs', 'both'] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={choices[i] === c}
                    className={`${buttonClass} ${choices[i] === c ? chosenClass : ''}`}
                    onClick={() => choose(i, c)}
                  >
                    {c === 'ours' ? 'Usar a minha' : c === 'theirs' ? 'Usar a remota' : 'Usar as duas'}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ol>
        <label
          htmlFor="conflict-result"
          className="mt-4 mb-1 block text-xs font-semibold tracking-wide text-muted uppercase"
        >
          Resultado
        </label>
        <textarea
          id="conflict-result"
          spellCheck={false}
          className="h-56 w-full resize-y rounded-md border border-border bg-surface p-2 font-mono text-xs outline-none focus:border-accent"
          value={result}
          onChange={(e) => setManual(e.target.value)}
        />
      </div>
      <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-xs">
        {unresolved ? (
          <span className="text-warning">Escolha um lado em cada bloco (ou edite o resultado).</span>
        ) : invalidJson ? (
          <span className="text-warning">O resultado não é um JSON válido: {invalidJson}</span>
        ) : (
          <span className="text-muted">Pronto para marcar como resolvido.</span>
        )}
        <button
          type="button"
          className={`ml-auto ${buttonClassFor('primary', 'md')}`}
          disabled={props.busy || unresolved}
          onClick={() => void props.onResolve({ content: result }, `${props.path} resolvido.`)}
        >
          Marcar como resolvido
        </button>
      </div>
    </div>
  )
}

function Side(props: { title: string; text: string; chosen: boolean; border?: boolean }) {
  return (
    <div className={`min-w-0 ${props.border ? 'border-l border-border' : ''}`}>
      <div className={`px-2 py-1 font-medium ${props.chosen ? 'text-success' : 'text-muted'}`}>{props.title}</div>
      <pre
        className={`overflow-x-auto px-2 pb-2 font-mono break-all whitespace-pre-wrap ${props.chosen ? 'bg-success/10' : ''}`}
      >
        {props.text || '(vazio)'}
      </pre>
    </div>
  )
}
