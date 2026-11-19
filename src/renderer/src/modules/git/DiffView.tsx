import { useMemo } from 'react'
import type { FileDiff } from '@shared/ipc'
import { jsonSideBySide, type DiffCell, type DiffRow } from '@shared/json-diff'

const tone: Record<'removed' | 'added' | 'none', string> = {
  removed: 'bg-danger/15 text-danger',
  added: 'bg-success/15 text-success',
  none: ''
}

/** Diff JSON lado a lado: HEAD à esquerda, o que vai para o commit à direita. */
export function DiffView({ diff, labels }: { diff: FileDiff; labels?: [string, string] }) {
  const rows = useMemo(() => (diff.tooLarge ? [] : jsonSideBySide(diff.before, diff.after)), [diff])

  if (diff.tooLarge) {
    return <div className="p-4 text-sm text-muted">Arquivo grande ou binário: sem diff visual.</div>
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto font-mono text-xs" aria-label={`Diff de ${diff.path}`}>
      <div className="sticky top-0 grid grid-cols-2 border-b border-border bg-panel text-muted">
        <div className="px-3 py-1.5">{labels?.[0] ?? (diff.before === null ? 'Arquivo novo' : 'HEAD')}</div>
        <div className="border-l border-border px-3 py-1.5">{labels?.[1] ?? (diff.after === null ? 'Apagado' : 'Para o commit')}</div>
      </div>
      <table className="w-full table-fixed border-collapse">
        <colgroup>
          <col className="w-10" />
          <col />
          <col className="w-10" />
          <col />
        </colgroup>
        <tbody>
          {rows.map((row, i) => (
            <Row key={i} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Row({ row }: { row: DiffRow }) {
  if (row.kind === 'gap') {
    return (
      <tr>
        <td colSpan={4} className="bg-border/30 px-3 py-0.5 text-center text-muted">
          ⋯ {row.hidden} linha(s) iguais
        </td>
      </tr>
    )
  }
  const changed = row.kind !== 'same'
  return (
    <tr data-kind={row.kind}>
      <Cell cell={row.left} tone={changed && row.left ? 'removed' : 'none'} />
      <Cell cell={row.right} tone={changed && row.right ? 'added' : 'none'} border />
    </tr>
  )
}

function Cell({ cell, tone: t, border }: { cell?: DiffCell; tone: keyof typeof tone; border?: boolean }) {
  return (
    <>
      <td
        className={`select-none px-2 text-right align-top text-muted/70 ${border ? 'border-l border-border' : ''} ${cell ? tone[t] : 'bg-border/20'}`}
      >
        {cell?.line}
      </td>
      <td className={`px-2 align-top break-all whitespace-pre-wrap ${cell ? tone[t] : 'bg-border/20'}`}>
        {cell?.text}
      </td>
    </>
  )
}
