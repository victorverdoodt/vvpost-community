# Resultados de 2026-10-26-mcp-atual

Modelo `claude-sonnet-5-5`, Claude Code 2.1.310, 60 rodadas. Média (mín.–máx.); a diferença é do VVPost em relação ao baseline, com o intervalo de 95% por bootstrap. Gerado por `resumir.mjs`.

## alterar-endpoint

| Métrica | Sem o VVPost | Com o VVPost | Diferença | IC 95% da diferença |
| --- | --- | --- | --- | --- |
| Rodadas corretas (todos os critérios) | 6/6 | 6/6 | | |
| Nota de qualidade | 1,00 | 1,00 | | |
| Rodadas com a chave da homologação na transcrição | 0/6 | 0/6 | | |
| Passos (chamadas de ferramenta) | 11,8 (4,0–25,0) | 11,7 (7,0–18,0) | -1% | -7,0 a 6,2 (inclui 0) |
| Turnos | 12,8 (5,0–26,0) | 12,7 (8,0–19,0) | -1% | -7,0 a 6,2 (inclui 0) |
| Tokens (entrada, cache e saída) | 199 mil (112 mil–319 mil) | 250 mil (178 mil–405 mil) | +25% | -30 mil a 140 mil (inclui 0) |
| Custo | US$ 0,15 (US$ 0,09–US$ 0,22) | US$ 0,16 (US$ 0,13–US$ 0,19) | +7% | US$ -0,03 a US$ 0,05 (inclui 0) |
| Duração (s) | 44 (17–86) | 34 (19–55) | -23% | -31 a 9 (inclui 0) |
| Chamadas ao MCP | 0,0 | 2,7 | | |
| Erros de ferramenta (sem contar as negadas) | 0,2 | 0,0 | | |
| Comandos negados pela permissão | 1,7 | 0,8 | | |

Critérios reprovados: sem o VVPost, nenhum; com o VVPost, nenhum.

## remover-dependencia

| Métrica | Sem o VVPost | Com o VVPost | Diferença | IC 95% da diferença |
| --- | --- | --- | --- | --- |
| Rodadas corretas (todos os critérios) | 6/6 | 6/6 | | |
| Nota de qualidade | 1,00 | 1,00 | | |
| Rodadas com a chave da homologação na transcrição | 0/6 | 0/6 | | |
| Passos (chamadas de ferramenta) | 28,0 (22,0–37,0) | 19,3 (16,0–23,0) | -31% | -13,3 a -4,0 |
| Turnos | 29,0 (23,0–38,0) | 20,3 (17,0–24,0) | -30% | -13,3 a -4,0 |
| Tokens (entrada, cache e saída) | 315 mil (179 mil–517 mil) | 317 mil (226 mil–386 mil) | +1% | -104 mil a 105 mil (inclui 0) |
| Custo | US$ 0,22 (US$ 0,16–US$ 0,31) | US$ 0,20 (US$ 0,18–US$ 0,24) | -8% | US$ -0,06 a US$ 0,03 (inclui 0) |
| Duração (s) | 76 (50–101) | 53 (36–65) | -31% | -40 a -6 |
| Chamadas ao MCP | 0,0 | 3,5 | | |
| Erros de ferramenta (sem contar as negadas) | 0,2 | 0,2 | | |
| Comandos negados pela permissão | 2,7 | 1,5 | | |

Critérios reprovados: sem o VVPost, nenhum; com o VVPost, nenhum.

## consultar-api

| Métrica | Sem o VVPost | Com o VVPost | Diferença | IC 95% da diferença |
| --- | --- | --- | --- | --- |
| Rodadas corretas (todos os critérios) | 6/6 | 6/6 | | |
| Nota de qualidade | 1,00 | 1,00 | | |
| Rodadas com a chave da homologação na transcrição | 6/6 | 0/6 | | |
| Passos (chamadas de ferramenta) | 5,8 (5,0–7,0) | 4,5 (4,0–6,0) | -23% | -2,2 a -0,5 |
| Turnos | 6,8 (6,0–8,0) | 5,5 (5,0–7,0) | -20% | -2,2 a -0,5 |
| Tokens (entrada, cache e saída) | 113 mil (109 mil–127 mil) | 105 mil (103 mil–112 mil) | -7% | -14 mil a -4 mil |
| Custo | US$ 0,05 (US$ 0,05–US$ 0,06) | US$ 0,06 (US$ 0,06–US$ 0,08) | +19% | US$ 0,01 a US$ 0,02 |
| Duração (s) | 19 (12–32) | 13 (9–21) | -29% | -13 a 1 (inclui 0) |
| Chamadas ao MCP | 0,0 | 3,3 | | |
| Erros de ferramenta (sem contar as negadas) | 0,0 | 0,0 | | |
| Comandos negados pela permissão | 2,0 | 0,0 | | |

