import { spawn, type ChildProcess } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { netnsAvailable, withoutNetwork } from '../sandbox/os'
import type { ContributionKind, HostToWorker, InvocationContext, PluginHttpRequest, PluginHttpResult, WorkerToHost } from './protocol'
import { PROCESS_SOURCE } from './process-source'

/** Processo parado depois deste tempo sem chamadas: plugin sem uso não ocupa memória. */
export const PLUGIN_IDLE_MS = 60_000
/** Depois de um timeout ou cancelamento, quanto o código do plugin tem para parar antes de o processo ser encerrado. */
export const PLUGIN_GRACE_MS = 1_000
/** Heap de cada processo: um plugin que estoura encerra só o próprio processo. */
export const PLUGIN_HEAP_MB = 256

export type InvokeErrorCode = 'PLUGIN_ERROR' | 'PLUGIN_CRASHED' | 'PLUGIN_UNAVAILABLE' | 'TIMEOUT' | 'ABORTED'

export type InvokeOutcome =
  | { ok: true; value: unknown; logs: string; durationMs: number }
  | { ok: false; code: InvokeErrorCode; message: string; logs: string; durationMs: number }

export interface Invocation {
  kind: ContributionKind
  name: string
  context: InvocationContext
  signal?: AbortSignal
  /** Atende ctx.http.send; `signal` aborta quando a chamada termina, estoura o tempo ou é cancelada. */
  onHttp(request: PluginHttpRequest, signal: AbortSignal): Promise<PluginHttpResult>
}

export interface PluginWorkerOptions {
  idleMs?: number
  graceMs?: number
  heapMb?: number
  /** console.* do plugin fora de uma chamada (no carregamento do módulo). */
  onLog?(level: string, text: string): void
}

/** O que o processo de um plugin pode fazer além de ler a própria pasta. */
export interface PluginSandbox {
  /** Pasta do plugin, a única que o processo lê (padrão: a pasta do main). */
  dir?: string
  /** Regras de rede fixas do manifesto (sem connector e config:, que vêm em cada chamada). */
  network: string[]
  /** O manifesto declara alguma rede? Sem rede, no Linux o processo roda num namespace de rede vazio. */
  usesNetwork: boolean
}

interface Pending {
  invocation: Invocation
  controller: AbortController
  finish(outcome: InvokeOutcome): void
}

interface Ready {
  nodes: string[]
  adapters: string[]
  exporters: string[]
  publishers: string[]
}

const WHAT: Record<ContributionKind, string> = { node: 'o nó', adapter: 'o adapter', exporter: 'o exportador', publisher: 'o publicador' }

/** Mensagem do stderr que o V8 escreve quando o heap estoura. */
const OUT_OF_MEMORY = /heap out of memory|Allocation failed/i

/**
 * Um processo por plugin: sobe na primeira chamada, atende chamadas
 * em paralelo e para sozinho depois de `idleMs` sem uso. O processo roda com as
 * permissões do Node ligadas (lê só a pasta do plugin; não escreve, não abre
 * subprocessos, workers nem addons), heap limitado, ambiente vazio e a guarda de rede
 * (process-source.ts): conexões só para os hosts que o manifesto declara. Sem rede
 * declarada, no Linux o processo ainda roda num namespace de rede vazio (sandbox/os.ts).
 * Um timeout ou cancelamento aborta o ctx.signal da chamada; se o código não parar em
 * `graceMs` (um laço infinito, por exemplo), o processo é encerrado, e as outras
 * chamadas dele falham com PLUGIN_CRASHED.
 */
