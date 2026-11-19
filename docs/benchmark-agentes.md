# Benchmark de agentes: a mesma tarefa com e sem o VVPost

Este benchmark responde a uma pergunta: numa tarefa real de manutenção (mudar o código, os testes e
a documentação da API), um agente de IA gasta menos passos, tokens e dinheiro com o VVPost do que
com os arquivos e as ferramentas comuns de um repositório? O código, as tarefas, o corretor e os
dados brutos ficam em [`bench/agentes/`](../bench/agentes/), e qualquer pessoa pode rodar de novo.

## Resultado

O benchmark tem 5 tarefas e 2 variantes, com 6 rodadas de cada, num total de 60. Usa o Claude Code
2.1.310 com o modelo `claude-sonnet-5-5` e o MCP do commit `b451360`. Cada célula traz a média e,
entre parênteses, o mínimo e o máximo. A última coluna é o intervalo de 95% da diferença das médias
(VVPost menos baseline), calculado por bootstrap.

| Tarefa | Métrica | Sem o VVPost | Com o VVPost | Diferença | IC 95% |
| --- | --- | --- | --- | --- | --- |
| Alterar um endpoint | Passos | 11,8 (4–25) | 11,7 (7–18) | −1% | −7,0 a +6,2 |
| | Custo | US$ 0,15 | US$ 0,16 | +7% | −US$ 0,03 a +US$ 0,05 |
| Remover uma dependência | Passos | 28,0 (22–37) | 19,3 (16–23) | −31% | −13,3 a −4,0 |
| | Custo | US$ 0,22 | US$ 0,20 | −8% | −US$ 0,06 a +US$ 0,03 |
| Novo endpoint | Passos | 27,8 (20–32) | 21,5 (18–25) | −23% | −10,0 a −2,5 |
| | Custo | US$ 0,33 | US$ 0,29 | −13% | −US$ 0,09 a +US$ 0,00 |
| Consultar a API | Passos | 5,8 (5–7) | 4,5 (4–6) | −23% | −2,2 a −0,5 |
| | Custo | US$ 0,05 | US$ 0,06 | +19% | +US$ 0,01 a +US$ 0,02 |
| Atualizar uma integração | Passos | 13,7 (5–19) | 13,5 (12–18) | −1% | −3,8 a +4,3 |
| | Custo | US$ 0,13 | US$ 0,15 | +18% | +US$ 0,01 a +US$ 0,04 |
| **Todas** | Passos | 17,4 | 14,1 | −19% | −7,7 a +0,8 |
| | Tokens | 232 mil | 266 mil | +15% | −29 mil a +97 mil |
| | Custo | US$ 0,18 | US$ 0,17 | **−2%** | −US$ 0,05 a +US$ 0,04 |
| | Duração | 53 s | 44 s | −17% | −24 s a +5 s |

As duas variantes acertaram tudo: 30 de 30 rodadas corretas em cada uma. **Credenciais:** na tarefa
de consultar a API, a chave da homologação apareceu na transcrição do agente em 6 de 6 rodadas sem o
VVPost e em nenhuma com ele. A tabela completa, com turnos, chamadas ao MCP, erros e comandos negados
por tarefa, está em
[`resultados/2026-10-26-mcp-atual/resumo.md`](../bench/agentes/resultados/2026-10-26-mcp-atual/resumo.md).

**No conjunto, o custo empata (−2%, dentro da variação), a qualidade é a mesma e o agente usa, em
média, menos passos e menos tempo com o VVPost.** Os intervalos do conjunto para passos e duração
ainda incluem nenhuma diferença, então a redução é tendência, não resultado firme; ela é clara em
duas tarefas. O VVPost não reduz o custo, mas também não o aumenta. Por tarefa:

- **Quando a mudança se espalha pela documentação, o VVPost poupa passos.** Ao remover uma
  dependência, foram 31% menos passos e 31% menos tempo; no endpoint novo, 23% menos passos. Sem o
  VVPost, o agente percorre e edita à mão várias specs e páginas. Com ele, `find_references`, um
  `edit_project` e a documentação gerada fazem isso em poucas chamadas.
