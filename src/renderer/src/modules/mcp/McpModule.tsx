import { useState } from 'react'
import { Bot, Copy, FolderGit2, Power } from 'lucide-react'
import type { ConnectRepoResult, McpClientId } from '@shared/ipc'
import { useServices } from '../../app/shell/useAppServices'
import { Badge, Button, cx, ErrorNotice, Field, table, useToast } from '../../design-system'
import { copyText } from '../../lib/clipboard'
import { navigate } from '../../lib/navigate'
import { MCP_TOOL_SUMMARIES } from '@shared/mcp-tools'
import { AiReviewBanner } from '../connectors/AiReview'

type Client = 'claude' | 'cursor' | 'copilot'

const CLIENTS: { id: Client; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'copilot', label: 'GitHub Copilot (VS Code)' }
]

/** A configuração de cada cliente para o servidor HTTP ligado no app (docs/mcp.md). */
function clientConfig(client: Client, url: string, token: boolean): string {
  const auth = token ? { Authorization: 'Bearer <token de VVPOST_MCP_TOKEN>' } : undefined
  if (client === 'claude')
    return `claude mcp add --transport http vvpost ${url}/mcp${token ? ' --header "Authorization: Bearer <token>"' : ''}`
  if (client === 'cursor')
    return JSON.stringify({ mcpServers: { vvpost: { url: `${url}/mcp`, ...(auth && { headers: auth }) } } }, null, 2)
  return JSON.stringify({ servers: { vvpost: { type: 'http', url: `${url}/mcp`, ...(auth && { headers: auth }) } } }, null, 2)
}

const CLIENT_FILE: Record<Client, string> = {
  claude: 'No terminal, na pasta do projeto',
  cursor: 'Em .cursor/mcp.json no projeto (ou ~/.cursor/mcp.json)',
  copilot: 'Em .vscode/mcp.json no workspace (modo Agent)'
}

const REPO_CLIENTS: { id: McpClientId; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'vscode', label: 'Copilot (VS Code)' },
  { id: 'codex', label: 'Codex' }
]

const STEP_TEXT: Record<'created' | 'updated' | 'unchanged' | 'manual', string> = {
  created: 'criado',
  updated: 'atualizado',
  unchanged: 'já estava',
  manual: 'rode à mão'
}

/**
 * Liga um repositório de código num clique (o vvpost connect): o servidor do app em cada cliente e a
 * regra do VVPost no CLAUDE.md / AGENTS.md, para o agente atualizar a documentação junto com o código.
 */
