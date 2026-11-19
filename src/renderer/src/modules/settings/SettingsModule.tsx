import { useEffect, useState, type ReactNode } from 'react'
import { Settings } from 'lucide-react'
import { useServices } from '../../app/shell/useAppServices'
import { useIdentity } from '../../app/shell/useIdentity'
import { rememberedExpanded, setSidebarExpanded } from '../../app/shell/Sidebar'
import { showOnboarding } from '../../app/shell/Onboarding'
import { Badge, Button, controlClass, formatShortcut, table, type Tone } from '../../design-system'
import { navigate } from '../../lib/navigate'
import { panels } from '../../panels/registry'
import { NetworkSettings } from './NetworkSettings'

function Section(props: { title: string; children: ReactNode; description?: string }) {
  return (
    <section aria-label={props.title} className="flex flex-col gap-2 border-b border-border-subtle pb-5">
      <h3 className="text-[13px] font-semibold">{props.title}</h3>
      {props.description && <p className="text-muted">{props.description}</p>}
      {props.children}
    </section>
  )
}

function Row(props: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[12rem_1fr] items-center gap-3 py-1">
      <span className="text-muted">{props.label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{props.children}</div>
    </div>
  )
}

const STATUS: Record<string, { label: string; tone: Tone }> = {
  running: { label: 'Ligado', tone: 'success' },
  starting: { label: 'Ligando…', tone: 'info' },
  error: { label: 'Erro', tone: 'danger' },
  off: { label: 'Desligado', tone: 'neutral' }
}
const status = (s: string | undefined) => STATUS[s ?? 'off'] ?? STATUS['off']!

/**
 * Configurações: o que hoje fica espalhado pelo menu da conta, pela
 * barra de status e pelo botão da sidebar, num lugar só. Conta e perfil, serviços locais (Secret
 * Engine, MCP, webhooks), interface, atalhos e o estado do teste com usuários.
 */