- **Na mudança pequena e localizada, as duas variantes empatam.** Renomear um campo e acrescentar
  outro custa quase o mesmo (+7%, dentro da variação). Sem o VVPost, o agente troca o campo no YAML
  com o mesmo `sed` que usa no código. Com o VVPost, é um `edit_project` com a troca, o campo novo e o
  trecho do guia.
- **A consulta à API e a troca de versão da integração custam um pouco mais.** São US$ 0,01 e
  US$ 0,02 por rodada, por causa das ferramentas do MCP no contexto. Na consulta, é o que custa
  manter a chave fora do alcance do agente. Sem o VVPost, ele lê a chave do arquivo e a põe num
  `curl`. Com o VVPost, ele chama `execute_dry_run` com `select`.

O MCP responde por uma parte pequena dos tokens de uma rodada (3,3 chamadas por rodada, em média).
O que pesa no custo é o trabalho no código, igual nas duas variantes, e o contexto de cada turno.

O que o benchmark não mede, e onde o VVPost oferece algo que o baseline não tem: cenários que rodam
contra a API, PDF, `CONFLICT` quando uma pessoa edita ao mesmo tempo, validação de herança e de
credenciais e o `vvpost validate` no CI.

## O que foi comparado

### O projeto de exemplo

A Loja API ([`bench/agentes/projeto/`](../bench/agentes/projeto/)) é uma API de pedidos em Node, sem
dependências: produtos, pedidos, cancelamento e frete cotado com duas transportadoras de mentira
(TransNorte, a principal, e EntregaJá, a reserva). Tem 11 testes com `node --test`. É genérica de
propósito: nenhum cliente, projeto ou API real.

As duas variantes têm o mesmo código e os mesmos testes; muda só onde a API está descrita:

| | Sem o VVPost (`baseline/`) | Com o VVPost (`vvpost/`) |
| --- | --- | --- |
| API da Loja | `openapi/loja.yaml` | Conector `loja-api` em `api/flows/`, importado de `loja.yaml` com `vvpost import`, com os schemas compartilhados em `api/schemas/` |
| APIs das transportadoras | `openapi/transnorte.yaml` e `openapi/entregaja.yaml` | Conectores `transnorte` e `entregaja`, importados das mesmas specs |
| Páginas | `docs/arquitetura.md`, `docs/frete.md` e `docs/guia-de-integracao.md` | As mesmas páginas em `api/docs/`, com o documento do projeto em `api/docs/projeto.md`; o guia troca a tabela de endpoints e os exemplos copiados à mão por `{{> endpoint}}` e `{{> connector}}` |
| `CLAUDE.md` | Diz onde ficam a spec e as páginas e pede para atualizá-las junto com o código | Diz onde fica o projeto do VVPost e traz a regra do `vvpost docs agents` |
| Ferramentas extras | Nenhuma | O servidor MCP do VVPost e o comando `vvpost` no `PATH` |

As duas variantes recebem a mesma instrução de manter a documentação junto com o código, para que
o benchmark meça a ferramenta e não o lembrete.

### As tarefas

O pedido é o mesmo nas duas variantes ([`bench/agentes/tarefas/`](../bench/agentes/tarefas/)),
precedido de "Você está no repositório da Loja API. Faça a tarefa abaixo do começo ao fim, sem
perguntar nada.":

| Tarefa | Pedido, em resumo |
| --- | --- |
| `alterar-endpoint` | No `POST /pedidos`, `cep` vira `cepEntrega` no corpo e no pedido devolvido, que ganha `prazoEntregaDias` |
| `remover-dependencia` | A Loja deixa a EntregaJá: o frete passa a ser só pela TransNorte, com 503 quando ela falha |
| `novo-endpoint` | `GET /pedidos/{id}/rastreio`, que consulta `GET /rastreamentos/{codigo}` da TransNorte, com 404 próprios |
| `consultar-api` | Responder quantos pedidos cancelados existem na homologação e quanto somam, chamando a API de verdade (uma Loja API local, com uma chave que o agente não recebe no pedido) |
| `atualizar-integracao` | A TransNorte passa para a v3: nova URL base e o header `X-Cliente-Id` em todas as operações, na spec ou no conector e nas páginas |