export class PluginWorker {
  private child: ChildProcess | null = null
  private ready: Promise<Ready> | null = null
  private settleReady: { resolve(r: Ready): void; reject(e: Error): void } | null = null
  private readonly calls = new Map<number, Pending>()
  /** Chamadas já respondidas (timeout, cancelamento) que o processo ainda não terminou. */
  private readonly zombies = new Map<number, NodeJS.Timeout>()
  private nextId = 1
  private idleTimer: NodeJS.Timeout | null = null
  private stopping = false
  private stderrTail = ''
  /** Último motivo de o processo ter caído ou o plugin não ter carregado. */
  lastError: string | null = null
  /** O processo atual roda sem rede pelo kernel (namespace de rede do Linux)? */
  kernelIsolated = false

  constructor(
    readonly pluginId: string,
    readonly entry: string,
    private readonly options: PluginWorkerOptions = {},
    readonly sandbox: PluginSandbox = { network: [], usesNetwork: false }
  ) {}

  get state(): 'stopped' | 'starting' | 'running' {
    if (!this.child) return 'stopped'
    return this.settleReady ? 'starting' : 'running'
  }

  async invoke(invocation: Invocation): Promise<InvokeOutcome> {
    const start = performance.now()
    const elapsed = () => Math.round((performance.now() - start) * 100) / 100
    const failure = (code: InvokeErrorCode, message: string, logs = ''): InvokeOutcome => ({ ok: false, code, message, logs, durationMs: elapsed() })
    if (invocation.signal?.aborted) return failure('ABORTED', 'chamada cancelada')
    this.clearIdle()

    let ready: Ready
    try {
      ready = await (this.ready ??= this.start())
    } catch (err) {
      this.scheduleIdle()
      return failure('PLUGIN_UNAVAILABLE', `o plugin ${this.pluginId} não carregou: ${(err as Error).message}`)
    }
    const implemented = { node: ready.nodes, adapter: ready.adapters, exporter: ready.exporters, publisher: ready.publishers }[invocation.kind]
    if (!implemented.includes(invocation.name)) {
      this.scheduleIdle()
      return failure('PLUGIN_ERROR', `o plugin ${this.pluginId} declara ${WHAT[invocation.kind]} ${invocation.name} no manifesto mas não o exporta`)
    }
    const child = this.child!
    const id = this.nextId++
    const controller = new AbortController()

    return new Promise<InvokeOutcome>((resolve) => {
      let timer: NodeJS.Timeout | undefined
      const finish = (outcome: InvokeOutcome) => {
        if (!this.calls.has(id)) return
        this.calls.delete(id)
        clearTimeout(timer)
        invocation.signal?.removeEventListener('abort', onAbort)
        controller.abort()
        resolve(outcome)
        this.scheduleIdle()
      }
      // Responde já; o código do plugin tem graceMs para notar o ctx.signal e parar.
      const stop = (code: 'TIMEOUT' | 'ABORTED', message: string) => {
        if (!this.calls.has(id)) return
        finish(failure(code, message))
        this.post(child, { type: 'cancel', id })
        this.zombies.set(
          id,
          setTimeout(() => {
            if (this.zombies.has(id) && this.child === child) {
              void this.terminate(`o processo de ${this.pluginId} foi encerrado: uma chamada não parou depois de ${code === 'TIMEOUT' ? 'estourar o tempo' : 'cancelada'}`, true)
            }
          }, this.options.graceMs ?? PLUGIN_GRACE_MS)
        )
      }
      const onAbort = () => stop('ABORTED', 'chamada cancelada')
      this.calls.set(id, {
        invocation,
        controller,
        finish: (outcome) => {
          // O erro que chega depois do tempo do nó é o tempo estourado: o timer do host só não rodou
          // antes (máquina lenta), e o plugin parou pelo próprio limite (o timeout do vm de um laço).
          const late = !outcome.ok && outcome.code === 'PLUGIN_ERROR' && elapsed() >= invocation.context.timeoutMs
          finish(late ? failure('TIMEOUT', `o plugin não respondeu em ${invocation.context.timeoutMs} ms`, outcome.logs) : { ...outcome, durationMs: elapsed() })
        }
      })
      invocation.signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => stop('TIMEOUT', `o plugin não respondeu em ${invocation.context.timeoutMs} ms`), invocation.context.timeoutMs)
      this.post(child, { type: 'invoke', id, kind: invocation.kind, name: invocation.name, context: invocation.context })
    })
  }

  /** Encerra o processo; chamadas em andamento falham com `reason`. */
  async terminate(reason = `o plugin ${this.pluginId} foi parado`, crashed = false): Promise<void> {
    const child = this.child
    if (!child) return
    this.stopping = !crashed
    this.onExit(child, reason, crashed)
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.kill('SIGKILL')
      })
    }
  }

  private start(): Promise<Ready> {
    this.lastError = null
    this.stopping = false
    this.stderrTail = ''
    const ready = new Promise<Ready>((resolve, reject) => {
      this.settleReady = { resolve, reject }
    })
    // Marca "subindo" já; o spawn espera o caminho real da pasta e a sonda do namespace.
    this.child = {} as ChildProcess
    void this.spawn().catch((err: Error) => {
      this.child = null
      this.ready = null
      this.lastError = err.message
      this.settleReady?.reject(err)
      this.settleReady = null
    })
    return ready
  }

  private async spawn(): Promise<void> {
    const placeholder = this.child
    // Caminhos reais: o modelo de permissões do Node compara o caminho já resolvido (ex.: /var → /private/var no macOS).
    const entry = await realpath(this.entry)
    const dir = await realpath(this.sandbox.dir ?? dirname(this.entry)).catch(() => dirname(entry))
    const isolate = !this.sandbox.usesNetwork && (await netnsAvailable())
    const args = [
      '--permission',
      `--allow-fs-read=${dir}`,
      `--max-old-space-size=${this.options.heapMb ?? PLUGIN_HEAP_MB}`,
      '--max-semi-space-size=16',
      '-e',
      PROCESS_SOURCE
    ]
    const cmd = isolate ? withoutNetwork(process.execPath, args) : { command: process.execPath, args }
    // Nada das variáveis de ambiente do app (tokens, caminhos, NODE_OPTIONS) chega ao plugin.
    const env: NodeJS.ProcessEnv = {}
    if (process.versions['electron']) env['ELECTRON_RUN_AS_NODE'] = '1'
    if (process.platform === 'win32') for (const name of ['SYSTEMROOT', 'SystemRoot']) if (process.env[name]) env[name] = process.env[name]
    if (this.child !== placeholder) return
    const child = spawn(cmd.command, cmd.args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env, windowsHide: true })
    this.child = child
    this.kernelIsolated = isolate
    // process.stdout/stderr direto do plugin (fora do console) vão para o log do main process.
    child.stdout!.on('data', (chunk: Buffer) => this.log(child, 'log', chunk.toString('utf8').trimEnd()))
    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.stderrTail = (this.stderrTail + text).slice(-4_000)
      this.log(child, 'error', text.trimEnd())
    })
    child.on('message', (message: WorkerToHost) => this.onMessage(child, message))
    child.on('error', (err) => this.onExit(child, `o processo de ${this.pluginId} não subiu: ${err.message}`, true))
    child.on('exit', (code, signal) => {
      const reason = OUT_OF_MEMORY.test(this.stderrTail)
        ? `o plugin ${this.pluginId} passou do limite de memória do processo`
        : `o processo de ${this.pluginId} saiu (${signal ? `sinal ${signal}` : `código ${code}`})`
      this.onExit(child, reason, !this.stopping)
    })
    this.post(child, { type: 'init', entry, network: this.sandbox.network })
  }

  private onMessage(child: ChildProcess, message: WorkerToHost): void {
    if (child !== this.child || !message || typeof message !== 'object') return
    switch (message.type) {
      case 'ready':
        this.settleReady?.resolve({
          nodes: message.nodes,
          adapters: message.adapters,
          exporters: Array.isArray(message.exporters) ? message.exporters : [],
          publishers: Array.isArray(message.publishers) ? message.publishers : []
        })
        this.settleReady = null
        return
      case 'load-error':
        this.lastError = message.message.split('\n')[0] ?? message.message
        this.settleReady?.reject(new Error(this.lastError))
        this.settleReady = null
        void this.terminate(this.lastError)
        return
      case 'fatal':
        // Exceção solta no plugin: o processo sai logo depois.
        return this.onExit(child, `o processo de ${this.pluginId} caiu: ${message.message}`, true)
      case 'log':
        return this.log(child, message.level, message.text)
      case 'result': {
        const zombie = this.zombies.get(message.id)
        if (zombie) {
          clearTimeout(zombie)
          this.zombies.delete(message.id)
          this.scheduleIdle()
          return
        }
        const pending = this.calls.get(message.id)
        if (!pending) return
        if (message.ok) pending.finish({ ok: true, value: message.value, logs: message.logs, durationMs: 0 })
        else {
          const code = message.error.code ? `[${message.error.code}] ` : ''
          pending.finish({ ok: false, code: 'PLUGIN_ERROR', message: `${code}${message.error.message}`, logs: message.logs, durationMs: 0 })
        }
        return
      }
      case 'http': {
        const pending = this.calls.get(message.id)
        const reply = (result: PluginHttpResult) => {
          if (this.child === child) this.post(child, { type: 'http-result', callId: message.callId, result })
        }
        if (!pending || pending.controller.signal.aborted) return reply({ ok: false, error: { code: 'ABORTED', message: 'chamada cancelada' } })
        pending.invocation
          .onHttp(message.request, pending.controller.signal)
          .then(reply, (err: Error) => reply({ ok: false, error: { code: 'NETWORK_ERROR', message: err.message } }))
        return
      }
    }
  }

  /** O processo saiu (encerrado, caiu, sem memória): chamadas pendentes falham e o próximo uso sobe outro. */
  private onExit(child: ChildProcess, reason: string, crashed: boolean): void {
    if (child !== this.child) return
    this.child = null
    this.ready = null
    if (crashed) this.lastError = reason
    this.settleReady?.reject(new Error(reason))
    this.settleReady = null
    for (const timer of this.zombies.values()) clearTimeout(timer)
    this.zombies.clear()
    this.clearIdle()
    for (const pending of [...this.calls.values()]) {
      pending.finish({ ok: false, code: crashed ? 'PLUGIN_CRASHED' : 'PLUGIN_UNAVAILABLE', message: reason, logs: '', durationMs: 0 })
    }
    if (child.exitCode === null && child.signalCode === null && typeof child.kill === 'function') child.kill('SIGKILL')
  }

  private post(child: ChildProcess, message: HostToWorker): void {
    try {
      if (child.connected) child.send(message)
      else if (message.type === 'invoke') this.calls.get(message.id)?.finish({ ok: false, code: 'PLUGIN_CRASHED', message: `o processo de ${this.pluginId} não está mais conectado`, logs: '', durationMs: 0 })
    } catch (err) {
      // Valor que não vira JSON: falha só esta chamada.
      if (message.type === 'invoke') {
        this.calls.get(message.id)?.finish({ ok: false, code: 'PLUGIN_ERROR', message: (err as Error).message, logs: '', durationMs: 0 })
      }
    }
  }

  private log(child: ChildProcess, level: string, text: string): void {
    if (!text) return
    if (this.options.onLog) return this.options.onLog(level, text)
    const line = `[plugin ${this.pluginId}${child === this.child ? '' : ' (encerrado)'}] ${text}`
    if (level === 'error' || level === 'warn') console.error(line)
    else console.log(line)
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private scheduleIdle(): void {
    if (!this.child || this.calls.size || this.zombies.size) return
    this.clearIdle()
    this.idleTimer = setTimeout(() => void this.terminate(), this.options.idleMs ?? PLUGIN_IDLE_MS)
    this.idleTimer.unref()
  }
}
