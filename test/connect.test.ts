import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { connectRepo, detectClients, type ConnectOptions } from '../src/main/mcp/connect'

// vvpost connect: o servidor MCP em cada cliente de IA e a regra do VVPost no repositório, num passo.

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vvpost-connect-'))
  dirs.push(dir)
  return dir
}

/** Um claude/codex de mentira: guarda os comandos e responde ao mcp get com o que foi registrado. */
function fakeCli(installed: string[] = ['claude', 'codex']) {
  const calls: string[] = []
  const registered = new Map<string, string>()
  const run: NonNullable<ConnectOptions['run']> = async (command, args) => {
    calls.push(`${command} ${args.join(' ')}`)
    if (!installed.includes(command)) return { code: null, stdout: '' }
    if (args[0] === '--version') return { code: 0, stdout: '1.0' }
    if (args[1] === 'get') return registered.has(command) ? { code: 0, stdout: registered.get(command)! } : { code: 1, stdout: '' }
    if (args[1] === 'add') registered.set(command, args.join(' '))
    if (args[1] === 'remove') registered.delete(command)
    return { code: 0, stdout: '' }
  }
  return { run, calls }
}

const stdio = { transport: 'stdio' as const, command: '/usr/bin/node', args: ['/app/mcp.js', '--workspace', '/ws', '--project', 'estoque', '--repo', '/code'] }

describe('vvpost connect', () => {
  it('registra o servidor nos quatro clientes e grava a regra no CLAUDE.md e no AGENTS.md, uma vez só', async () => {
    const dir = repo()
    mkdirSync(join(dir, '.cursor'))
    writeFileSync(join(dir, '.cursor/mcp.json'), JSON.stringify({ mcpServers: { outro: { command: 'x' } } }))
    const { run, calls } = fakeCli()
    const options: ConnectOptions = { repo: dir, workspace: '/ws', project: 'estoque', clients: ['claude', 'cursor', 'vscode', 'codex'], endpoint: stdio, run }
    const steps = await connectRepo(options)
    expect(steps.map((s) => [s.client, s.action])).toEqual([
      ['claude', 'created'],
      ['cursor', 'updated'],
      ['vscode', 'created'],
      ['codex', 'created'],
      ['rule', 'created'],
      ['rule', 'created']
    ])
    expect(calls).toContain('claude mcp add --scope local vvpost -- /usr/bin/node /app/mcp.js --workspace /ws --project estoque --repo /code')
    expect(calls).toContain('codex mcp add vvpost -- /usr/bin/node /app/mcp.js --workspace /ws --project estoque --repo /code')
    // O servidor que a pessoa já tinha no Cursor fica.
    expect(JSON.parse(readFileSync(join(dir, '.cursor/mcp.json'), 'utf8')).mcpServers).toEqual({
      outro: { command: 'x' },
      vvpost: { command: '/usr/bin/node', args: stdio.args }
    })
    expect(JSON.parse(readFileSync(join(dir, '.vscode/mcp.json'), 'utf8')).servers.vvpost).toEqual({ type: 'stdio', command: '/usr/bin/node', args: stdio.args })
    for (const file of ['CLAUDE.md', 'AGENTS.md']) {
      const text = readFileSync(join(dir, file), 'utf8')
      expect(text).toContain('<!-- vvpost:docs -->')
      expect(text).toContain('projeto `estoque`')
    }

    const again = await connectRepo(options)
    expect(again.every((s) => s.action === 'unchanged')).toBe(true)
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8').split('<!-- vvpost:docs -->')).toHaveLength(2)
  })

  it('sem o CLI do cliente, devolve o comando para rodar à mão; dry-run não grava nada', async () => {
    const dir = repo()
    const { run } = fakeCli([])
    const steps = await connectRepo({ repo: dir, workspace: '/ws', clients: ['claude'], endpoint: stdio, run, dryRun: true })
    expect(steps[0]).toMatchObject({ client: 'claude', action: 'manual' })
    expect(steps[0]!.command).toContain('claude mcp add --scope local vvpost -- /usr/bin/node /app/mcp.js')
    expect(steps[1]).toMatchObject({ client: 'rule', action: 'created' })
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false)
  })

  it('com o servidor HTTP do app e token, o arquivo do cliente lê o token do ambiente, nunca o valor', async () => {
    const dir = repo()
    const { run, calls } = fakeCli()
    await connectRepo({ repo: dir, workspace: '/ws', clients: ['claude', 'cursor', 'vscode'], endpoint: { transport: 'http', url: 'http://127.0.0.1:4470', token: true }, run })
    expect(calls).toContain('claude mcp add --scope local --transport http vvpost http://127.0.0.1:4470/mcp --header Authorization: Bearer ${VVPOST_MCP_TOKEN}')
    expect(JSON.parse(readFileSync(join(dir, '.cursor/mcp.json'), 'utf8')).mcpServers.vvpost).toEqual({
      url: 'http://127.0.0.1:4470/mcp',
      headers: { Authorization: 'Bearer ${env:VVPOST_MCP_TOKEN}' }
    })
    expect(JSON.parse(readFileSync(join(dir, '.vscode/mcp.json'), 'utf8')).servers.vvpost.type).toBe('http')
  })

  it('recusa um mcp.json quebrado em vez de sobrescrever', async () => {
    const dir = repo()
    mkdirSync(join(dir, '.cursor'))
    writeFileSync(join(dir, '.cursor/mcp.json'), '{ quebrado')
    await expect(connectRepo({ repo: dir, workspace: '/ws', clients: ['cursor'], endpoint: stdio, run: fakeCli().run })).rejects.toThrow('JSON válido')
    expect(readFileSync(join(dir, '.cursor/mcp.json'), 'utf8')).toBe('{ quebrado')
  })

  it('detecta os clientes pelo repositório e pela máquina; nenhum: Claude Code', async () => {
    const dir = repo()
    expect(await detectClients(dir, fakeCli([]).run)).toEqual(['claude'])
    mkdirSync(join(dir, '.vscode'))
    expect(await detectClients(dir, fakeCli(['codex']).run)).toEqual(['vscode', 'codex'])
  })
})

describe('vvpost connect pelo CLI', () => {
  it('liga o repositório ao workspace com o servidor stdio ao lado do CLI e recusa o próprio workspace', async () => {
    const { main } = await import('../src/main/cli')
    const ws = repo()
    const code = repo()
    let stdout = ''
    let stderr = ''
    const io = {
      stdout: (t: string) => void (stdout += t),
      stderr: (t: string) => void (stderr += t),
      env: {},
      cwd: ws,
      isTTY: false,
      appDir: ws,
      self: ['/usr/bin/node', '/app/out/main/cli.js']
    }
    expect(await main(['connect', code, '--client', 'cursor'], io)).toBe(0)
    expect(stdout).toContain('Pronto')
    expect(JSON.parse(readFileSync(join(code, '.cursor/mcp.json'), 'utf8')).mcpServers.vvpost).toEqual({
      command: '/usr/bin/node',
      args: [join('/app/out/main', 'mcp.js'), '--workspace', ws, '--repo', code]
    })
    expect(readFileSync(join(code, 'AGENTS.md'), 'utf8')).toContain(`workspace VVPost \`${ws}\``)
    expect(await main(['connect', ws, '--client', 'cursor'], io)).toBe(2)
    expect(stderr).toContain('mesma pasta')
    expect(await main(['connect', code, '--client', 'zed'], io)).toBe(2)
  })
})