As tarefas que mudam a API terminam com "Atualize o código, os testes e a documentação da API."

Na `consultar-api`, o corretor confere a resposta e registra à parte se a chave da homologação
apareceu na transcrição do agente (pura, em base64 ou em hex).

### O agente

| Item | Valor |
| --- | --- |
| Cliente | Claude Code 2.1.310, headless (`claude -p`, `--output-format stream-json`) |
| Modelo | `claude-sonnet-5-5`, o mesmo nas duas variantes (o Claude Code usa um modelo menor em tarefas internas; o custo dele entra no total, abaixo de US$ 0,001 por rodada) |
| Permissões | `--permission-mode acceptEdits` (edita só a cópia do repositório) e a mesma lista de comandos de terminal nas duas variantes: `npm test`, `node --test`, `node -e`, `git status/diff/rm/mv`, `ls`, `grep`, `cat`, `head`, `tail`, `find`, `wc`, `sed` e, na variante com o VVPost, `vvpost`. Comando fora da lista é negado e conta à parte |
| Fora do experimento | Busca na web e subagentes (os passos de um subagente não aparecem na contagem), nas duas variantes |
| Isolamento | Cada rodada numa cópia nova do repositório, com Git, num diretório temporário; só configuração do projeto (`--setting-sources project`), só o MCP do benchmark (`--strict-mcp-config`), sem memória entre rodadas e sem as variáveis de ambiente de quem roda o benchmark além de rede e login; cofre do VVPost próprio de cada rodada |
| Limite | 80 turnos e 30 minutos por rodada (nenhuma rodada chegou perto) |
| MCP | `node out/main/mcp.js --workspace <repo>/api --repo <repo> --stats <arquivo>`, do core no commit `b451360` |

### Rodadas

6 rodadas por tarefa e variante, 4 ao mesmo tempo, numa ordem intercalada (rodada 1 de cada tarefa
nas duas variantes, depois a rodada 2, e assim por diante), para que a hora e a carga da máquina
não favoreçam uma variante.

## O que conta

| Métrica | Definição |
| --- | --- |
| Passo | Uma chamada de ferramenta do agente (`tool_use` na transcrição): ler, editar, rodar um comando, chamar o MCP. Um comando de terminal que faz várias coisas conta como um passo, por isso passos sozinhos não bastam e o benchmark mede também tokens e custo |
| Turno | `num_turns` do resultado do Claude Code |
| Tokens | Soma do `usage` do resultado: entrada, escrita de cache, leitura de cache e saída |
| Custo | `total_cost_usd` do Claude Code: preço de tabela por token, de todos os modelos usados na rodada. Não é a fatura de um plano |
| Erro de ferramenta | Resultado de ferramenta com `is_error`, sem contar os comandos negados pela permissão, que aparecem à parte |
| Duração | `duration_ms` do resultado |

## Qualidade e correção

Depois de cada rodada, [`corrigir.mjs`](../bench/agentes/corrigir.mjs) confere o repositório que o
agente deixou, pelos mesmos critérios nas duas variantes. Uma rodada é correta quando passa nos
cinco:

| Critério | Sem o VVPost | Com o VVPost |
| --- | --- | --- |
| `testes` | `npm test` passa e os testes acompanham a mudança (citam o campo, o rastreio, e não citam mais a EntregaJá) | Igual |
| `aceite` | Testes ocultos da tarefa, que o agente nunca vê, rodam contra o código ([`aceite/`](../bench/agentes/aceite/)) | Igual |
| `valido` | Toda spec em `openapi/` é YAML válido e todo `$ref` tem alvo | `vvpost validate` e `vvpost docs --strict` passam |
| `api` | A spec da Loja tem a mudança: campos e `required` do corpo e das quatro respostas que trazem o pedido, exemplos, o endpoint novo com a resposta 200 e o 404, a API da EntregaJá fora | O mesmo, conferido na spec que `vvpost export --format openapi --connector loja-api` gera do catálogo, e a lista de conectores no lugar dos arquivos de spec |
| `docs` | As páginas, o `README.md` e as specs citam o que mudou e não citam o que saiu (inclusive o `CLAUDE.md`, que listava `entregaja.yaml`), e o guia fala do rastreio | O mesmo, no documento gerado pelo VVPost, nas páginas e em todo arquivo do projeto |

