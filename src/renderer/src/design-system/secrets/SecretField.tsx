import { useEffect, useId, useState } from 'react'
import { Copy, Eye, KeyRound, Lock } from 'lucide-react'
import { Button } from '../primitives/Button'

/**
 * Valor de segredo mascarado (contrato do design system). Nunca recebe o valor: mostra só se ele
 * existe. Revelar e copiar só aparecem quando quem usa passa `onReveal`/`onCopy`, ou seja, quando
 * o mecanismo de autorização permite; sem eles, o campo diz por quê. `onSet` grava um valor novo
 * sem que ele volte para a interface.
 */
export function SecretField(props: {
  label: string
  /** Há valor guardado (o valor em si nunca chega aqui). */
  hasValue: boolean
  /** Explica por que revelar não está disponível. */
  revealPolicy?: string
  onReveal?: () => void
  onCopy?: () => void
  onSet?: (value: string) => Promise<void>
  placeholder?: string
  /** Muda para abrir o campo de valor novo de fora (menu de contexto "Definir valor"). */
  editRequest?: number
}) {
  const id = useId()
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (props.editRequest) setEditing(true)
  }, [props.editRequest])
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  if (editing && props.onSet) {
    const save = async () => {
      setSaving(true)
      try {
        await props.onSet!(value)
        setEditing(false)
        setValue('')
      } finally {
        setSaving(false)
      }
    }
    return (
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (value) void save()
        }}
      >
        <label htmlFor={id} className="text-[11px] text-muted">
          Novo valor de {props.label}
        </label>
        <input
          id={id}
          type="password"
          autoComplete="off"
          autoFocus
          value={value}
          placeholder={props.placeholder}
          onChange={(e) => setValue(e.target.value)}
          className="h-8 border px-2 font-mono text-xs"
        />
        <div className="flex gap-2">
          <Button size="sm" variant="primary" type="submit" disabled={!value || saving}>
            Salvar no vault local
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancelar
          </Button>
        </div>
      </form>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-8 items-center gap-2 rounded-[var(--radius-control)] border border-border bg-surface px-2 font-mono text-xs">
        <Lock size={13} className="shrink-0 text-muted" aria-hidden />
        <span
          className={props.hasValue ? 'tracking-widest text-muted' : 'text-faint'}
          aria-label={props.hasValue ? 'valor mascarado' : 'sem valor'}
        >
          {props.hasValue ? '••••••••••••' : 'sem valor'}
        </span>
        <span className="flex-1" />
        {props.onReveal || props.onCopy ? (
          <>
            {props.onReveal && (
              <Button size="sm" variant="ghost" icon={<Eye size={13} aria-hidden />} onClick={props.onReveal}>
                Revelar
              </Button>
            )}
            {props.onCopy && (
              <Button size="sm" variant="ghost" icon={<Copy size={13} aria-hidden />} onClick={props.onCopy}>
                Copiar
              </Button>
            )}
          </>
        ) : (
          props.revealPolicy && (
            <span className="font-sans text-[11px] text-faint" title={props.revealPolicy}>
              revelar indisponível
            </span>
          )
        )}
      </div>
      {props.revealPolicy && !props.onReveal && !props.onCopy && <p className="text-[11px] text-muted">{props.revealPolicy}</p>}
      {props.onSet && (
        <Button size="sm" icon={<KeyRound size={13} aria-hidden />} onClick={() => setEditing(true)}>
          {props.hasValue ? 'Substituir valor' : 'Definir valor'}
        </Button>
      )}
    </div>
  )
}
