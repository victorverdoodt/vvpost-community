import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { netnsAvailable, withoutNetwork } from '../sandbox/os'

export const PYTHON_TIMEOUT_MS = 10_000
/** Teto de memória do script (RLIMIT_AS, só em Linux; no Windows e no macOS o limite não é aplicado). */
const PYTHON_MEMORY_BYTES = 1024 * 1024 * 1024
/** Saída (stdout + stderr) acima disto encerra o processo. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_LOG_CHARS = 20_000
const RESULT_MARK = '\u001evvpost-result:'

export type PythonErrorCode = 'PYTHON_NOT_FOUND' | 'PYTHON_ERROR' | 'TIMEOUT' | 'ABORTED'

/** `python`: a versão do interpretador que rodou o script (ex.: "3.12.3"), quando ele chegou a rodar. */
export type PythonOutcome =
  | { ok: true; output: unknown; logs: string; durationMs: number; python?: string }
  | { ok: false; code: PythonErrorCode; message: string; logs: string; durationMs: number; python?: string }

export interface PythonRunOptions {
  timeoutMs?: number
  signal?: AbortSignal
  /** Executável e argumentos iniciais; padrão: VVPOST_PYTHON, ou python3/python (py -3 no Windows). */
  interpreter?: string[]
  /** Hosts que o script pode acessar (python.network do nó); vazio ou ausente: sem rede. */
  network?: string[]
  /** Versão mínima pedida pelo nó (python.version, ex.: "3.11"); um Python mais antigo falha sem rodar o script. */
  version?: string
}

/**
 * Lado Python do protocolo: lê {code, nodes} do stdin, roda o código com `nodes`
 * no escopo, captura os print() como logs e escreve uma linha com o resultado
 * (marcada, para não se confundir com algo que o script escreva direto no stdout).
 */
const BOOTSTRAP = String.raw`
import sys, json, io, contextlib, traceback
def _vvpost_guard(rules):
    # Audit hook (PEP 578): rede só para os hosts de python.network; sem subprocessos, ctypes nem gc.get_objects.
    import _socket
    rules = tuple(str(r).lower() for r in rules)
    allowed_ips = set()
    state = {'busy': False}
    blocked = {
        'subprocess.Popen', 'os.system', 'os.exec', 'os.posix_spawn', 'os.spawn', 'os.fork', 'os.forkpty',
        'os.startfile', 'pty.spawn', 'ctypes.dlopen', 'ctypes.dlsym', 'ctypes.dlsym/handle', 'ctypes.call_function',
        'ctypes.cdata', 'ctypes.cdata/buffer', 'ctypes.addressof', 'ctypes.create_string_buffer',
        'ctypes.create_unicode_buffer', 'ctypes.string_at', 'ctypes.wstring_at', 'gc.get_objects', 'gc.get_referrers',
        'gc.get_referents', 'os.add_dll_directory', 'socket.bind', 'socket.sethostname'
    }
    blocked_modules = {'ctypes', '_ctypes', 'cffi', '_cffi_backend'}

    def match(rule, host, port):
        if rule == '*':
            return True
        h = host.lower().rstrip('.')
        if h.startswith('[') and h.endswith(']'):
            h = h[1:-1]
        r, rport = rule, None
        if r.startswith('['):
            end = r.index(']')
            rest, r = r[end + 1:], r[1:end]
            if rest.startswith(':'):
                rport = int(rest[1:])
        elif r.count(':') == 1:
            r, p = r.split(':')
            rport = int(p)
        if rport is not None and port is not None and int(port) != rport:
            return False
        if r.startswith('*.'):
            return h.endswith(r[1:]) and len(h) > len(r) - 1
        return h == r

    def is_ip(host):
        for family in (_socket.AF_INET, _socket.AF_INET6):
            try:
                _socket.inet_pton(family, host)
                return True
            except (OSError, ValueError):
                pass
        return False

    def deny(what):
        raise PermissionError('[VVPost] %s não está liberado em "Rede" do nó Python (python.network)' % what)

    def text(host):
        if isinstance(host, (bytes, bytearray)):
            return bytes(host).decode('ascii', 'replace')
        return str(host)

    def allow_name(host, port):
        if not any(match(r, host, port) for r in rules):
            deny('o host %s' % host)
        state['busy'] = True
        try:
            for info in _socket.getaddrinfo(host, port or 0):
                allowed_ips.add(info[4][0].split('%')[0].lower())
        except OSError:
            pass
        finally:
            state['busy'] = False

    def check_address(address, what):
        if address is None:
            return
        if not isinstance(address, tuple):
            deny('o socket local %s' % text(address))
        host, port = text(address[0]), address[1] if len(address) > 1 else None
        if is_ip(host):
            if host.lower() in allowed_ips or any(match(r, host, port) for r in rules):
                return
            deny('%s %s' % (what, host))
        allow_name(host, port)

    def hook(event, args):
        if state['busy']:
            return
        if event in blocked:
            raise PermissionError('[VVPost] %s está bloqueado no nó Python com a rede restrita' % event)
        if event == 'import' and args and str(args[0]).split('.')[0] in blocked_modules:
            raise PermissionError('[VVPost] o módulo %s está bloqueado no nó Python com a rede restrita' % args[0])
        if event == 'socket.getaddrinfo':
            if args[0] is None:
                return
            host = text(args[0])
            if is_ip(host):
                if host.lower() in allowed_ips or any(match(r, host, args[1]) for r in rules):
                    return
                deny('o host %s' % host)
            allow_name(host, args[1])
        elif event in ('socket.gethostbyname', 'socket.gethostbyname_ex'):
            allow_name(text(args[0]), None)
        elif event in ('socket.gethostbyaddr', 'socket.getnameinfo'):
            deny('a consulta reversa de DNS')
        elif event == 'socket.connect':
            check_address(args[1], 'a conexão a')
        elif event in ('socket.sendto', 'socket.sendmsg'):
            check_address(args[1], 'o envio para')

    sys.addaudithook(hook)

def _vvpost_main():
    req = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    found = '%d.%d.%d' % sys.version_info[:3]
    wanted = req.get('version')
    if wanted and sys.version_info[:2] < tuple(int(x) for x in wanted.split('.')):
        out = json.dumps({'ok': False, 'version': wanted, 'python': found, 'logs': ''})
        sys.__stdout__.write('\n' + ${JSON.stringify(RESULT_MARK)} + out + '\n')
        sys.__stdout__.flush()
        return
    limit = req.get('memoryBytes')
    if limit and sys.platform.startswith('linux'):
        try:
            import resource
            resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
        except Exception:
            pass
    network = req.get('network') or []
    if '*' not in network:
        _vvpost_guard(network)
    logs = io.StringIO()
    scope = {'__name__': '__vvpost__', 'nodes': req['nodes'], 'output': None}
    try:
        with contextlib.redirect_stdout(logs):
            exec(compile(req['code'], '<script>', 'exec'), scope)
        payload = {'ok': True, 'output': scope.get('output')}
    except BaseException as e:
        frames = [f for f in traceback.extract_tb(e.__traceback__) if f.filename == '<script>']
        where = (' (linha %d)' % frames[-1].lineno) if frames else ''
        if isinstance(e, SyntaxError) and e.lineno:
            where = ' (linha %d)' % e.lineno
        payload = {'ok': False, 'error': '%s: %s%s' % (type(e).__name__, e, where)}
    payload['logs'] = logs.getvalue()
    payload['python'] = found
    try:
        out = json.dumps(payload, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as e:
        out = json.dumps({'ok': False, 'error': 'output não é serializável em JSON: %s' % e, 'logs': payload['logs']}, ensure_ascii=False)
    sys.__stdout__.write('\n' + ${JSON.stringify(RESULT_MARK)} + out + '\n')
    sys.__stdout__.flush()
_vvpost_main()
`

