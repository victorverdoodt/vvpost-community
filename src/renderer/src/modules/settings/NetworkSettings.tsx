import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Trash2, X } from 'lucide-react'
import type { CookieEntry, HttpSettings, HttpSettingsInput } from '@shared/ipc'
import { Badge, Button, controlClass, IconButton, table, useToast } from '../../design-system'

function Row(props: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[12rem_1fr] items-center gap-3 py-1">
      <span className="text-muted">{props.label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{props.children}</div>
    </div>
  )
}

const MODE_HINT: Record<HttpSettings['proxy']['mode'], string> = {
  system: 'O proxy configurado no sistema operacional (inclusive PAC e WPAD).',
  env: 'HTTPS_PROXY, HTTP_PROXY e NO_PROXY do ambiente em que o app abriu.',
  manual: 'Um proxy HTTP, HTTPS ou SOCKS5 para todas as requisições.',
  off: 'Todas as requisições saem direto.'
}

const toInput = (s: HttpSettings): HttpSettingsInput => ({
  proxy: { mode: s.proxy.mode, url: s.proxy.url, bypass: s.proxy.bypass, username: s.proxy.username },
  verifyTls: s.verifyTls,
  caFiles: s.caFiles,
  cookies: s.cookies
})

const expiry = (c: CookieEntry) => (c.expires === undefined ? 'sessão' : new Date(c.expires).toLocaleString())

/**
 * Rede e cookies (spec, fase 12): proxy, verificação TLS e CAs extras, que valem para o Quick
 * Request, os cenários, os fluxos e o MCP do app, e o cookie jar, com a lista de cookies para ver,
 * editar e apagar. Tudo fica em userData; a senha do proxy vai para o cofre do sistema.
 */