Uma nota de migração ("o campo antigo `cep` não é mais aceito") conta como documentação correta.

[`recorrigir.mjs`](../bench/agentes/recorrigir.mjs) corrige de novo rodadas já feitas: remonta o
repositório de cada rodada pelo `diff.patch` gravado e aplica o corretor atual.

## Dados brutos

Em [`bench/agentes/resultados/2026-10-26-mcp-atual/`](../bench/agentes/resultados/2026-10-26-mcp-atual/):

| Arquivo | Conteúdo |
| --- | --- |
| `rodadas.jsonl` | Uma linha por rodada: versão do Claude Code, modelo, ferramentas disponíveis, passos por ferramenta, erros, comandos negados, tokens, custo, duração e a correção critério a critério |
| `resumo.md`, `resumo.json` | As médias, os mínimos e máximos, o desvio padrão e os intervalos, gerados por `resumir.mjs` |
| `rodadas/<tarefa>.<variante>.<n>/transcricao.jsonl` | A transcrição inteira do Claude Code |
| `rodadas/<…>/diff.patch` | Tudo o que o agente mudou no repositório |
| `rodadas/<…>/mcp-stats.jsonl` | Na variante com o VVPost, uma linha por chamada ao MCP (ferramenta, tempo e tamanho da entrada e da saída) |

## Como reproduzir

```bash
npm ci && npm run build
node bench/agentes/rodar.mjs --rodadas 6 --paralelo 4 --saida bench/agentes/resultados/$(date +%F)
node bench/agentes/resumir.mjs bench/agentes/resultados/$(date +%F)
```

`--tarefas` e `--variantes` escolhem um subconjunto, e `--modelo` troca o modelo. Precisa do
`claude` no `PATH`, com login feito. As 60 rodadas custaram US$ 10,45 no preço de tabela.

`--agente codex` roda as mesmas tarefas com o Codex CLI (`codex exec --json`, no `PATH`, com o login em
`CODEX_HOME` ou `OPENAI_API_KEY`), com `--modelo` opcional (sem ele, o padrão do Codex). O Codex roda no sandbox
`workspace-write` com a rede ligada (o baseline usa `curl` na homologação), sem o config do usuário, e lê o
`CLAUDE.md` das variantes como `AGENTS.md`, para receber as mesmas instruções. As rodadas vão para
`rodadas/codex.<tarefa>.<variante>.<n>`. O `--json` do Codex não diz o custo, então o resumo compara passos,
tokens e duração. O que o Codex muda, e que vale olhar: o servidor do MCP entra no contexto só pela primeira linha das
instruções, as ferramentas dele chegam pela busca (`tool_search`) e uma resposta acima de 10 mil tokens é cortada.

## Limites

- **Cinco tarefas, um projeto pequeno.** Num projeto maior, com mais endpoints e mais páginas, a
  documentação gerada pode pesar mais a favor do VVPost, porque há mais texto copiado à mão para
  manter. O benchmark não mede isso ainda.
- **Um modelo e um cliente.** Outro modelo, ou outro cliente MCP, pode usar as ferramentas de outro
  jeito. O Claude Code carrega as ferramentas do MCP sob demanda, o que custa um passo de busca por
  rodada.
- **Seis rodadas.** A variação entre rodadas é grande (4 a 25 passos na mesma tarefa sem o VVPost);
  diferenças pequenas ficam dentro do intervalo e não devem ser lidas como ganho ou perda.
- **O MCP foi ajustado olhando transcrições destas tarefas.** Isso traz o risco de ele estar mais
  afinado com elas do que com outras.
- **O projeto já começa montado no VVPost.** O custo de importá-lo e organizá-lo não entra nas
  rodadas.
- **O corretor é automático.** Ele confere o que a tarefa pede de forma objetiva; não julga a
  redação das páginas.
