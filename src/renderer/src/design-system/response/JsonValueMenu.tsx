import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Braces, ChevronsDownUp, ChevronsUpDown, Copy, Filter, ListPlus, Route, Variable } from 'lucide-react'
import { useToast } from '../feedback/Toast'
import { Button, controlClass } from '../primitives/Button'
import type { ContextMenuEntry } from '../navigation/ContextMenu'
import { variableNameFor } from './json-locate'
import { toJsonPath, type JsonPathKey } from './jsonpath'

/** Ações que dependem de quem mostra o JSON (Quick Request: ambiente selecionado e abas). */
export interface JsonValueActions {
  /** Ambiente que recebe "Usar como variável"; null desabilita a ação (com o motivo na dica). */
  variableTarget: { environmentId: string; label: string } | null
  /** Grava a variável; devolve a mensagem de erro, ou null quando deu certo. */
  useAsVariable(name: string, value: string | number | boolean): Promise<string | null>
  /** Abre a próxima requisição com o valor no body. */
  insertIntoNextRequest(value: unknown): void
}

export type JsonValueCommand = 'copy-value' | 'copy-path' | 'use-as-variable' | 'insert-next'

/** Atalhos do menu, também ativos com um valor selecionado. */
export function jsonCommandFor(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): JsonValueCommand | null {
  if (!(e.ctrlKey || e.metaKey)) return null
  const key = e.key.toLowerCase()
  if (key === 'c' && e.altKey && !e.shiftKey) return 'copy-path'
  if (key === 'c' && !e.altKey && !e.shiftKey) return 'copy-value'
  if (key === 'v' && e.shiftKey && !e.altKey) return 'use-as-variable'
  if (key === 'i' && e.shiftKey && !e.altKey) return 'insert-next'
  return null
}

/** Texto de um valor para copiar: strings sem aspas, o resto como JSON formatado. */
export function valueText(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? 'null')
}

/**
 * Itens do menu de um valor JSON (o DataPicker da resposta e do body da request), no menu de
 * contexto do design system: copiar valor e path, usar como variável do ambiente, inserir na
 * próxima requisição e, onde o JSON é navegável, expandir e recolher tudo. Abre por clique ou
 * botão direito no valor; com o valor selecionado, os atalhos funcionam sem abrir o menu.
 */
export function jsonValueEntries(props: {
  actions?: JsonValueActions
  run: (command: Exclude<JsonValueCommand, 'use-as-variable'>) => void
  onUseAsVariable: () => void
  onFilter?: () => void
  onExpandAll?: () => void
  onCollapseAll?: () => void
}): ContextMenuEntry[] {
  const target = props.actions?.variableTarget
  const entries: ContextMenuEntry[] = [
    { type: 'header', id: 'value', label: 'Ações do valor', icon: <Braces size={11} aria-hidden /> },
    { id: 'copy-value', label: 'Copiar valor', icon: <Copy size={14} />, shortcut: 'Mod+C', run: () => props.run('copy-value') },
    { id: 'copy-path', label: 'Copiar path', icon: <Route size={14} />, shortcut: 'Mod+Alt+C', run: () => props.run('copy-path') },
    {
      id: 'use-as-variable',
      label: target ? `Usar como variável (${target.label})` : 'Usar como variável (escolha um ambiente)',
      icon: <Variable size={14} />,
      shortcut: 'Mod+Shift+V',
      disabled: !target,
      run: props.onUseAsVariable
    },
    {
      id: 'insert-next',
      label: 'Inserir na próxima requisição',
      icon: <ListPlus size={14} />,
      shortcut: 'Mod+Shift+I',
      disabled: !props.actions,
      run: () => props.run('insert-next')
    }
  ]
  if (props.onFilter) entries.push({ id: 'filter', label: 'Filtrar por este path', icon: <Filter size={14} />, run: props.onFilter })
  if (props.onExpandAll && props.onCollapseAll) {
    entries.push(
      { type: 'header', id: 'navigation', label: 'Navegação no JSON', icon: <Braces size={11} aria-hidden /> },
      { id: 'expand-all', label: 'Expandir tudo', icon: <ChevronsUpDown size={14} />, run: props.onExpandAll },
      { id: 'collapse-all', label: 'Recolher tudo', icon: <ChevronsDownUp size={14} />, run: props.onCollapseAll }
    )
  }
  return entries
}

/** "Usar como variável": o nome (sugerido pelo caminho) e o ambiente que recebe o valor. */
export function VariableDialog(props: {
  at: { x: number; y: number }
  path: JsonPathKey[]
  value: unknown
  actions: JsonValueActions
  onClose: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(props.at)
  const [name, setName] = useState(() => variableNameFor(props.path))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const valid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
  const preview = valueText(props.value)
  const target = props.actions.variableTarget

  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect()
    if (r) setPos({ x: Math.max(4, Math.min(props.at.x, innerWidth - r.width - 4)), y: Math.max(4, Math.min(props.at.y, innerHeight - r.height - 4)) })
  }, [props.at])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) props.onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [props.onClose]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!target) return null
  return (
    <div
      ref={box}
      role="dialog"
      aria-label="Usar como variável"
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          props.onClose()
        }
      }}
      className="fixed z-[60] w-72 rounded-[var(--radius-card)] border border-border bg-panel p-1 text-xs shadow-[var(--shadow-overlay)]"
    >
      <form
        className="flex flex-col gap-2 p-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!valid || saving) return
          setSaving(true)
          const scalar = typeof props.value === 'object' && props.value !== null ? JSON.stringify(props.value) : (props.value ?? 'null')
          void props.actions.useAsVariable(name, scalar as string | number | boolean).then((err) => {
            setSaving(false)
            if (err) setError(err)
            else props.onClose()
          })
        }}
      >
        <p className="truncate font-mono text-[11px] text-faint" title={toJsonPath(props.path)}>
          {toJsonPath(props.path)}
        </p>
        <label className="flex flex-col gap-1 text-muted">
          Nome da variável no ambiente {target.label}
          <input
            autoFocus
            aria-label="Nome da variável"
            aria-invalid={!valid || undefined}
            className={`${controlClass} font-mono text-fg`}
            value={name}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <p className="truncate font-mono text-[11px] text-muted" title={preview}>
          = {preview.length > 80 ? `${preview.slice(0, 80)}…` : preview}
        </p>
        <p className="text-[11px] text-muted">Nomes sensíveis (token, senha, chave) vão só para o vault local, fora do Git.</p>
        {error && (
          <p role="alert" className="text-[11px] text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={props.onClose}>
            Cancelar
          </Button>
          <Button size="sm" variant="primary" type="submit" disabled={!valid || saving}>
            Salvar variável
          </Button>
        </div>
      </form>
    </div>
  )
}

/** Executa um comando do menu (também pelos atalhos com o valor selecionado, sem menu). */
export function useJsonCommand(actions?: JsonValueActions) {
  const notify = useToast()
  return (command: Exclude<JsonValueCommand, 'use-as-variable'>, path: JsonPathKey[], value: unknown) => {
    if (command === 'insert-next') {
      actions?.insertIntoNextRequest(value)
      return
    }
    const text = command === 'copy-path' ? toJsonPath(path) : valueText(value)
    void navigator.clipboard.writeText(text).then(() => notify(command === 'copy-path' ? 'Path copiado' : 'Valor copiado', 'success'))
  }
}
