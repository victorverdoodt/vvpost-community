import type { Io } from './index'

/**
 * `vvpost secrets`: os valores das variáveis secretas no cofre local, sem o app. O valor nunca
 * entra pela linha de comando (fica no histórico do shell e na lista de processos): vem do
 * prompt sem eco no terminal ou do stdin num pipe. Nenhum comando mostra um valor.
 */

export const SECRETS_HELP = `Uso: vvpost secrets <list | set | rm> [opções]

  vvpost secrets list                  Cada variável secreta por ambiente: configurada ou pendente
  vvpost secrets set <ambiente> <VAR>  Grava o valor no cofre local. No terminal, pede o valor sem
                                       mostrar; num pipe, lê do stdin (ex.: pass show api | vvpost
                                       secrets set dev API_TOKEN)
  vvpost secrets rm <ambiente> <VAR>   Apaga o valor do cofre local

Opções:
  --workspace <pasta>   Workspace VVPost (padrão: $VVPOST_WORKSPACE ou a pasta atual)
  --project <id>        Projeto do workspace (padrão: $VVPOST_PROJECT). Cada projeto tem o seu cofre,
                        que vence o do Compartilhado no mesmo ambiente
  --json -              list em JSON no stdout

O cofre fica fora da pasta do workspace, cifrado, com a chave no cofre do sistema. Só variáveis
declaradas com "isSecret": true num ambiente aceitam valor.
`

type Row = { environment: string; variable: string; state: 'configured' | 'missing' }

export async function secretsCommand(dir: string, io: Io, args: string[], asJson: boolean): Promise<number> {
  const [action, envId, variable, ...rest] = args
  if (action === undefined || action === 'help') {
    io.stdout(SECRETS_HELP)
    return action === undefined ? 2 : 0
  }
  if (!['list', 'set', 'rm'].includes(action)) {
    io.stderr(`vvpost secrets: ação desconhecida "${action}" (use list, set ou rm)\n`)
    return 2
  }
  const expected = action === 'list' ? 0 : 2
  const given = [envId, variable, ...rest].filter((a) => a !== undefined).length
  if (given !== expected) {
    io.stderr(action === 'list' ? `vvpost secrets list: argumento inesperado "${envId}"\n` : `vvpost secrets ${action}: use vvpost secrets ${action} <ambiente> <VAR>${given > 2 ? ' (o valor não vai na linha de comando: digite no prompt ou mande pelo stdin)' : ''}\n`)
    return 2
  }
  const [{ loadWorkspace }, { mergeSecrets }, { updateVault }] = await Promise.all([
    import('@vvpost/core/connectors/workspace'),
    import('../workspace/vault'),
    import('@vvpost/core/vault')
  ])
  const ws = await loadWorkspace(dir)
  const vaultProblem = ws.issues.find((i) => /cofre|secrets\.local\.json/.test(i.file))
  if (vaultProblem) {
    io.stderr(`vvpost secrets: ${vaultProblem.message}\n`)
    return 2
  }

  if (action === 'list') {
    const rows: Row[] = []
    for (const [id, env] of [...ws.environments].sort(([a], [b]) => a.localeCompare(b))) {
      for (const [name, v] of Object.entries(env.variables)) {
        if (!v.isSecret) continue
        const value = ws.secrets[id]?.[name]
        rows.push({ environment: id, variable: name, state: value !== undefined && value !== '' && value !== '__REQUIRED_SECRET__' ? 'configured' : 'missing' })
      }
    }
    if (asJson) {
      io.stdout(`${JSON.stringify({ secrets: rows }, null, 2)}\n`)
      return 0
    }
    if (rows.length === 0) {
      io.stdout('Nenhuma variável secreta nos ambientes do workspace.\n')
      return 0
    }
    const width = Math.max(...rows.map((r) => `${r.environment}  ${r.variable}`.length))
    for (const r of rows) io.stdout(`${`${r.environment}  ${r.variable}`.padEnd(width)}  ${r.state === 'configured' ? 'configurado' : 'pendente'}\n`)
    const missing = rows.filter((r) => r.state === 'missing').length
    if (missing) io.stdout(`\n${missing} pendente(s): vvpost secrets set <ambiente> <VAR>\n`)
    return 0
  }

  const env = ws.environments.get(envId!)
  if (!env) {
    io.stderr(`vvpost secrets: ambiente "${envId}" não existe (${[...ws.environments.keys()].join(', ') || 'nenhum ambiente'})\n`)
    return 2
  }
  const declared = env.variables[variable!]
  if (action === 'set' && !declared?.isSecret) {
    io.stderr(
      declared
        ? `vvpost secrets: ${variable} não é secreta em ${envId}; marque "isSecret": true e "value": "__REQUIRED_SECRET__" no ambiente antes de gravar o valor no cofre\n`
        : `vvpost secrets: ${envId} não declara ${variable}; declare a variável com "isSecret": true no ambiente\n`
    )
    return 2
  }

  if (action === 'rm') {
    let had = false
    await updateVault(dir, (store) => {
      had = store[envId!]?.[variable!] !== undefined
      if (had) delete store[envId!]![variable!]
    })
    io.stdout(had ? `${envId}/${variable}: removido do cofre local\n` : `${envId}/${variable}: não havia valor neste cofre\n`)
    return 0
  }

  if (!io.readSecret) {
    io.stderr('vvpost secrets set: sem terminal nem stdin para ler o valor\n')
    return 2
  }
  const value = await io.readSecret(`Valor de ${variable} em ${envId}: `)
  if (value === '') {
    io.stderr('vvpost secrets set: valor vazio; nada foi gravado\n')
    return 2
  }
  await mergeSecrets(dir, [{ environmentId: envId!, variable: variable!, value }])
  io.stdout(`${envId}/${variable}: gravado no cofre local\n`)
  return 0
}