function ConnectRepo({ copy }: { copy: (text: string, what: string) => void }) {
  const [clients, setClients] = useState<McpClientId[]>(['claude'])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ConnectRepoResult | null>(null)
  const toggle = (id: McpClientId, on: boolean) => setClients((list) => (on ? [...list, id] : list.filter((c) => c !== id)))
  const connect = () => {
    setBusy(true)
    void window.vvpost
      .connectCodeRepo(clients)
      .then((r) => r && setResult(r))
      .finally(() => setBusy(false))
  }
  return (
    <section aria-label="Ligar um repositório de código" className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold">Ligar um repositório de código</h3>
      <p className="text-muted">
        Registra este servidor nos clientes escolhidos e grava a regra do VVPost no CLAUDE.md (Claude Code) ou AGENTS.md
        (os outros) do repositório: ao mudar o código, o agente atualiza junto o catálogo, as páginas e o PDF. Rodar de
        novo não duplica nada. Pelo terminal: vvpost connect &lt;repositório&gt;.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {REPO_CLIENTS.map((c) => (
          <label key={c.id} className="flex items-center gap-1.5">
            <input type="checkbox" checked={clients.includes(c.id)} disabled={busy} onChange={(e) => toggle(c.id, e.target.checked)} />
            {c.label}
          </label>
        ))}
        <span className="flex-1" />
        <Button size="sm" icon={<FolderGit2 size={14} aria-hidden />} disabled={busy || !clients.length} onClick={connect}>
          Escolher repositório e ligar
        </Button>
      </div>
      {result && !result.ok && <ErrorNotice compact title="Não deu para ligar o repositório" code="CONNECT_ERROR" message={result.message} />}
      {result?.ok && (
        <ul aria-label="Repositório ligado" className="flex flex-col gap-1">
          <li className="text-success">{result.repo} ligado ao VVPost. Reinicie a sessão do agente para ele ver o servidor e a regra.</li>
          {result.steps.map((step) => (
            <li key={`${step.client}:${step.target}`} className="flex items-center gap-2">
              <Badge tone={step.action === 'manual' ? 'warning' : step.action === 'unchanged' ? 'neutral' : 'success'}>{STEP_TEXT[step.action]}</Badge>
              <span>{step.client === 'rule' ? 'Regra' : REPO_CLIENTS.find((c) => c.id === step.client)?.label}</span>
              <span className="truncate font-mono text-muted">{step.command ?? step.target}</span>
              {step.command && (
                <Button size="sm" variant="ghost" icon={<Copy size={13} aria-hidden />} onClick={() => copy(step.command!, 'Comando copiado')}>
                  Copiar
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * MCP & IA: o servidor MCP do workspace (o mesmo botão da barra de
 * status), a configuração pronta para cada cliente, as ferramentas e limites, e as alterações da
 * IA que esperam revisão antes de disparar.
 */
export default function McpModule() {
  const services = useServices()
  const notify = useToast()
  const [client, setClient] = useState<Client>('claude')
  const mcp = services.mcp
  const running = mcp?.status === 'running' && !!mcp.url
  const url = mcp?.url ?? 'http://127.0.0.1:4470'
  const config = clientConfig(client, url, !!mcp?.token)
  const copy = (text: string, what: string) =>
    void copyText(text, what).then((m) => notify(m, 'success'), () => notify('Não deu para copiar.', 'danger'))

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-5 text-xs">
        <section aria-label="Servidor MCP" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Bot size={18} className="text-accent" aria-hidden />
            <h2 className="text-sm font-semibold">Servidor MCP</h2>
            <Badge tone={running ? 'success' : mcp?.status === 'error' ? 'danger' : 'neutral'}>
              {running ? 'Ligado' : mcp?.status === 'starting' ? 'Ligando…' : mcp?.status === 'error' ? 'Erro' : 'Desligado'}
            </Badge>
            <span className="flex-1" />
            <Button
              size="sm"
              variant={running ? 'secondary' : 'primary'}
              icon={<Power size={14} aria-hidden />}
              disabled={services.busy !== null || mcp?.status === 'starting'}
              onClick={services.toggleMcp}
            >
              {running ? 'Desligar' : 'Ligar o servidor'}
            </Button>
          </div>
          <p className="text-muted">
            Claude Code, Cursor e Copilot usam o workspace aberto pelo servidor HTTP em loopback (Streamable HTTP em
            /mcp e SSE em /sse). Credenciais passam pelo Secret Sanitizer: a IA vê os nomes dos segredos, nunca os valores.
          </p>
          {mcp?.status === 'error' && mcp.message && (
            <ErrorNotice
              compact
              title="O servidor MCP não ligou"
              code="MCP_ERROR"
              message={mcp.message}
              location={url}
            />
          )}
          <div className="flex flex-col">
            <Field label="Endereço">
              <span className="flex items-center gap-2 font-mono">
                {url}/mcp
                <Button size="sm" variant="ghost" icon={<Copy size={13} aria-hidden />} onClick={() => copy(`${url}/mcp`, 'URL copiada')}>
                  Copiar URL
                </Button>
              </span>
            </Field>
            <Field label="Workspace">{mcp?.workspace ?? services.workspace?.dir ?? 'nenhum aberto'}</Field>
            <Field label="Token">{mcp?.token ? 'exigido (VVPOST_MCP_TOKEN)' : 'não exigido (só loopback)'}</Field>
          </div>
        </section>

        <section aria-label="Conectar um cliente" className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold">Conectar um cliente</h3>
          <div role="tablist" aria-label="Cliente MCP" className="flex gap-1">
            {CLIENTS.map((c) => (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={client === c.id}
                onClick={() => setClient(c.id)}
                className={cx(
                  'rounded-[var(--radius-control)] px-2.5 py-1',
                  client === c.id ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-border/50 hover:text-fg'
                )}
              >
                {c.label}
              </button>
            ))}
          </div>
          <p className="text-muted">{CLIENT_FILE[client]}:</p>
          <div className="relative">
            <pre aria-label={`Configuração do ${CLIENTS.find((c) => c.id === client)!.label}`} className="overflow-auto rounded-[var(--radius-control)] border border-border bg-surface p-3 font-mono text-[11px]">
              {config}
            </pre>
            <Button size="sm" className="absolute top-2 right-2" icon={<Copy size={13} aria-hidden />} onClick={() => copy(config, 'Configuração copiada')}>
              Copiar
            </Button>
          </div>
          {!running && <p className="text-warning">Ligue o servidor para o cliente conseguir se conectar.</p>}
          <p className="text-muted">
            Sem o app aberto, o cliente pode iniciar o servidor por stdio (vvpost-mcp --workspace …, do pacote npm vvpost), com os modos
            --read-only, --allow-env, --allow-methods e --rate (docs/mcp.md).
          </p>
        </section>

        <ConnectRepo copy={copy} />

        <section aria-label="Alterações da IA para revisar" className="-mx-4 flex flex-col gap-1">
          <h3 className="px-4 text-[13px] font-semibold">Alterações da IA para revisar</h3>
          <AiReviewBanner
            emptyText="Nenhuma alteração da IA esperando revisão. Quando a IA muda a auth, o destino ou as credenciais de um conector, ou o código de um fluxo, ela só monta as requisições até você aprovar aqui ou no Catálogo."
            onOpenConnector={(id) => navigate({ module: 'catalog', connectorId: id })}
            onApproved={() => undefined}
          />
        </section>

        <section aria-label="Ferramentas e limites" className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold">Ferramentas</h3>
          <table className={table.root} aria-label="Ferramentas do servidor MCP">
            <tbody>
              {MCP_TOOL_SUMMARIES.map(([name, what]) => (
                <tr key={name} className={table.row}>
                  <td className={`${table.td} w-48 font-mono`}>{name}</td>
                  <td className={`${table.td} text-muted`}>{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-muted">
            Limites que valem sempre: 60 requisições por minuto, 4 ao mesmo tempo, timeout de até 60 s e 50 execuções por
            chamada. Passar de um deles devolve POLICY_DENIED com o motivo.
          </p>
        </section>
      </div>
    </div>
  )
}