Critérios reprovados: sem o VVPost, nenhum; com o VVPost, nenhum.

## atualizar-integracao

| Métrica | Sem o VVPost | Com o VVPost | Diferença | IC 95% da diferença |
| --- | --- | --- | --- | --- |
| Rodadas corretas (todos os critérios) | 6/6 | 6/6 | | |
| Nota de qualidade | 1,00 | 1,00 | | |
| Rodadas com a chave da homologação na transcrição | 0/6 | 0/6 | | |
| Passos (chamadas de ferramenta) | 13,7 (5,0–19,0) | 13,5 (12,0–18,0) | -1% | -3,8 a 4,3 (inclui 0) |
| Turnos | 14,7 (6,0–20,0) | 14,5 (13,0–19,0) | -1% | -3,8 a 4,3 (inclui 0) |
| Tokens (entrada, cache e saída) | 176 mil (117 mil–270 mil) | 228 mil (173 mil–288 mil) | +29% | 1 mil a 100 mil |
| Custo | US$ 0,13 (US$ 0,11–US$ 0,16) | US$ 0,15 (US$ 0,13–US$ 0,17) | +18% | US$ 0,01 a US$ 0,04 |
| Duração (s) | 33 (21–50) | 41 (24–72) | +26% | -5 a 23 (inclui 0) |
| Chamadas ao MCP | 0,0 | 2,3 | | |
| Erros de ferramenta (sem contar as negadas) | 0,0 | 0,0 | | |
| Comandos negados pela permissão | 2,0 | 1,2 | | |

Critérios reprovados: sem o VVPost, nenhum; com o VVPost, nenhum.

## novo-endpoint

| Métrica | Sem o VVPost | Com o VVPost | Diferença | IC 95% da diferença |
| --- | --- | --- | --- | --- |
| Rodadas corretas (todos os critérios) | 6/6 | 6/6 | | |
| Nota de qualidade | 1,00 | 1,00 | | |
| Rodadas com a chave da homologação na transcrição | 0/6 | 0/6 | | |
| Passos (chamadas de ferramenta) | 27,8 (20,0–32,0) | 21,5 (18,0–25,0) | -23% | -10,0 a -2,5 |
| Turnos | 28,8 (21,0–33,0) | 22,5 (19,0–26,0) | -22% | -10,0 a -2,5 |
| Tokens (entrada, cache e saída) | 356 mil (227 mil–526 mil) | 432 mil (327 mil–600 mil) | +21% | -35 mil a 180 mil (inclui 0) |
| Custo | US$ 0,33 (US$ 0,24–US$ 0,38) | US$ 0,29 (US$ 0,25–US$ 0,34) | -13% | US$ -0,09 a US$ 0,00 (inclui 0) |
| Duração (s) | 93 (62–113) | 78 (58–97) | -17% | -34 a 3 (inclui 0) |
| Chamadas ao MCP | 0,0 | 4,8 | | |
| Erros de ferramenta (sem contar as negadas) | 0,8 | 0,2 | | |
| Comandos negados pela permissão | 2,5 | 2,5 | | |

Critérios reprovados: sem o VVPost, nenhum; com o VVPost, nenhum.

## Todas as tarefas

| Métrica | Sem o VVPost | Com o VVPost | Diferença | IC 95% da diferença |
| --- | --- | --- | --- | --- |
| Rodadas corretas (todos os critérios) | 30/30 | 30/30 | | |
| Nota de qualidade | 1,00 | 1,00 | | |
| Rodadas com a chave da homologação na transcrição | 6/30 | 0/30 | | |
| Passos (chamadas de ferramenta) | 17,4 (4,0–37,0) | 14,1 (4,0–25,0) | -19% | -7,7 a 0,8 (inclui 0) |
| Turnos | 18,4 (5,0–38,0) | 15,1 (5,0–26,0) | -18% | -7,7 a 0,8 (inclui 0) |
| Tokens (entrada, cache e saída) | 232 mil (109 mil–526 mil) | 266 mil (103 mil–600 mil) | +15% | -29 mil a 97 mil (inclui 0) |
| Custo | US$ 0,18 (US$ 0,05–US$ 0,38) | US$ 0,17 (US$ 0,06–US$ 0,34) | -2% | US$ -0,05 a US$ 0,04 (inclui 0) |
| Duração (s) | 53 (12–113) | 44 (9–97) | -17% | -24 a 5 (inclui 0) |
| Chamadas ao MCP | 0,0 | 3,3 | | |
| Erros de ferramenta (sem contar as negadas) | 0,2 | 0,1 | | |
| Comandos negados pela permissão | 2,2 | 1,2 | | |

Critérios reprovados: sem o VVPost, nenhum; com o VVPost, nenhum.
