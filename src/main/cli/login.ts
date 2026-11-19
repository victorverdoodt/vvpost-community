import { spawn } from 'node:child_process'
import { safeOpen } from '../enterprise/identity'
import { parseOrganization } from '../enterprise/organization'
import { EnterpriseModuleMissingError, loadEnterpriseModule } from '../secret-engine/backend'
import type { Io } from './index'

export const LOGIN_HELP = `Uso: vvpost login <url do Control Plane> [--project <projeto>] [--env <ambiente>]

Registra a organização do VVPost Enterprise nesta máquina e confirma o host do Control Plane. O
resto da configuração (o IdP, a política do agente, os cofres, o catálogo) vem do Control Plane
depois do login, sem enterprise.json. O login abre no navegador para conferir.

  --project <projeto>   Projeto do Control Plane cuja política vale
  --env <ambiente>      Ambiente cujos segredos o broker entrega (padrão "default")

Um workspace também pode declarar a organização em .vvpost/organization.json; o MCP desse workspace
só abre o login sozinho para um host confirmado aqui ou pelo botão Entrar do app.
`

/** O navegador padrão, como o MCP por stdio: a URL também vai para o terminal. */
function openInBrowser(io: Io): (url: string) => Promise<void> {
  return async (url) => {
    io.stderr(`Abrindo o login no navegador: ${url}\n`)
    const [cmd, args] =
      process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]]
    try {
      spawn(cmd, args as string[], { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref()
    } catch {
      // sem navegador: a URL ficou no terminal
    }
  }
}

export async function loginCommand(io: Io, args: string[], options: { project?: string; env?: string[] }, openExternal?: (url: string) => Promise<void>): Promise<number> {
  if (args.length !== 1) {
    io.stderr(args.length ? `vvpost login: argumento inesperado "${args[1]}"\n` : LOGIN_HELP)
    return 2
  }
  if ((options.env?.length ?? 0) > 1) {
    io.stderr('vvpost login: use um --env só (o ambiente do broker)\n')
    return 2
  }
  let ref
  try {
    ref = parseOrganization({ controlPlane: args[0], ...(options.project && { project: options.project }), ...(options.env?.[0] && { environment: options.env[0] }) }, 'vvpost login')
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`)
    return 2
  }
  let mod
  try {
    mod = await loadEnterpriseModule(io.env)
  } catch (err) {
    io.stderr(err instanceof EnterpriseModuleMissingError ? 'vvpost login: precisa do módulo VVPost Enterprise, que não está instalado.\n' : `vvpost login: ${(err as Error).message}\n`)
    return 2
  }
  if (!mod.organization) {
    io.stderr('vvpost login: o módulo VVPost Enterprise instalado é anterior à configuração pelo Control Plane; atualize-o.\n')
    return 2
  }
  try {
    const done = await mod.organization.register(ref, safeOpen(openExternal ?? openInBrowser(io)))
    io.stdout(
      `Organização ${done.name} registrada (${new URL(done.controlPlane).host}${done.project ? `, projeto ${done.project}` : ''})` +
        `${done.user ? `; login de ${done.user} conferido` : ''}.\n` +
        'O MCP e o app abrem o login sozinhos para este Control Plane e aplicam a política dele.\n'
    )
    return 0
  } catch (err) {
    io.stderr(`vvpost login: ${(err as Error).message}\n`)
    return 2
  }
}
