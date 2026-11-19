import { spawn } from 'node:child_process'

/**
 * Camada do sistema operacional da sandbox de rede: no Linux, um processo sem rede
 * declarada roda num namespace de rede próprio (`unshare -rn`: user namespace sem
 * privilégios e só a interface de loopback, desligada). Nem um socket bruto sai dali.
 *
 * Depende de user namespaces sem privilégios, que algumas distribuições desligam
 * (o Ubuntu 24.04 restringe pelo AppArmor, por exemplo): a sonda roda uma vez e, se
 * falhar, fica só a barreira do runtime (permissões do Node, guarda de rede do
 * processo do plugin e audit hook do Python). `VVPOST_NETNS=0` desliga esta camada.
 */

let probed: Promise<boolean> | null = null

/** O namespace de rede está disponível nesta máquina? (resultado em cache) */
export function netnsAvailable(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (process.platform !== 'linux' || env['VVPOST_NETNS'] === '0') return Promise.resolve(false)
  return (probed ??= new Promise<boolean>((resolve) => {
    const child = spawn('unshare', ['-rn', '--', process.execPath, '-e', "require('node:net').connect(9, '127.0.0.1').on('error', (e) => process.exit(e.code === 'ENETUNREACH' ? 0 : 3)).on('connect', () => process.exit(4))"], {
      stdio: 'ignore',
      env: { ...(process.versions['electron'] && { ELECTRON_RUN_AS_NODE: '1' }) },
      windowsHide: true
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(false)
    }, 5_000)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  }))
}

/** Comando e argumentos dentro do namespace de rede vazio (só chame com `netnsAvailable()` verdadeiro). */
export const withoutNetwork = (command: string, args: string[]): { command: string; args: string[] } => ({
  command: 'unshare',
  args: ['-rn', '--', command, ...args]
})

/** Para os testes: refaz a sonda. */
export function resetNetnsProbe(): void {
  probed = null
}
