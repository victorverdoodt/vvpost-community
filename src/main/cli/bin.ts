import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { main } from './index'

/**
 * Executável do CLI (out/main/cli.js). Roda em Node puro, ou no Electron com
 * ELECTRON_RUN_AS_NODE=1: não carrega nada do Electron nem da interface.
 * Ctrl+C cancela as requisições em voo e sai com 130 depois do relatório parcial;
 * o segundo Ctrl+C sai na hora.
 */
/**
 * out/main/cli.js → raiz do app, onde fica a pasta plugins/ com os oficiais. No instalador o
 * CLI roda de resources/app.asar e os oficiais ficam fora dele, em resources/plugins.
 */
function appDir(root: string): string {
  return root.endsWith('.asar') ? dirname(root) : root
}

/** O valor de `vvpost secrets set`: no terminal, digitado sem eco; num pipe, o stdin inteiro. */
async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    let text = ''
    for await (const chunk of process.stdin) text += chunk
    return text.replace(/\r?\n$/, '')
  }
  process.stderr.write(prompt)
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
  // Sem eco: nada do que é digitado volta para a tela.
  ;(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {}
  try {
    return await new Promise<string>((done) => rl.question('', done))
  } finally {
    rl.close()
    process.stderr.write('\n')
  }
}

const controller = new AbortController()
process.on('SIGINT', () => {
  if (controller.signal.aborted) process.exit(130)
  controller.abort()
})
process.on('SIGTERM', () => controller.abort())

main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  cwd: process.cwd(),
  isTTY: !!process.stdout.isTTY,
  appDir: appDir(resolve(__dirname, '..', '..')),
  self: [process.execPath, resolve(__dirname, 'cli.js')],
  signal: controller.signal,
  readSecret
}).then(
  (code) => {
    process.exitCode = code
  },
  (err: Error) => {
    process.stderr.write(`vvpost: ${err.message}\n`)
    process.exitCode = 2
  }
)
