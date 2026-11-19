import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CircleCheck,
  Copy,
  Eye,
  EyeOff,
  FolderOpen,
  KeyRound,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import type { ProjectEdit, SecretInventory, SecretState, WorkspaceResult } from '@shared/ipc'
import { useServices } from '../../app/shell/useAppServices'
import {
  Badge,
  Button,
  ContextSelector,
  cx,
  EmptyState,
  ErrorNotice,
  Field,
  InspectorPanel,
  InspectorSection,
  SecretField,
  separator,
  Shortcut,
  table,
  useContextMenu,
  useMenuCommands,
  usePromptDialog,
  useToast,
  type ContextMenuEntries,
  type Tone
} from '../../design-system'
import { copyText } from '../../lib/clipboard'
import { useNavigation } from '../../lib/navigate'
import { WORKSPACE_CHANGED } from '../../panels/useWorkspace'
import { VariableForm } from './VariableForm'

const STATE: Record<SecretState, { label: string; tone: Tone; hint: string }> = {
  configured: {
    label: 'Configurado',
    tone: 'success',
    hint: 'Valor no vault local; o arquivo versionado guarda só __REQUIRED_SECRET__.'
  },
  missing: {
    label: 'Pendente',
    tone: 'warning',
    hint: 'O ambiente pede este segredo e o vault local ainda não tem valor.'
  },
  plaintext: {
    label: 'Texto puro',
    tone: 'danger',
    hint: 'Marcado como segredo, mas o valor está no arquivo versionado. O próximo commit pelo app redige.'
  },
  unmarked: {
    label: 'Sem isSecret',
    tone: 'danger',
    hint: 'Nome de credencial com valor no arquivo versionado e sem isSecret: vai para o Git como está.'
  }
}

const TYPE_LABEL = { string: 'texto', number: 'número', boolean: 'sim ou não' } as const

const REVEAL_POLICY =
  'Só valores do vault local podem ser revelados ou copiados, sempre com confirmação. Um valor no arquivo versionado está à vista nele.'
/** Quanto tempo um valor revelado fica na tela. */
const REVEAL_MS = 10_000

/**
 * Secrets: ambiente, disponibilidade, origem e acesso aos
 * segredos, sem expor nenhum valor. O estado do Secrets Engine vem do shell (a mesma fonte da
 * barra de status).
 */