export function NetworkSettings() {
  const toast = useToast()
  const [saved, setSaved] = useState<HttpSettings | null>(null)
  const [form, setForm] = useState<HttpSettingsInput | null>(null)
  const [password, setPassword] = useState('')
  const [cookies, setCookies] = useState<CookieEntry[]>([])
  const [filter, setFilter] = useState('')
  const [draft, setDraft] = useState({ name: '', value: '', domain: '', path: '/' })

  useEffect(() => {
    void window.vvpost.getHttpSettings().then((s) => {
      setSaved(s)
      setForm(toInput(s))
    })
    void window.vvpost.listCookies().then(setCookies)
  }, [])

  const dirty = useMemo(() => !!saved && !!form && (JSON.stringify(toInput(saved)) !== JSON.stringify(form) || password !== ''), [saved, form, password])
  if (!form || !saved) return null

  const save = (patch: Partial<HttpSettingsInput['proxy']> = {}) =>
    void window.vvpost
      .setHttpSettings({ ...form, proxy: { ...form.proxy, ...patch, ...(password && { password }) } })
      .then((s) => {
        setSaved(s)
        setForm(toInput(s))
        setPassword('')
        toast('Configurações de rede salvas; valem a partir da próxima requisição.', 'success')
      })
      .catch((err: Error) => toast(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'danger'))
  const setProxy = (patch: Partial<HttpSettingsInput['proxy']>) => setForm({ ...form, proxy: { ...form.proxy, ...patch } })
  const shown = cookies.filter((c) => !filter.trim() || c.domain.includes(filter.trim().toLowerCase()) || c.name.includes(filter.trim()))

  return (
    <>
      <Row label="Proxy">
        <select
          aria-label="Modo do proxy"
          className={controlClass}
          value={form.proxy.mode}
          onChange={(e) => setProxy({ mode: e.target.value as HttpSettings['proxy']['mode'] })}
        >
          <option value="system">Do sistema</option>
          <option value="env">Variáveis de ambiente</option>
          <option value="manual">Manual</option>
          <option value="off">Sem proxy</option>
        </select>
        <span className="text-muted">{MODE_HINT[form.proxy.mode]}</span>
      </Row>
      {form.proxy.mode === 'manual' && (
        <>
          <Row label="Endereço do proxy">
            <input
              aria-label="Endereço do proxy"
              className={`w-72 font-mono ${controlClass}`}
              placeholder="http://proxy.empresa:3128"
              value={form.proxy.url}
              onChange={(e) => setProxy({ url: e.target.value })}
              spellCheck={false}
            />
          </Row>
          <Row label="Sem proxy para">
            <input
              aria-label="Hosts sem proxy"
              className={`w-72 font-mono ${controlClass}`}
              placeholder=".interno.empresa, 10.0.0.0/8"
              value={form.proxy.bypass}
              onChange={(e) => setProxy({ bypass: e.target.value })}
              spellCheck={false}
            />
          </Row>
        </>
      )}
      {form.proxy.mode !== 'off' && (
        <Row label="Autenticação do proxy">
          <input
            aria-label="Usuário do proxy"
            className={`w-40 ${controlClass}`}
            placeholder="usuário (opcional)"
            value={form.proxy.username}
            onChange={(e) => setProxy({ username: e.target.value })}
            spellCheck={false}
          />
          <input
            aria-label="Senha do proxy"
            type="password"
            className={`w-40 ${controlClass}`}
            placeholder={saved.proxy.hasPassword ? 'senha guardada' : 'senha'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
          />
          {saved.proxy.hasPassword && (
            <Button size="sm" variant="ghost" onClick={() => save({ password: null })}>
              Apagar a senha
            </Button>
          )}
          {!saved.vault && <span className="text-warning">Sem cofre do sistema: a senha vale só até fechar o app.</span>}
        </Row>
      )}
      <Row label="Certificados">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.verifyTls} onChange={(e) => setForm({ ...form, verifyTls: e.target.checked })} />
          Verificar o certificado TLS dos servidores
        </label>
        {!form.verifyTls && <Badge tone="warning">Inseguro: aceita qualquer certificado</Badge>}
      </Row>
      <Row label="CAs extras (PEM)">
        {form.caFiles.map((file) => (
          <span key={file} className="flex items-center gap-1 font-mono">
            {file}
            <IconButton label={`Tirar a CA ${file}`} onClick={() => setForm({ ...form, caFiles: form.caFiles.filter((f) => f !== file) })}>
              <X size={13} aria-hidden />
            </IconButton>
          </span>
        ))}
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void window.vvpost.pickFile('ca').then((file) => file && !form.caFiles.includes(file) && setForm({ ...form, caFiles: [...form.caFiles, file] }))
          }
        >
          Adicionar CA
        </Button>
      </Row>
      <Row label="Cookies">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.cookies} onChange={(e) => setForm({ ...form, cookies: e.target.checked })} />
          Guardar os cookies recebidos e reenviar para o mesmo domínio
        </label>
      </Row>
      <Row label="">
        <Button size="sm" disabled={!dirty} onClick={() => save()}>
          Salvar rede e cookies
        </Button>
        {dirty && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setForm(toInput(saved))
              setPassword('')
            }}
          >
            Descartar
          </Button>
        )}
      </Row>

      <div className="mt-2 flex flex-col gap-2" aria-label="Cookie jar">
        <div className="flex items-center gap-2">
          <h4 className="text-xs font-semibold">Cookies guardados ({cookies.length})</h4>
          <input
            aria-label="Filtrar cookies"
            className={`w-48 ${controlClass}`}
            placeholder="Filtrar por domínio ou nome"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            disabled={!cookies.length}
            onClick={() => void window.vvpost.deleteCookies().then(setCookies)}
          >
            Apagar todos
          </Button>
        </div>
        {shown.length > 0 && (
          <table className={table.root} aria-label="Cookies">
            <thead>
              <tr>
                <th className={table.th}>Domínio</th>
                <th className={table.th}>Nome</th>
                <th className={table.th}>Valor</th>
                <th className={table.th}>Caminho</th>
                <th className={table.th}>Expira</th>
                <th className={table.th} aria-label="Ações" />
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={`${c.domain}\0${c.path}\0${c.name}`} className={table.row}>
                  <td className={`${table.td} font-mono`}>
                    {c.hostOnly ? c.domain : `.${c.domain}`}
                    {c.secure && <Badge tone="neutral">Secure</Badge>}
                  </td>
                  <td className={`${table.td} font-mono`}>{c.name}</td>
                  <td className={`${table.td} max-w-48 truncate font-mono`} title={c.value}>
                    <input
                      aria-label={`Valor do cookie ${c.name}`}
                      className="w-full bg-transparent font-mono"
                      defaultValue={c.value}
                      onBlur={(e) => {
                        if (e.target.value !== c.value) void window.vvpost.setCookie({ ...c, value: e.target.value }).then(setCookies)
                      }}
                      spellCheck={false}
                    />
                  </td>
                  <td className={`${table.td} font-mono`}>{c.path}</td>
                  <td className={table.td}>{expiry(c)}</td>
                  <td className={table.td}>
                    <IconButton
                      label={`Apagar o cookie ${c.name}`}
                      onClick={() => void window.vvpost.deleteCookies({ domain: c.domain, name: c.name, path: c.path }).then(setCookies)}
                    >
                      <Trash2 size={13} aria-hidden />
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form
          className="flex flex-wrap items-center gap-2"
          aria-label="Adicionar cookie"
          onSubmit={(e) => {
            e.preventDefault()
            void window.vvpost
              .setCookie({ ...draft, hostOnly: false, secure: false, httpOnly: false })
              .then((list) => {
                setCookies(list)
                setDraft({ name: '', value: '', domain: '', path: '/' })
              })
              .catch(() => toast('Cookie inválido: confira nome, domínio e caminho.', 'danger'))
          }}
        >
          <input aria-label="Domínio do novo cookie" className={`w-40 font-mono ${controlClass}`} placeholder="api.exemplo.com" value={draft.domain} onChange={(e) => setDraft({ ...draft, domain: e.target.value })} />
          <input aria-label="Nome do novo cookie" className={`w-28 font-mono ${controlClass}`} placeholder="nome" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input aria-label="Valor do novo cookie" className={`w-40 font-mono ${controlClass}`} placeholder="valor" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
          <input aria-label="Caminho do novo cookie" className={`w-20 font-mono ${controlClass}`} value={draft.path} onChange={(e) => setDraft({ ...draft, path: e.target.value })} />
          <Button size="sm" type="submit" disabled={!draft.name.trim() || !draft.domain.trim()}>
            Adicionar cookie
          </Button>
        </form>
      </div>
    </>
  )
}
