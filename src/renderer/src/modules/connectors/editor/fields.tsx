import { useEffect, useId, useState, type ReactNode } from 'react'
import type { RequestScripts } from '@shared/ipc'
import { buttonClass } from '../../../design-system'

/** Sem largura: quem usa decide (w-full nos campos de formulário, larguras fixas nas linhas). */
export const fieldClass = 'border px-2 py-1 text-xs'
export const inputClass = `w-full ${fieldClass}`
export const smallButton = buttonClass('secondary', 'sm')

/** Campo de texto com rótulo. Vazio vira undefined, para o campo sair do arquivo. */
export function TextField(props: {
  label: string
  value: string | undefined
  onChange: (value: string | undefined) => void
  placeholder?: string
  mono?: boolean
  required?: boolean
  multiline?: boolean
  hint?: string
}) {
  const id = useId()
  const set = (v: string) => props.onChange(v === '' && !props.required ? undefined : v)
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted">
        {props.label}
        {props.required && ' *'}
      </label>
      {props.multiline ? (
        <textarea
          id={id}
          className={`${inputClass} h-20 resize-y ${props.mono ? 'font-mono' : ''}`}
          value={props.value ?? ''}
          placeholder={props.placeholder}
          onChange={(e) => set(e.target.value)}
        />
      ) : (
        <input
          id={id}
          className={`${inputClass} ${props.mono ? 'font-mono' : ''}`}
          value={props.value ?? ''}
          placeholder={props.placeholder}
          onChange={(e) => set(e.target.value)}
        />
      )}
      {props.hint && <span className="text-[11px] text-muted">{props.hint}</span>}
    </div>
  )
}