export default function SecretsModule() {
  const services = useServices()
  const notify = useToast()
  const [result, setResult] = useState<WorkspaceResult<SecretInventory | null> | null>(null)
  const [envId, setEnvId] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  /** Valor revelado (por REVEAL_MS); some ao trocar de segredo ou de ambiente. */
  const [revealed, setRevealed] = useState<{ key: string; value: string; until: number } | null>(null)
  const [editRequest, setEditRequest] = useState(0)
  /** Variável no formulário do inspector: '' cria uma nova; null fecha o formulário. */
  const [editing, setEditing] = useState<string | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout>>()
  const ctx = useContextMenu()
  const dialog = usePromptDialog()

  // Várias leituras correm juntas (a do edit, o WORKSPACE_CHANGED, o foco da janela): vale a última
  // pedida. Sem isso, uma resposta antiga chegando depois voltava o nome de antes de renomear e o
  // Excluir ambiente perguntava pelo ambiente com o nome velho.
  const lastRead = useRef(0)
  const reload = useCallback(() => {
    const read = ++lastRead.current
    void window.vvpost.getSecretInventory().then((r) => {
      if (read === lastRead.current) setResult(r)
    })
  }, [])

  useEffect(() => {
    reload()
    window.addEventListener('focus', reload)
    window.addEventListener(WORKSPACE_CHANGED, reload)
    return () => {
      window.removeEventListener('focus', reload)
      window.removeEventListener(WORKSPACE_CHANGED, reload)
    }
  }, [reload])

  const inventory = result?.ok ? result.value : null
  const env = inventory?.environments.find((e) => e.id === envId) ?? inventory?.environments[0] ?? null
  const secret = env?.secrets.find((s) => s.variable === selected) ?? null
  const counts = useMemo(() => {
    const c: Record<SecretState, number> = { configured: 0, missing: 0, plaintext: 0, unmarked: 0 }
    for (const s of env?.secrets ?? []) c[s.state]++
    return c
  }, [env])

  const engine = services.engine
  const engineRunning = engine?.status === 'running'
  const engineLabel = engineRunning
    ? `Local Mock em :${engine.port}${engine.environment ? ` · ${engine.environment}` : ''}`
    : engine?.status === 'starting'
      ? 'Iniciando…'
      : engine?.status === 'error'
        ? (engine.message ?? 'Erro')
        : 'Desligado'

  const open = () =>
    void window.vvpost.openWorkspace().then((r) => {
      if (r.ok && r.value) window.dispatchEvent(new Event(WORKSPACE_CHANGED))
      reload()
    })

  /** Ambientes e variáveis pela mesma camada em lote do projeto; os outros módulos releem o workspace. */
  const edit = async (ops: ProjectEdit[], done: string): Promise<boolean> => {
    const r = await window.vvpost.editProject(ops)
    if (!r.ok) {
      notify(r.message, 'danger')
      return false
    }
    notify(done, 'success')
    reload()
    window.dispatchEvent(new Event(WORKSPACE_CHANGED))
    return true
  }

  const slug = (name: string) =>
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
  const createEnvironment = async () => {
    const taken = new Set(inventory?.environments.map((e) => e.id))
    const name = await dialog.prompt({
      title: 'Novo ambiente',
      label: 'Nome',
      confirmLabel: 'Criar',
      validate: (v) =>
        slug(v)
          ? taken.has(`env.${slug(v)}`)
            ? `env.${slug(v)} já existe.`
            : undefined
          : 'Use ao menos uma letra ou dígito.'
    })
    if (!name) return
    const id = `env.${slug(name)}`
    if (
      await edit([{ op: 'upsertEnvironment', environment: { id, name } }], `Ambiente ${name} criado em environments/.`)
    ) {
      setEnvId(id)
      setSelected(null)
    }
  }
  const renameEnvironment = async () => {
    if (!env) return
    const name = await dialog.prompt({ title: `Renomear ${env.name}`, label: 'Nome', initial: env.name })
    if (name && name !== env.name)
      await edit([{ op: 'upsertEnvironment', environment: { id: env.id, name } }], `Ambiente renomeado para ${name}.`)
  }
  const deleteEnvironment = async () => {
    if (!env) return
    const ok = await dialog.confirm({
      title: `Excluir o ambiente ${env.name}?`,
      message: `O arquivo ${env.file} é apagado, com as ${env.variables.length} variáveis. Os valores do vault local de ${env.name} continuam em ${inventory?.storeFile}.`,
      confirmLabel: 'Excluir',
      danger: true
    })
    if (ok && (await edit([{ op: 'deleteEnvironment', id: env.id }], `Ambiente ${env.name} excluído.`))) setEnvId('')
  }
  const deleteVariable = async (name: string) => {
    if (!env) return
    const ok = await dialog.confirm({
      title: `Excluir a variável ${name}?`,
      message: `Requisições, cenários e fluxos que usam {{${name}}} em ${env.name} deixam de ter valor para ela.`,
      confirmLabel: 'Excluir',
      danger: true
    })
    if (
      ok &&
      (await edit([{ op: 'deleteVariable', environmentId: env.id, name }], `${name} excluída de ${env.name}.`))
    ) {
      if (selected === name) setSelected(null)
      if (editing === name) setEditing(null)
    }
  }

  /** Alterar secret: escopo e impacto antes, sem o valor antigo aparecer. */
  const replaceValue = async (variable: string, value: string) => {
    if (!env) return
    const ok = await dialog.confirm({
      title: `Substituir o valor de ${variable} em ${env.name}?`,
      message: `O valor atual do vault local é trocado e não dá para recuperá-lo pelo app. Requisições, cenários e fluxos que usam {{${variable}}} em ${env.name} passam a usar o novo, e os tokens em cache são descartados.`,
      confirmLabel: 'Substituir',
      danger: true
    })
    if (!ok) return
    const r = await window.vvpost.replaceSecret({ environmentId: env.id, variable, value })
    if (r.ok) notify(`${variable} substituído no vault local de ${env.name}.`, 'success')
    else notify(r.message, 'danger')
    setRevealed(null)
    reload()
  }

  const setValue = async (variable: string, value: string) => {
    if (!env) return
    const r = await window.vvpost.saveSecrets([{ environmentId: env.id, variable, value }])
    if (r.ok) notify(`${variable} gravado no vault local de ${env.name}.`, 'success')
    else notify(r.message, 'danger')
    reload()
  }

  useNavigation('secrets', (t) => {
    if (t.environmentId) setEnvId(t.environmentId)
    if (t.variable) setSelected(t.variable)
  })
  const keyOf = (environmentId: string, variable: string) => `${environmentId}/${variable}`
  useEffect(() => {
    if (revealed && revealed.key !== keyOf(env?.id ?? '', selected ?? '')) setRevealed(null)
  }, [env?.id, selected, revealed])
  useEffect(() => () => clearTimeout(hideTimer.current), [])

  const reveal = async (variable: string) => {
    if (!env) return
    const ok = await dialog.confirm({
      title: `Revelar ${variable}?`,
      message: `O valor de ${env.name} aparece no inspector por ${REVEAL_MS / 1000} segundos. Confira se ninguém está vendo a sua tela.`,
      confirmLabel: 'Revelar'
    })
    if (!ok) return
    const r = await window.vvpost.revealSecret(env.id, variable, false)
    if (!r.ok || r.value.value === undefined) return notify(r.ok ? 'Sem valor no vault local.' : r.message, 'danger')
    setSelected(variable)
    setRevealed({ key: keyOf(env.id, variable), value: r.value.value, until: Date.now() + REVEAL_MS })
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setRevealed(null), REVEAL_MS)
  }
  const copyValue = async (variable: string) => {
    if (!env) return
    const ok = await dialog.confirm({
      title: `Copiar o valor de ${variable}?`,
      message:
        'O valor vai para a área de transferência sem passar pela tela e é apagado dela em 30 segundos, se ainda estiver lá.',
      confirmLabel: 'Copiar'
    })
    if (!ok) return
    const r = await window.vvpost.revealSecret(env.id, variable, true)
    notify(
      r.ok ? `${variable} copiado; a área de transferência é limpa em 30 s.` : r.message,
      r.ok ? 'success' : 'danger'
    )
  }
  const copy = (text: string, what: string) =>
    void copyText(text, what).then(
      (m) => notify(m, 'success'),
      () => notify('Não deu para copiar.', 'danger')
    )
  const revealFile = (path: string) =>
    void window.vvpost.revealInFolder({ workspacePath: path }).then((r) => !r.ok && notify(r.message, 'danger'))

  const secretEntries = (s: { variable: string; state: SecretState }): ContextMenuEntries => [
    {
      id: 'copy-ref',
      label: `Copiar a referência {{${s.variable}}}`,
      icon: <Copy size={14} aria-hidden />,
      shortcut: Shortcut.copy,
      run: () => copy(`{{${s.variable}}}`, 'Referência copiada')
    },
    s.state === 'missing' && {
      id: 'set',
      label: 'Definir valor…',
      icon: <KeyRound size={14} aria-hidden />,
      run: () => {
        setSelected(s.variable)
        setEditRequest((n) => n + 1)
      }
    },
    s.state === 'configured' && {
      id: 'reveal',
      label: 'Revelar valor…',
      icon: <Eye size={14} aria-hidden />,
      run: () => void reveal(s.variable)
    },
    s.state === 'configured' && {
      id: 'copy-value',
      label: 'Copiar valor…',
      icon: <KeyRound size={14} aria-hidden />,
      run: () => void copyValue(s.variable)
    },
    separator,
    env && {
      id: 'reveal-env',
      label: 'Revelar o arquivo do ambiente',
      icon: <FolderOpen size={14} aria-hidden />,
      shortcut: Shortcut.reveal,
      run: () => revealFile(env.file)
    },
  ]
  useMenuCommands(
    'Secrets',
    secret
      ? secretEntries(secret).map((e) =>
          e && typeof e === 'object' && 'label' in e && 'id' in e
            ? { ...e, label: `${secret.variable}: ${e.label}` }
            : e
        )
      : [],
    { shortcuts: true }
  )
  const shownValue = secret && env && revealed?.key === keyOf(env.id, secret.variable) ? revealed.value : null

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-end gap-4 border-b border-border px-4 py-3">
          {!inventory ? (
            <div className="flex items-center gap-3 text-xs text-muted">
              <Button size="sm" icon={<FolderOpen size={14} aria-hidden />} onClick={open}>
                Abrir workspace…
              </Button>
              {result && !result.ok && <span className="text-danger">{result.message}</span>}
            </div>
          ) : (
            <ContextSelector
              label="Escopo dos segredos"
              fields={[
                {
                  label: 'Ambiente',
                  ariaLabel: 'Ambiente dos segredos',
                  value: env?.id ?? '',
                  status: env
                    ? counts.missing
                      ? 'warn'
                      : counts.plaintext + counts.unmarked
                        ? 'error'
                        : 'ok'
                    : undefined,
                  onChange: (id) => {
                    setEnvId(id)
                    setSelected(null)
                    setEditing(null)
                  },
                  options: inventory.environments.map((e) => ({ value: e.id, label: e.name }))
                }
              ]}
            />
          )}
          {inventory && (
            <div className="flex items-center gap-1">
              <Button size="sm" icon={<Plus size={14} aria-hidden />} onClick={() => void createEnvironment()}>
                Novo ambiente
              </Button>
              {env && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Pencil size={14} aria-hidden />}
                    disabled={!!env.problem}
                    onClick={() => void renameEnvironment()}
                  >
                    Renomear
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 size={14} aria-hidden />}
                    disabled={!!env.problem}
                    onClick={() => void deleteEnvironment()}
                  >
                    Excluir ambiente
                  </Button>
                </>
              )}
            </div>
          )}
          <div className="ml-auto flex h-8 items-center gap-2 rounded-[var(--radius-control)] border border-border bg-elevated px-2.5 text-xs">
            <KeyRound size={14} className={engineRunning ? 'text-success' : 'text-muted'} aria-hidden />
            <span>Secrets Engine</span>
            <Badge tone={engineRunning ? 'success' : engine?.status === 'error' ? 'danger' : 'neutral'}>
              {engineLabel}
            </Badge>
            <Button
              size="sm"
              variant="ghost"
              disabled={services.busy !== null || engine?.status === 'starting'}
              onClick={services.toggleEngine}
            >
              {engineRunning ? 'Desligar' : 'Ligar mock'}
            </Button>
          </div>
        </div>

        {!inventory ? (
          <EmptyState
            icon={<KeyRound size={20} aria-hidden />}
            title="Nenhum workspace aberto"
            description="Abra o workspace para ver os segredos de cada ambiente."
          />
        ) : !env ? (
          <EmptyState
            icon={<KeyRound size={20} aria-hidden />}
            title="Nenhum ambiente no workspace"
            description="Ambientes são arquivos environments/*.env.json; variáveis com isSecret ficam aqui."
          >
            <Button size="sm" icon={<Plus size={14} aria-hidden />} onClick={() => void createEnvironment()}>
              Novo ambiente
            </Button>
          </EmptyState>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            {env.secrets.length === 0 ? (
              <p className="flex items-center gap-2 px-4 py-3 text-xs text-muted">
                <CircleCheck size={14} className="text-success" aria-hidden />
                {env.name} não tem segredos. Marque uma variável como segredo para guardá-la fora do Git.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-3 px-4 py-2 text-xs text-muted" aria-label="Resumo dos segredos">
                  <span className="text-success">{counts.configured} configurados</span>
                  <span className={counts.missing ? 'text-warning' : ''}>{counts.missing} pendentes</span>
                  <span className={counts.plaintext + counts.unmarked ? 'text-danger' : ''}>
                    {counts.plaintext + counts.unmarked} expostos no arquivo versionado
                  </span>
                </div>
                <table className={table.root} aria-label={`Segredos de ${env.name}`}>
                  <thead className={table.head}>
                    <tr>
                      <th className={table.th}>Variável</th>
                      <th className={table.th}>Estado</th>
                      <th className={table.th}>Descrição</th>
                    </tr>
                  </thead>
                  <tbody>
                    {env.secrets.map((s) => (
                      <tr
                        key={s.variable}
                        className={cx(table.row, 'cursor-pointer', selected === s.variable && 'bg-accent/10')}
                        onClick={() => setSelected(s.variable)}
                        {...ctx.bind(`Segredo ${s.variable}`, () => secretEntries(s))}
                      >
                        <td className={table.td}>
                          <button
                            type="button"
                            className="font-mono text-fg"
                            aria-pressed={selected === s.variable}
                            onClick={(e) => {
                              e.stopPropagation()
                              setSelected(s.variable)
                            }}
                          >
                            {s.variable}
                          </button>
                        </td>
                        <td className={table.td}>
                          <Badge tone={STATE[s.state].tone} title={STATE[s.state].hint}>
                            {s.state === 'configured' ? (
                              <CircleCheck size={11} aria-hidden />
                            ) : (
                              <TriangleAlert size={11} aria-hidden />
                            )}
                            {STATE[s.state].label}
                          </Badge>
                        </td>
                        <td className={`${table.td} text-muted`}>{s.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            <div className="mt-4 flex items-center gap-2 px-4 py-2">
              <h3 className="text-[13px] font-semibold">Variáveis de {env.name}</h3>
              <span className="text-xs text-muted">{env.file}</span>
              <Button
                size="sm"
                className="ml-auto"
                icon={<Plus size={14} aria-hidden />}
                disabled={!!env.problem}
                onClick={() => setEditing('')}
              >
                Nova variável
              </Button>
            </div>
            {env.problem && (
              <ErrorNotice
                compact
                className="mx-4 mb-2"
                title="Ambiente fora do schema"
                code="SCHEMA_INVALID"
                message={`${env.file} não passa no schema (${env.problem}).`}
                location={env.file}
                hint="Corrija o arquivo para editar este ambiente no app; um segredo em texto puro precisa voltar a __REQUIRED_SECRET__, com o valor no vault local."
              />
            )}
            {env.variables.length === 0 ? (
              <p className="px-4 text-xs text-muted">Nenhuma variável ainda.</p>
            ) : (
              <table className={table.root} aria-label={`Variáveis de ${env.name}`}>
                <thead className={table.head}>
                  <tr>
                    <th className={table.th}>Variável</th>
                    <th className={table.th}>Tipo</th>
                    <th className={table.th}>Valor</th>
                    <th className={table.th}>Descrição</th>
                    <th className={`${table.th} w-20`}>
                      <span className="sr-only">Ações</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {env.variables.map((v) => (
                    <tr key={v.name} className={cx(table.row, editing === v.name && 'bg-accent/10')}>
                      <td className={`${table.td} font-mono`}>{v.name}</td>
                      <td className={`${table.td} text-muted`}>{v.isSecret ? 'segredo' : TYPE_LABEL[v.type]}</td>
                      <td className={`${table.td} font-mono break-all`}>
                        {v.value !== undefined ? (
                          String(v.value)
                        ) : (
                          <span className="tracking-widest text-muted" aria-label="valor oculto">
                            ••••••
                          </span>
                        )}
                      </td>
                      <td className={`${table.td} text-muted`}>{v.description}</td>
                      <td className={table.td}>
                        <span className="flex gap-1">
                          <button
                            type="button"
                            className="rounded p-1 text-muted hover:text-fg disabled:opacity-40"
                            disabled={!!env.problem}
                            aria-label={`Editar ${v.name}`}
                            onClick={() => setEditing(v.name)}
                          >
                            <Pencil size={13} aria-hidden />
                          </button>
                          <button
                            type="button"
                            className="rounded p-1 text-muted hover:text-danger disabled:opacity-40"
                            disabled={!!env.problem}
                            aria-label={`Excluir ${v.name}`}
                            onClick={() => void deleteVariable(v.name)}
                          >
                            <Trash2 size={13} aria-hidden />
                          </button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {ctx.menu}
      {dialog.element}
      <InspectorPanel id="secrets" title="Inspector">
        {editing !== null && env ? (
          <InspectorSection title={editing ? `Variável ${editing}` : `Nova variável em ${env.name}`}>
            <VariableForm
              key={`${env.id}/${editing}`}
              environment={env}
              {...(editing &&
                env.variables.find((v) => v.name === editing) && {
                  variable: env.variables.find((v) => v.name === editing)!
                })}
              taken={env.variables.map((v) => v.name)}
              onSave={(op) =>
                edit([op], editing ? `${op.name} salva em ${env.file}.` : `${op.name} criada em ${env.name}.`)
              }
              onCancel={() => setEditing(null)}
            />
          </InspectorSection>
        ) : secret && env && inventory ? (
          <>
            <InspectorSection title={secret.variable}>
              <Field label="Referência">
                <span className="font-mono text-cyan">{`{{${secret.variable}}}`}</span>
              </Field>
              <Field label="Escopo">{env.name}</Field>
              <Field label="Declarado em">
                <span className="font-mono" title={env.file}>
                  {env.file}
                </span>
              </Field>
              <Field label="Valor em">
                <span className="font-mono">
                  {secret.state === 'configured' || secret.state === 'missing' ? inventory.storeFile : env.file}
                </span>
              </Field>
              <Field label="Estado">
                <Badge tone={STATE[secret.state].tone}>{STATE[secret.state].label}</Badge>
              </Field>
              <p className="mt-2 text-xs text-muted">{STATE[secret.state].hint}</p>
            </InspectorSection>
            <InspectorSection title="Valor">
              <SecretField
                label={secret.variable}
                hasValue={secret.state !== 'missing'}
                revealPolicy={REVEAL_POLICY}
                placeholder={secret.placeholder}
                editRequest={editRequest}
                onReveal={secret.state === 'configured' && !shownValue ? () => void reveal(secret.variable) : undefined}
                onCopy={secret.state === 'configured' ? () => void copyValue(secret.variable) : undefined}
                onSet={
                  secret.state === 'missing'
                    ? (v) => setValue(secret.variable, v)
                    : secret.state === 'configured'
                      ? (v) => replaceValue(secret.variable, v)
                      : undefined
                }
              />
              {shownValue !== null && (
                <div className="mt-2 flex flex-col gap-1" role="status">
                  <code
                    className="rounded-[var(--radius-control)] border border-warning/40 bg-warning/10 px-2 py-1.5 font-mono text-xs break-all text-fg"
                    aria-label={`Valor de ${secret.variable}`}
                  >
                    {shownValue}
                  </code>
                  <span className="flex items-center gap-2 text-[11px] text-muted">
                    Some em {REVEAL_MS / 1000} s.
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<EyeOff size={13} aria-hidden />}
                      onClick={() => setRevealed(null)}
                    >
                      Ocultar agora
                    </Button>
                  </span>
                </div>
              )}
            </InspectorSection>
            <InspectorSection title="Permissões">
              <Field label="Revelar">
                {secret.state === 'configured' ? `com confirmação, por ${REVEAL_MS / 1000} s` : 'não se aplica'}
              </Field>
              <Field label="Copiar">
                {secret.state === 'configured' ? 'com confirmação; limpa em 30 s' : 'não se aplica'}
              </Field>
              <Field label="Gravar">
                {secret.state === 'missing'
                  ? 'só escrita'
                  : secret.state === 'configured'
                    ? 'substituir, com confirmação; só escrita'
                    : 'fora do app'}
              </Field>
            </InspectorSection>
          </>
        ) : (
          <EmptyState
            title="Nenhum segredo selecionado"
            description="Escolha uma variável para ver escopo, origem e estado."
          />
        )}
      </InspectorPanel>
    </div>
  )
}
