# Benchmark de agentes: com e sem o VVPost

A mesma tarefa de manutenção, feita por um agente de IA no mesmo repositório, em duas variantes:
sem o VVPost (a API descrita em OpenAPI e Markdown no repositório) e com o VVPost (a mesma descrição
num projeto do VVPost, ligado ao agente pelo servidor MCP). Metodologia e resultados em
[docs/benchmark-agentes.md](../../docs/benchmark-agentes.md).

| Pasta ou arquivo | O que é |
| --- | --- |
| `projeto/` | O código da Loja API de exemplo e os testes, iguais nas duas variantes |
| `baseline/` | O que a variante sem o VVPost acrescenta: `openapi/`, `docs/`, `README.md` e `CLAUDE.md` |
| `vvpost/` | O que a variante com o VVPost acrescenta: o projeto do VVPost em `api/` (importado das mesmas specs, com as mesmas páginas), `README.md` e `CLAUDE.md` com a regra do `vvpost docs agents` |
| `tarefas/` | O pedido de cada tarefa, igual nas duas variantes |
| `aceite/` | Testes de aceite ocultos: o agente não os vê; rodam depois, contra o código que ele deixou |
| `rodar.mjs` | Monta o repositório de cada rodada, roda o Claude Code (ou o Codex, com `--agente codex`) em modo headless e corrige |
| `codex.mjs` | Os argumentos do `codex exec` e a leitura do `--json` dele, na forma das métricas do Claude Code |
| `corrigir.mjs` | Os critérios de qualidade e correção de cada tarefa |
| `recorrigir.mjs` | Corrige de novo rodadas já feitas, a partir do `diff.patch` de cada uma |
| `resumir.mjs` | Gera `resumo.md` e `resumo.json` de uma pasta de resultados |
| `resultados/<data>/` | Dados brutos: `rodadas.jsonl` e, por rodada, a transcrição, o diff, o `mcp.json` e as estatísticas do MCP |

```bash
npm ci && npm run build
node bench/agentes/rodar.mjs --rodadas 6 --paralelo 4 --saida bench/agentes/resultados/$(date +%F)
node bench/agentes/resumir.mjs bench/agentes/resultados/$(date +%F)
```

Precisa do `claude` (Claude Code) no `PATH`, com login feito. Cada rodada custa centavos de dólar
no preço de tabela do modelo; 36 rodadas ficam perto de US$ 10.
