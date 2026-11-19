# Prontidão: o que impede de rodar

Um workspace pode parecer saudável e não conseguir rodar nada. O catálogo lê normal, os conectores
resolvem, os endpoints aparecem na tela, e todo cenário falha minutos depois porque o segredo não
tem valor nesta máquina, o ambiente não define uma variável da `baseUrl` ou a API local não está de
pé. Quem descobre isso rodando os cenários perde tempo, e um agente de IA costuma ler a falha como
defeito do código.

A prontidão confere isso antes, por ambiente, e devolve **todos os bloqueios de uma vez**, cada um
com o próximo passo. A ideia veio do `check_readiness` do Auto-Ontology da NVIDIA, que separa
"o catálogo lê" de "alguma coisa consegue rodar".

## Como usar

| Onde | Como |
| --- | --- |
| Terminal e CI | `vvpost doctor` (`--env dev`, `--no-probe`, `--json -`). Sai com 0 quando está pronto e 2 com bloqueio. Os segredos do CI (`VVPOST_SECRET_*`, `--secrets`, `--var`) entram antes da conferência, como no `vvpost run`. |
| Agente (MCP) | `check_readiness` (`environmentIds`, `probe`). As instruções do servidor pedem para chamar antes do primeiro `execute_dry_run` e quando um disparo falhar sem motivo claro. Fica no perfil `contrato` e no `tudo`. |

## O que é conferido

Para cada ambiente (ou "sem ambiente", quando o workspace não tem nenhum), olhando o que todo
request de cada conector usa: `baseUrl`, `basePath`, headers e auth, com a herança aplicada.

| Código | Nível | Quando |
| --- | --- | --- |
| `missing-secret` | bloqueio | Um segredo usado pela auth, pelos headers ou pela `baseUrl` não tem valor no cofre local nem no CI. O hint traz o `vvpost secrets set`. |
| `missing-secret` | aviso | Um segredo do ambiente sem valor que nenhum conector usa nesses campos (um cenário ou fluxo ainda pode usar). |
| `undefined-variable` | bloqueio | O conector usa `{{VAR}}` e o ambiente não declara `VAR`. |
| `no-base-url`, `invalid-url` | bloqueio | O conector não tem `baseUrl` com endpoints relativos, ou a URL montada (inclusive a do token ou do login) não é `http(s)`. |
| `unreachable` | bloqueio | A origem da `baseUrl` ou da URL do token não abre conexão TCP: recusada, DNS que não resolve, rede sem rota ou sem resposta em 3 s. |
| `connector-error` | bloqueio | O conector não resolve (pai ausente, ciclo no `extends`). |
| `empty-catalog` | bloqueio | O projeto não tem conectores. |
| `file-ignored` | aviso | Um arquivo ficou de fora do catálogo (o `vvpost validate` mostra o problema). |

No MCP entram também os achados de nível `agent`, que limitam só a IA (o usuário roda normalmente):
ambiente protegido (`protected`), ambiente fora do `--allow-env` (`not-allowed`), servidor em
`--read-only` e conector ou fluxo esperando a revisão do usuário (`review-pending`). Cada ambiente
traz `canExecute` e, no MCP, `agentCanExecute`.

## O que não é conferido

A resposta lista em `unverified` o que a verificação não cobre, para ninguém ler "pronto" como mais do
que é:

- **A auth.** Credencial aceita e token emitido só se confirmam rodando um cenário.
- **TLS, rota e status.** A sondagem só abre a conexão TCP e fecha: nenhum byte vai para a API, então
  ela vale também para ambientes protegidos.
- **Origens atrás de proxy.** Quando o cliente HTTP usa proxy para aquela origem, a conexão direta
  não diz nada, e a origem fica com `ok: null`.

Nenhum valor de segredo aparece na saída: o relatório passa pelo Secret Sanitizer, e os segredos
aparecem só pelo nome.