export default function SettingsModule() {
  const services = useServices()
  const { identity, rename, signIn, signOut } = useIdentity()
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(rememberedExpanded)
  const [study, setStudy] = useState<boolean | null>(null)

  useEffect(() => {
    if (identity) setName(identity.profile.displayName)
  }, [identity])
  useEffect(() => {
    void window.vvpost.getUxStudyStatus().then(setStudy)
  }, [])

  const enterprise = identity?.enterprise
  const engine = services.engine
  // Recursos que a organização (ou VVPOST_DISABLE_FEATURES) desligou: o botão de ligar some, com o motivo.
  const off = (id: string) => identity?.features?.find((f) => f.id === id)
  const engineOff = engine?.mode !== 'enterpriseProxy' ? off('secretEmulator') : undefined
  const mcp = services.mcp
  const webhooks = services.webhooks
  const busy = services.busy !== null

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-5 text-xs">
        <div className="flex items-center gap-2">
          <Settings size={18} className="text-accent" aria-hidden />
          <h2 className="text-sm font-semibold">Configurações</h2>
        </div>

        <Section title="Conta e perfil" description="O VVPost não pede conta: o perfil local fica nesta estação.">
          <Row label="Nome de exibição">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void rename(name.trim()).then(setNameError)
              }}
            >
              <input
                aria-label="Nome de exibição"
                className={`w-56 ${controlClass}`}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Button size="sm" type="submit" disabled={!name.trim() || name.trim() === identity?.profile.displayName}>
                Salvar
              </Button>
            </form>
            {nameError && <span className="text-danger">{nameError}</span>}
          </Row>
          {enterprise?.available ? (
            <>
              <Row label="Conta corporativa">
                {enterprise.session.status === 'signedIn' ? (
                  <>
                    <span>{enterprise.session.user?.name}</span>
                    {enterprise.organization && <Badge tone="accent">{enterprise.organization.name}</Badge>}
                    <Button size="sm" variant="ghost" onClick={signOut}>
                      Sair
                    </Button>
                  </>
                ) : (
                  <Button size="sm" onClick={signIn}>
                    Entrar com a conta corporativa
                  </Button>
                )}
              </Row>
              {enterprise.policy && (
                <Row label="Política da organização">
                  <span className="text-muted">
                    Escrita de segredos {enterprise.policy.allowWrites ? 'permitida' : 'bloqueada'} · proxy de segredos{' '}
                    {enterprise.policy.secretsProxyEnabled ? 'ligado' : 'desligado'}
                  </span>
                </Row>
              )}
            </>
          ) : (
            <Row label="Conta corporativa">
              <span className="text-muted">Sem o módulo Enterprise: usuário local, sem sessão autenticada.</span>
            </Row>
          )}
        </Section>

        <Section
          title="Serviços locais"
          description="Os mesmos botões da barra de status. Todos ouvem só em 127.0.0.1 e começam desligados."
        >
          {!!identity?.features?.length && (
            <Row label="Desligados pela organização">
              <ul className="flex flex-col gap-0.5">
                {identity.features.map((f) => (
                  <li key={f.id}>
                    <span className="text-fg">{f.label}</span> <span className="text-muted">({f.source})</span>
                  </li>
                ))}
              </ul>
            </Row>
          )}
          <Row label="Secret Engine (mock de Secret Managers)">
            <Badge tone={status(engine?.status).tone}>{status(engine?.status).label}</Badge>
            {engine?.status === 'running' && <span className="font-mono text-muted">:{engine.port}</span>}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || engine?.status === 'starting' || (!!engineOff && engine?.status !== 'running')}
              title={engineOff ? `${engineOff.label}: desligado pela ${engineOff.source}` : undefined}
              onClick={services.toggleEngine}
            >
              {engine?.status === 'running' ? 'Desligar' : 'Ligar'}
            </Button>
            {engine?.proxyAvailable && (
              <select
                aria-label="Modo do Secret Engine"
                className={controlClass}
                value={engine.mode}
                disabled={busy}
                onChange={(e) => services.setEngineMode(e.target.value as 'localMock' | 'enterpriseProxy')}
              >
                <option value="localMock">Local Mock</option>
                <option value="enterpriseProxy">Cloud Proxy</option>
              </select>
            )}
          </Row>
          <Row label="Servidor MCP">
            <Badge tone={status(mcp?.status).tone}>{status(mcp?.status).label}</Badge>
            {mcp?.url && <span className="font-mono text-muted">{mcp.url}</span>}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || mcp?.status === 'starting' || (!!off('mcp') && mcp?.status !== 'running')}
              title={off('mcp') && `${off('mcp')!.label}: desligado pela ${off('mcp')!.source}`}
              onClick={services.toggleMcp}
            >
              {mcp?.status === 'running' ? 'Desligar' : 'Ligar'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => navigate({ module: 'mcp' })}>
              Abrir MCP & IA
            </Button>
          </Row>
          <Row label="Servidor de webhooks">
            <Badge tone={status(webhooks?.status).tone}>{status(webhooks?.status).label}</Badge>
            {webhooks?.url && <span className="font-mono text-muted">{webhooks.url}</span>}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || webhooks?.status === 'starting' || (!!off('webhooks') && webhooks?.status !== 'running')}
              title={off('webhooks') && `${off('webhooks')!.label}: desligado pela ${off('webhooks')!.source}`}
              onClick={services.toggleWebhooks}
            >
              {webhooks?.status === 'running' ? 'Desligar' : 'Ligar'}
            </Button>
          </Row>
        </Section>

        <Section
          title="Rede e cookies"
          description="Proxy, certificados e cookies de todas as requisições do app (Quick Request, cenários, fluxos e MCP). Ficam nesta estação, fora do projeto."
        >
          <NetworkSettings />
        </Section>

        <Section title="Interface">
          <Row label="Sidebar">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={expanded}
                onChange={(e) => {
                  setExpanded(e.target.checked)
                  setSidebarExpanded(e.target.checked)
                }}
              />
              Expandida, com os rótulos dos módulos
            </label>
          </Row>
          <Row label="Primeiros passos">
            <Button size="sm" variant="ghost" onClick={showOnboarding}>
              Mostrar o checklist
            </Button>
          </Row>
        </Section>

        <Section title="Atalhos dos módulos" description="Os outros atalhos ficam na paleta de comandos (Ctrl+K).">
          <table className={table.root} aria-label="Atalhos dos módulos">
            <tbody>
              {panels.map((p) => (
                <tr key={p.id} className={table.row}>
                  <td className={table.td}>{p.label}</td>
                  <td className={`${table.td} font-mono text-muted`}>
                    {p.key === undefined ? 'sidebar e paleta' : formatShortcut(`Mod+${p.key}`)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section title="Teste com usuários">
          <Row label="Modo de estudo">
            <Badge tone={study ? 'warning' : 'neutral'}>{study ? 'Gravando eventos' : 'Desligado'}</Badge>
            <span className="text-muted">
              {study
                ? 'Só ids, códigos e tempos, numa pasta local.'
                : 'Liga com --ux-study=<pasta> ou VVPOST_UX_STUDY; nada sai da estação.'}
            </span>
          </Row>
        </Section>
      </div>
    </div>
  )
}
