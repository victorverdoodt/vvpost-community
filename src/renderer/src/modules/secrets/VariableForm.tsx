import { useState } from 'react'
import type { ProjectEdit, SecretInventory } from '@shared/ipc'
import { Button, controlClass } from '../../design-system'

type Variable = SecretInventory['environments'][number]['variables'][number]
type VariableType = Variable['type']

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** O valor digitado no tipo escolhido, ou o motivo para recusar. */
function parseValue(type: VariableType, text: string): { value: string | number | boolean } | { problem: string } {
  if (type === 'number') {
    const n = Number(text.replace(',', '.'))
    return text.trim() !== '' && Number.isFinite(n) ? { value: n } : { problem: 'Digite um número.' }
  }
  if (type === 'boolean') return { value: text === 'true' }
  return { value: text }
}

/**
 * Criar ou editar uma variável de um ambiente: nome, tipo,
 * valor, isSecret e descrição. O valor de um segredo vai para o vault local e o arquivo versionado
 * fica com __REQUIRED_SECRET__; o valor de um segredo que já existe não aparece nem é trocado
 * aqui (isso é "Substituir valor", com confirmação).
 */
export function VariableForm(props: {
  environment: { id: string; name: string }
  /** undefined cria uma variável nova. */
  variable?: Variable
  taken: readonly string[]
  onSave: (op: Extract<ProjectEdit, { op: 'setVariable' }>) => Promise<boolean>
  onCancel: () => void
}) {
  const current = props.variable
  const [name, setName] = useState(current?.name ?? '')
  const [type, setType] = useState<VariableType>(current?.type ?? 'string')
  const [secret, setSecret] = useState(current?.isSecret ?? false)
  const [text, setText] = useState(current?.value === undefined ? '' : String(current.value))
  const [description, setDescription] = useState(current?.description ?? '')
  const [saving, setSaving] = useState(false)

  // Valor oculto (segredo ou nome de credencial): vazio mantém o que está lá.
  const hidden = !!current && current.value === undefined
  // Um segredo que continua segredo: o valor fica no vault e muda por "Substituir valor".
  const keepsSecret = !!current?.isSecret && secret
  const parsed = parseValue(secret ? 'string' : type, text)
  const problem = !NAME.test(name)
    ? 'Use letras, dígitos e _, sem começar por dígito.'
    : !current && props.taken.includes(name)
      ? `${name} já existe em ${props.environment.name}.`
      : !keepsSecret && !(hidden && text === '') && 'problem' in parsed
        ? parsed.problem
        : null

  const save = async () => {
    if (problem) return
    setSaving(true)
    try {
      const keep = keepsSecret || (hidden && text === '')
      const ok = await props.onSave({
        op: 'setVariable',
        environmentId: props.environment.id,
        name,
        secret,
        overwrite: true,
        ...(!keep && 'value' in parsed && { value: parsed.value }),
        ...(description.trim() && { description: description.trim() })
      })
      if (ok) props.onCancel()
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-3 text-xs"
      aria-label={current ? `Editar a variável ${current.name}` : 'Nova variável'}
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-muted">Nome</span>
        <input
          aria-label="Nome da variável"
          className={`${controlClass} font-mono`}
          value={name}
          disabled={!!current}
          autoFocus={!current}
          spellCheck={false}
          placeholder="BASE_URL"
          onChange={(e) => setName(e.target.value.trim())}
        />
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          aria-label="Segredo (isSecret)"
          checked={secret}
          onChange={(e) => setSecret(e.target.checked)}
        />
        Segredo (isSecret): o valor fica no vault local, fora do Git
      </label>
      {!secret && (
        <label className="flex flex-col gap-1">
          <span className="text-muted">Tipo</span>
          <select
            aria-label="Tipo da variável"
            className={controlClass}
            value={type}
            onChange={(e) => setType(e.target.value as VariableType)}
          >
            <option value="string">Texto</option>
            <option value="number">Número</option>
            <option value="boolean">Sim ou não</option>
          </select>
        </label>
      )}
      {keepsSecret ? (
        <p className="text-muted">O valor continua no vault local. Para trocá-lo, use Substituir valor no segredo.</p>
      ) : (
        <label className="flex flex-col gap-1">
          <span className="text-muted">{secret ? 'Valor (vai para o vault local)' : 'Valor'}</span>
          {!secret && type === 'boolean' ? (
            <select
              aria-label="Valor da variável"
              className={controlClass}
              value={text === 'true' ? 'true' : 'false'}
              onChange={(e) => setText(e.target.value)}
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : (
            <input
              aria-label="Valor da variável"
              className={`${controlClass} font-mono`}
              type={secret || hidden ? 'password' : 'text'}
              autoComplete="off"
              value={text}
              placeholder={hidden ? 'vazio mantém o valor atual' : secret ? 'valor do segredo' : ''}
              onChange={(e) => setText(e.target.value)}
            />
          )}
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-muted">Descrição</span>
        <input
          aria-label="Descrição da variável"
          className={controlClass}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      {problem && name && <p className="text-danger">{problem}</p>}
      <div className="flex gap-2">
        <Button size="sm" variant="primary" type="submit" disabled={!!problem || saving}>
          {current ? 'Salvar variável' : 'Criar variável'}
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          Cancelar
        </Button>
      </div>
    </form>
  )
}