let detected: Promise<string[] | null> | null = null

/** Candidatos na ordem: VVPOST_PYTHON, python3/python (py -3 e python no Windows). */
function candidates(): string[][] {
  const custom = process.env['VVPOST_PYTHON']?.trim()
  if (custom) return [[custom]]
  return process.platform === 'win32' ? [['python'], ['py', '-3'], ['python3']] : [['python3'], ['python']]
}

function probe(cmd: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd[0]!, [...cmd.slice(1), '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'], {
      stdio: 'ignore',
      windowsHide: true
    })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
}

/** Primeiro Python 3.8+ disponível no PATH; o resultado fica em cache. */
export function findPython(): Promise<string[] | null> {
  return (detected ??= (async () => {
    for (const cmd of candidates()) if (await probe(cmd)) return cmd
    return null
  })())
}

/** Ambiente mínimo do subprocesso: nenhuma variável do app (tokens, chaves de nuvem) chega ao script. */
function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' }
  for (const name of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'LANG', 'TZ']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

/**
 * Nó Python: o script roda num subprocesso separado, em modo isolado
 * (-I: sem PYTHONPATH nem site do usuário), numa pasta temporária vazia, com
 * ambiente mínimo, teto de tempo e de saída. Os dados chegam pelo stdin como JSON
 * e o resultado volta pelo stdout.
 *
 * Rede: só para os hosts de `network` (python.network do nó). Um audit hook recusa
 * DNS e conexões fora deles e, com a rede restrita, subprocessos, ctypes e a varredura
 * de objetos do gc; sem rede nenhuma, no Linux o processo ainda roda num namespace de
 * rede vazio (sandbox/os.ts). Os arquivos seguem com o acesso do usuário.
 */