export function SelectField<T extends string>(props: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted">
        {props.label}
      </label>
      <select id={id} className={inputClass} value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

type Row = { name: string; value: string | null }

/**
 * Pares nome/valor (headers, query, parâmetros de rota). Com `allowRemove`, cada
 * linha pode virar null, que nos cenários tira o valor herdado.
 */
export function KeyValueEditor(props: {
  label: string
  value: Record<string, string | null> | undefined
  onChange: (value: Record<string, string | null> | undefined) => void
  allowRemove?: boolean
  namePlaceholder?: string
  valuePlaceholder?: string
}) {
  // Linhas locais: permitem nome vazio e repetido enquanto o usuário digita.
  const [rows, setRows] = useState<Row[]>(() => toRows(props.value))
  const serialized = JSON.stringify(props.value ?? {})
  useEffect(() => {
    if (JSON.stringify(fromRows(rows) ?? {}) !== serialized) setRows(toRows(props.value))
  }, [serialized])

  const update = (next: Row[]) => {
    setRows(next)
    props.onChange(fromRows(next))
  }
  return (
    <fieldset className="flex flex-col gap-1" aria-label={props.label}>
      <legend className="mb-1 text-xs text-muted">{props.label}</legend>
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-1">
          <input
            aria-label={`${props.label}: nome ${i + 1}`}
            className={`${fieldClass} w-1/3 font-mono`}
            placeholder={props.namePlaceholder ?? 'nome'}
            value={row.name}
            onChange={(e) => update(rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
          />
          {row.value === null ? (
            <span className="flex-1 px-2 text-xs text-warning">removido</span>
          ) : (
            <input
              aria-label={`${props.label}: valor ${i + 1}`}
              className={`${fieldClass} min-w-0 flex-1 font-mono`}
              placeholder={props.valuePlaceholder ?? 'valor ou {{VAR}}'}
              value={row.value}
              onChange={(e) => update(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
            />
          )}
          {props.allowRemove && (
            <button
              type="button"
              className={smallButton}
              title={row.value === null ? 'Voltar a definir um valor' : 'Tirar o valor herdado nesta requisição'}
              onClick={() => update(rows.map((r, j) => (j === i ? { ...r, value: r.value === null ? '' : null } : r)))}
            >
              {row.value === null ? 'Definir' : 'Remover herdado'}
            </button>
          )}
          <button
            type="button"
            className={smallButton}
            aria-label={`Apagar linha ${i + 1} de ${props.label}`}
            onClick={() => update(rows.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className={`${smallButton} self-start`}
        onClick={() => update([...rows, { name: '', value: '' }])}
      >
        + {props.label}
      </button>
    </fieldset>
  )
}

function toRows(value: Record<string, string | null> | undefined): Row[] {
  return Object.entries(value ?? {}).map(([name, v]) => ({ name, value: v }))
}

function fromRows(rows: Row[]): Record<string, string | null> | undefined {
  const named = rows.filter((r) => r.name.trim())
  return named.length ? Object.fromEntries(named.map((r) => [r.name.trim(), r.value])) : undefined
}

/**
 * JSON editável (corpo, bodySchema, valor esperado). Texto inválido não chega ao
 * modelo: `onValidity` avisa o formulário para segurar o salvamento.
 */
export function JsonField(props: {
  label: string
  value: unknown
  onChange: (value: unknown) => void
  onValidity?: (valid: boolean) => void
  hint?: string
  rows?: number
}) {
  const id = useId()
  const show = (v: unknown) => (v === undefined ? '' : JSON.stringify(v, null, 2))
  const [text, setText] = useState(() => show(props.value))
  const [error, setError] = useState<string | null>(null)
  const serialized = JSON.stringify(props.value)
  useEffect(() => {
    // Mudança vinda de fora (outro item selecionado): reescreve o texto.
    let current: unknown
    try {
      current = text.trim() ? JSON.parse(text) : undefined
    } catch {
      current = Symbol()
    }
    if (JSON.stringify(current) !== serialized) {
      setText(show(props.value))
      setError(null)
      props.onValidity?.(true)
    }
  }, [serialized])

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted">
        {props.label}
      </label>
      <textarea
        id={id}
        spellCheck={false}
        className={`${inputClass} resize-y font-mono`}
        style={{ height: `${(props.rows ?? 5) * 1.25 + 0.75}rem` }}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          if (!e.target.value.trim()) {
            setError(null)
            props.onValidity?.(true)
            return props.onChange(undefined)
          }
          try {
            const parsed: unknown = JSON.parse(e.target.value)
            setError(null)
            props.onValidity?.(true)
            props.onChange(parsed)
          } catch (err) {
            setError((err as Error).message)
            props.onValidity?.(false)
          }
        }}
      />
      {error ? (
        <span className="text-[11px] text-danger">JSON inválido: {error}</span>
      ) : (
        props.hint && <span className="text-[11px] text-muted">{props.hint}</span>
      )}
    </div>
  )
}

/**
 * Scripts pre e post (fase 13), do conector ou do endpoint: JavaScript com a API vv, que roda em
 * toda requisição dele (no Quick Request, nos cenários e nos fluxos). Vazios saem do arquivo.
 */
export function ScriptsField(props: { scope: string; value: RequestScripts | undefined; onChange: (value: RequestScripts | undefined) => void }) {
  const count = (props.value?.pre?.trim() ? 1 : 0) + (props.value?.post?.trim() ? 1 : 0)
  const set = (patch: RequestScripts) => {
    const next = { ...props.value, ...patch }
    props.onChange(next.pre || next.post ? next : undefined)
  }
  return (
    <details open={count > 0}>
      <summary className="cursor-pointer text-muted">Scripts {props.scope}{count ? ` (${count})` : ''}</summary>
      <div className="mt-2 grid grid-cols-2 gap-3">
        <TextField
          label="Antes do envio (pre)"
          multiline
          mono
          value={props.value?.pre}
          onChange={(pre) => set({ pre })}
          placeholder="vv.request.headers['X-Tenant'] = vv.variables.get('TENANT')"
        />
        <TextField
          label="Depois da resposta (post)"
          multiline
          mono
          value={props.value?.post}
          onChange={(post) => set({ post })}
          placeholder="vv.test('status 200', () => vv.expect(vv.response.status).to.equal(200))"
          hint="Os do conector rodam antes dos do endpoint e dos da requisição."
        />
      </div>
    </details>
  )
}

export function Section(props: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{props.title}</h3>
        <span className="ml-auto" />
        {props.actions}
      </div>
      {props.children}
    </section>
  )
}

/** Valores do usuário que vão para o arquivo como foram escritos, sem limpeza. */
const OPAQUE = new Set(['body', 'bodySchema', 'expected', 'json'])

/**
 * Tira chaves undefined e objetos que ficaram vazios (headers sem linhas, auth sem
 * campos), para o arquivo não ganhar campos vazios. Corpos, schemas e valores
 * esperados ficam como o usuário escreveu.
 */
export function prune<T>(value: T): T {
  if (Array.isArray(value)) return value.map(prune) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue
      if (OPAQUE.has(k)) {
        out[k] = v
        continue
      }
      const p = prune(v)
      if (p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length === 0) continue
      out[k] = p
    }
    return out as T
  }
  return value
}
