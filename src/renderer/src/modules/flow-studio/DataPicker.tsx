import { useState } from 'react'
import { describeValue, javascriptExpression, pathExpression, pythonExpression, type KnownOutputs } from './model'
import type { PickTarget } from './TemplateInput'

interface Props {
  /** Nós cuja saída pode ser usada (os anteriores ao nó selecionado). */
  names: readonly string[]
  outputs: KnownOutputs
  target: PickTarget | null
}

/**
 * Visual Data Picker: a árvore das respostas da última execução. Clicar
 * num campo escreve a referência no último campo focado do inspetor, sem digitar o caminho.
 */
export function DataPicker({ names, outputs, target }: Props) {
  const available = names.filter((n) => outputs.has(n))
  const pick = (path: (string | number)[]) => {
    if (!target) return
    const text =
      target.format === 'python'
        ? pythonExpression(path)
        : target.format === 'javascript'
          ? javascriptExpression(path)
          : target.format === 'path'
            ? pathExpression(path)
            : `{{ ${pathExpression(path)} }}`
    target.insert(text)
  }
  return (
    <section aria-label="Visual Data Picker" className="flex min-w-0 flex-col gap-1">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Dados dos nós anteriores</h3>
      {names.length === 0 ? (
        <p className="text-xs text-muted">
          Este nó não tem nós anteriores. Ligue um nó a ele para usar a saída em $nodes.
        </p>
      ) : available.length === 0 ? (
        <p className="text-xs text-muted">Rode o fluxo para navegar nas respostas de {names.join(', ')}.</p>
      ) : (
        <>
          <p className="text-xs text-muted">
            {target ? (
              <>
                Clique num campo para inserir em <span className="text-fg">{target.label}</span>.
              </>
            ) : (
              'Foque um campo do nó e clique num valor para inserir a referência.'
            )}
          </p>
          <ul className="font-mono text-xs">
            {available.map((name) => (
              <TreeItem key={name} label={name} value={outputs.get(name)} path={[name]} onPick={pick} depth={0} open />
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function TreeItem({
  label,
  value,
  path,
  onPick,
  depth,
  open: initiallyOpen = false
}: {
  label: string
  value: unknown
  path: (string | number)[]
  onPick(path: (string | number)[]): void
  depth: number
  open?: boolean
}) {
  const [open, setOpen] = useState(initiallyOpen || (depth === 1 && label === 'data'))
  const children = Array.isArray(value)
    ? value.slice(0, 100).map((v, i) => [i, v] as const)
    : value && typeof value === 'object'
      ? Object.entries(value).slice(0, 200)
      : null
  return (
    <li>
      <div className="flex items-center gap-1" style={{ paddingLeft: depth * 12 }}>
        {children ? (
          <button
            type="button"
            aria-label={`${open ? 'Recolher' : 'Expandir'} ${pathExpression(path)}`}
            onClick={() => setOpen(!open)}
            className="w-4 text-muted"
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-4" />
        )}
        <button
          type="button"
          title={`Inserir ${pathExpression(path)}`}
          aria-label={`Inserir ${pathExpression(path)}`}
          onClick={() => onPick(path)}
          className="flex min-w-0 gap-2 rounded px-1 hover:bg-border"
        >
          <span className="text-accent">{typeof path.at(-1) === 'number' ? `[${label}]` : label}</span>
          {!children || !open ? <span className="truncate text-muted">{describeValue(value)}</span> : null}
        </button>
      </div>
      {children && open && (
        <ul>
          {children.map(([key, v]) => (
            <TreeItem
              key={String(key)}
              label={String(key)}
              value={v}
              path={[...path, key]}
              onPick={onPick}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
