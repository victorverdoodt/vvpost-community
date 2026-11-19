import { useEffect, useState, type ReactNode } from 'react'
import { Building2, KeyRound, Play, PowerOff, Scale, ShieldCheck } from 'lucide-react'
import type { EnterprisePolicy, RemoteRunTarget, SecretEngineState, WorkspaceInfo } from '@shared/ipc'
import { cx, PROVIDER_NAME } from '../../design-system'
import { useIdentity } from './useIdentity'

/**
 * Barra de contexto Enterprise: onde cada coisa acontece, sem abrir
 * menus. Organização e sessão, papéis no projeto aberto, de onde vêm os segredos e para onde vai
 * uma execução. Só existe com o módulo Enterprise instalado; sem ele o app é local e não mostra
 * nada disso. Estados ruins (sessão expirada, sem papel, mock ligado) ganham cor e texto.
 */
export function EnterpriseBar(props: { workspace: WorkspaceInfo | null; engine: SecretEngineState | null }) {
  const { identity, signIn } = useIdentity()
  const [target, setTarget] = useState<RemoteRunTarget | null>(null)
  const enterprise = identity?.enterprise
  const status = enterprise?.session.status

  // O destino do runner depende da sessão: relido quando ela muda.
  useEffect(() => {
    if (!enterprise?.available) return
    void window.vvpost.getRemoteRunTarget().then(setTarget)
  }, [enterprise?.available, status, enterprise?.organization?.id])

  if (!enterprise?.available) return null
  const session = enterprise.session
  const signedIn = session.status === 'signedIn'
  const project = props.workspace?.name
  const roles = signedIn
    ? (enterprise.permissions ?? []).filter((p) => p.project === '*' || p.project === project).flatMap((p) => p.roles)
    : []
  const engine = props.engine

  return (
    <section
      aria-label="Contexto Enterprise"
      className="flex h-7 shrink-0 items-center gap-4 overflow-hidden border-b border-border bg-panel px-3 text-[11px] whitespace-nowrap text-muted"
    >
      <Item icon={<Building2 size={12} aria-hidden />} label="Organização">
        {signedIn ? (
          <>
            <span className="text-fg">{enterprise.organization?.name ?? 'sem organização'}</span>
            {session.user && (
              <span>
                {' '}
                · {session.user.name}
                {session.provider && ` (${PROVIDER_NAME[session.provider]})`}
              </span>
            )}
          </>
        ) : (
          <span className={cx(session.status === 'expired' ? 'text-warning' : '')}>
            {session.status === 'expired'
              ? 'sessão expirada'
              : session.status === 'signingIn'
                ? 'entrando…'
                : 'desconectado'}
            {session.status !== 'signingIn' && (
              <button type="button" onClick={signIn} className="ml-1.5 rounded px-1 text-accent hover:underline">
                {session.status === 'expired' ? 'Entrar novamente' : 'Entrar'}
              </button>
            )}
          </span>
        )}
      </Item>
      {signedIn && (
        <Item icon={<ShieldCheck size={12} aria-hidden />} label="Papéis no projeto">
          {!project ? (
            <span>nenhum projeto aberto</span>
          ) : roles.length ? (
            <span className="text-fg">{[...new Set(roles)].join(', ')}</span>
          ) : (
            <span className="text-warning" title="Autenticado não é autorizado: a organização não dá papel neste projeto">
              sem papel em {project}
            </span>
          )}
        </Item>
      )}
      {signedIn && enterprise.policy && <PolicyItem policy={enterprise.policy} />}
      {!!identity?.features?.length && (
        <Item icon={<PowerOff size={12} aria-hidden />} label="Recursos desligados">
          <span
            className="text-warning"
            title={['Desligados pela organização:', ...identity.features.map((f) => `${f.label} (${f.source})`)].join('\n')}
          >
            {identity.features.length === 1 ? `${identity.features[0]!.label} desligado` : `${identity.features.length} recursos desligados`}
          </span>
        </Item>
      )}
      <Item icon={<KeyRound size={12} aria-hidden />} label="Segredos">
        {engine?.status === 'running' && engine.mode === 'enterpriseProxy' ? (
          <span className="text-fg">proxy corporativo</span>
        ) : engine?.status === 'running' ? (
          <span className="text-warning" title="O mock serve valores locais para testes; não é um cofre de produção">
            mock local (não é cofre de produção)
          </span>
        ) : (
          <span title="Valores no cofre local, cifrado e só nesta máquina">vault local</span>
        )}
      </Item>
      <Item icon={<Play size={12} aria-hidden />} label="Execução">
        <span className="text-fg">local</span>
        {target && (
          <span title={target.hint}>
            {' '}
            · runner remoto em {target.source}
            {!target.signedIn && ' (entre para usar)'}
          </span>
        )}
      </Item>
    </section>
  )
}

