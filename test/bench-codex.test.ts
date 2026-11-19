import { describe, expect, it } from 'vitest'
import { argumentosCodex, medirCodex, respostaFinalCodex } from '../bench/agentes/codex.mjs'

// O Codex como agente do benchmark: os argumentos do exec e a leitura do --json (formato de exec/src/exec_events.rs).

const linhas = [
  { type: 'thread.started', thread_id: 't1' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'pensando' } },
  { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'npm test', aggregated_output: 'ok', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: 'i2', type: 'mcp_tool_call', server: 'vvpost', tool: 'get_api_catalog', arguments: {}, status: 'completed' } },
  { type: 'item.completed', item: { id: 'i3', type: 'mcp_tool_call', server: 'vvpost', tool: 'edit_project', arguments: {}, status: 'failed', error: { message: 'x' } } },
  { type: 'item.completed', item: { id: 'i4', type: 'file_change', changes: [{ path: 'a.js', kind: 'update' }], status: 'completed' } },
  { type: 'item.completed', item: { id: 'i5', type: 'agent_message', text: 'primeira' } },
  { type: 'item.completed', item: { id: 'i6', type: 'agent_message', text: 'Pronto: o endpoint mudou.' } },
  { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 10 } }
].map((e) => JSON.stringify(e))

describe('Codex no benchmark de agentes', () => {
  it('conta passos, chamadas ao MCP, erros e tokens do --json', () => {
    const m = medirCodex([...linhas, 'linha cortada {'], { duracaoMs: 1234, modelo: 'gpt-x' })
    expect(m).toMatchObject({ agente: 'codex', modelo: 'gpt-x', turnos: 1, passos: 4, passosMcp: 2, errosDeFerramenta: 1, ferramentasComErro: ['mcp__vvpost__edit_project'], duracaoMs: 1234, custoUsd: null, terminou: true })
    expect(m.porFerramenta).toEqual({ Bash: 1, 'mcp__vvpost__get_api_catalog': 1, 'mcp__vvpost__edit_project': 1, Edit: 1 })
    expect(m.tokens).toEqual({ entrada: 400, escritaCache: 0, leituraCache: 600, saida: 50, total: 1050 })
  })

  it('a resposta final é a última mensagem do agente; turno com falha não terminou', () => {
    expect(respostaFinalCodex(linhas)).toBe('Pronto: o endpoint mudou.')
    expect(medirCodex([...linhas, JSON.stringify({ type: 'turn.failed', error: { message: 'cota' } })]).terminou).toBe(false)
  })

  it('o exec recebe o MCP do VVPost, o CLAUDE.md como AGENTS.md e nada do config do usuário', () => {
    const argv = argumentosCodex({ prompt: 'faça', modelo: 'gpt-x', mcp: { mcpServers: { vvpost: { command: '/bin/node', args: ['mcp.js', '--workspace', '/w'] } } } })
    expect(argv.slice(0, 3)).toEqual(['exec', '--json', '--ignore-user-config'])
    expect(argv).toContain('project_doc_fallback_filenames=["CLAUDE.md"]')
    expect(argv).toContain('mcp_servers.vvpost.args=["mcp.js","--workspace","/w"]')
    expect(argv.at(-1)).toBe('faça')
    expect(argv).toEqual(expect.arrayContaining(['-m', 'gpt-x']))
    expect(argumentosCodex({ prompt: 'p', modelo: null, mcp: { mcpServers: {} } }).join(' ')).not.toContain('mcp_servers')
  })
})