export async function runPython(code: string, nodes: unknown, options: PythonRunOptions = {}): Promise<PythonOutcome> {
  const start = performance.now()
  const elapsed = () => Math.round(performance.now() - start)
  const fail = (code: PythonErrorCode, message: string, logs = ''): PythonOutcome => ({
    ok: false,
    code,
    message,
    logs,
    durationMs: elapsed()
  })
  if (options.signal?.aborted) return fail('ABORTED', 'Execução cancelada')
  const interpreter = options.interpreter ?? (await findPython())
  if (!interpreter) {
    return fail('PYTHON_NOT_FOUND', 'Python 3 não encontrado no PATH. Instale o Python 3.8+ ou aponte VVPOST_PYTHON para o executável.')
  }
  const cwd = await mkdtemp(join(tmpdir(), 'vvpost-python-'))
  const timeoutMs = options.timeoutMs ?? PYTHON_TIMEOUT_MS
  const network = options.network ?? []
  const args = [...interpreter.slice(1), '-I', '-X', 'utf8', '-c', BOOTSTRAP]
  const cmd = !network.length && (await netnsAvailable()) ? withoutNetwork(interpreter[0]!, args) : { command: interpreter[0]!, args }
  try {
    return await new Promise<PythonOutcome>((resolve) => {
      const child = spawn(cmd.command, cmd.args, {
        cwd,
        env: minimalEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let size = 0
      let killedFor: { code: PythonErrorCode; message: string } | null = null
      const kill = (code: PythonErrorCode, message: string) => {
        if (killedFor) return
        killedFor = { code, message }
        child.kill('SIGKILL')
      }
      const timer = setTimeout(() => kill('TIMEOUT', `O script passou de ${timeoutMs} ms e foi encerrado`), timeoutMs)
      const onAbort = () => kill('ABORTED', 'Execução cancelada')
      options.signal?.addEventListener('abort', onAbort)
      const collect = (into: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_OUTPUT_BYTES) kill('PYTHON_ERROR', 'O script escreveu mais de 16 MB de saída')
        else into.push(chunk)
      }
      child.stdout.on('data', collect(stdout))
      child.stderr.on('data', collect(stderr))
      child.on('error', (err) => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        resolve(fail('PYTHON_NOT_FOUND', `Não foi possível iniciar o Python (${interpreter.join(' ')}): ${err.message}`))
      })
      child.on('close', (exitCode) => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        // No Windows o stdout em modo texto troca \n por \r\n.
        const out = Buffer.concat(stdout).toString('utf8').replace(/\r\n/g, '\n')
        const markAt = out.lastIndexOf(RESULT_MARK)
        // O que estiver antes da marca foi escrito direto no stdout (sys.__stdout__, subprocessos).
        const direct = (markAt < 0 ? out : out.slice(0, markAt)).replace(/\n$/, '')
        const err = Buffer.concat(stderr).toString('utf8').replace(/\r\n/g, '\n').replace(/\n$/, '')
        const logsWith = (printed = '') => trimLogs([printed.replace(/\n$/, ''), direct, err].filter(Boolean).join('\n'))
        if (killedFor) return resolve(fail(killedFor.code, killedFor.message, logsWith()))
        // Dentro do namespace de rede, um interpretador que não existe é o unshare saindo com 127.
        if (markAt < 0 && cmd.command === 'unshare' && exitCode === 127 && /unshare: failed to execute/.test(err)) {
          return resolve(fail('PYTHON_NOT_FOUND', `Não foi possível iniciar o Python (${interpreter.join(' ')}): ${err.split('\n').pop()}`))
        }
        if (markAt < 0) {
          const last = err.trim().split('\n').pop()
          return resolve(fail('PYTHON_ERROR', `O processo Python saiu (código ${exitCode}) sem resultado${last ? `: ${last}` : ''}`, logsWith()))
        }
        let parsed: { ok: boolean; output?: unknown; error?: string; logs?: string; python?: string; version?: string }
        try {
          parsed = JSON.parse(out.slice(markAt + RESULT_MARK.length).trim())
        } catch {
          return resolve(fail('PYTHON_ERROR', 'Resultado do Python ilegível', logsWith()))
        }
        const logs = logsWith(parsed.logs)
        const python = parsed.python ? { python: parsed.python } : {}
        if (parsed.version) {
          return resolve({
            ...fail(
              'PYTHON_NOT_FOUND',
              `O nó pede o Python ${parsed.version} ou mais novo, e o encontrado (${interpreter.join(' ')}) é o ${parsed.python}. Instale o ${parsed.version}+ ou aponte VVPOST_PYTHON para ele.`,
              logs
            ),
            ...python
          })
        }
        if (!parsed.ok) return resolve({ ...fail('PYTHON_ERROR', parsed.error ?? 'erro no script', logs), ...python })
        resolve({ ok: true, output: parsed.output ?? null, logs, durationMs: elapsed(), ...python })
      })
      child.stdin.on('error', () => undefined)
      child.stdin.end(JSON.stringify({ code, nodes, memoryBytes: PYTHON_MEMORY_BYTES, network, version: options.version }))
    })
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined)
  }
}

function trimLogs(text: string): string {
  return text.length > MAX_LOG_CHARS ? `${text.slice(0, MAX_LOG_CHARS)}\n… (logs cortados)` : text
}