const VAULT_NAME: Record<string, string> = {
  azureKeyVault: 'Azure Key Vault',
  awsSecretsManager: 'AWS Secrets Manager',
  hashicorpVault: 'HashiCorp Vault'
}

/** O que a política do agente restringe no MCP, uma linha por limite. */
function agentPolicyLines(m: EnterprisePolicy['mcp']): string[] {
  if (!m) return []
  return [
    ...(m.readOnly ? ['Agente (MCP) somente leitura: nada é enviado para as APIs'] : []),
    ...(m.noWrite ? ['Agente (MCP) não edita o projeto'] : []),
    ...(m.allowMethods ? [`Métodos do agente: ${m.allowMethods.join(', ') || 'nenhum'}`] : []),
    ...(m.allowEnvironments ? [`Ambientes do agente: ${m.allowEnvironments.join(', ') || 'nenhum'}`] : []),
    ...(m.protectedEnvironments?.length ? [`Ambientes protegidos para o agente: ${m.protectedEnvironments.join(', ')}`] : []),
    ...(m.requestsPerMinute !== undefined ? [`Agente: até ${m.requestsPerMinute} requisições por minuto`] : []),
    ...(m.maxConcurrent !== undefined ? [`Agente: até ${m.maxConcurrent} requisições ao mesmo tempo`] : []),
    ...(m.reviewApprovers?.length ? [`Revisão de auth, destino e código aprovada no console por ${m.reviewApprovers.join(', ')}`] : [])
  ]
}

/** Política efetiva do Control Plane: o resumo na barra e o resto no title. Só mostra; quem aplica é o módulo. */
function PolicyItem(props: { policy: EnterprisePolicy }) {
  const p = props.policy
  const scope = p.project ? `do projeto ${p.project}` : 'da organização'
  const ttl = p.maxCacheTtlSeconds
  const details = [
    `Política ${scope} no Control Plane`,
    !p.secretsProxyEnabled
      ? 'Cloud Proxy de segredos bloqueado'
      : p.secretsBroker
        ? 'Segredos pelo broker do Control Plane (o desktop não fala com o cofre)'
        : 'Cloud Proxy de segredos liberado',
    p.allowWrites ? 'Gravação no cofre permitida' : 'Cofre somente leitura',
    `Cofres aceitos: ${p.allowedSecretProviders.map((v) => VAULT_NAME[v] ?? v).join(', ') || 'nenhum'}`,
    ...(p.allowedUpstreamHosts.length ? [`Hosts de cofre aprovados: ${p.allowedUpstreamHosts.join(', ')}`] : []),
    ...(ttl !== undefined ? [ttl === 0 ? 'Sem cache em memória' : `Cache em memória de até ${formatTtl(ttl)}`] : []),
    ...(p.agentPiiDetection ? ['Dados pessoais detectados pelo formato e mascarados para o agente (MCP)'] : []),
    ...agentPolicyLines(p.mcp),
    `Lida às ${new Date(p.fetchedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
  ].join('\n')
  return (
    <Item icon={<Scale size={12} aria-hidden />} label="Política">
      <span title={details}>
        {!p.secretsProxyEnabled ? (
          <span className="text-warning">Cloud Proxy bloqueado</span>
        ) : (
          <span className="text-fg">{p.secretsBroker ? 'segredos pelo broker' : 'Cloud Proxy liberado'}</span>
        )}
        <span> · {p.allowWrites ? 'grava no cofre' : 'somente leitura'}</span>
      </span>
    </Item>
  )
}

function formatTtl(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`
}

function Item(props: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {props.icon}
      <span className="sr-only">{props.label}: </span>
      <span className="truncate">{props.children}</span>
    </span>
  )
}
