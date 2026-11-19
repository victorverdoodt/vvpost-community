# vvpost

CLI do [VVPost](https://github.com/victorverdoodt/vvpost-community) para CI/CD. Roda os cenários
de teste e os fluxos de um workspace VVPost sem abrir o app, com o mesmo motor do app: o que passa
no app passa no pipeline.

```sh
npx vvpost run --workspace . --env staging --junit reports/junit.xml
```

- `vvpost run`: cenários e fluxos, com filtros, matriz por ambiente, JUnit e JSON. Sai com 0
  (passou), 1 (falhou), 2 (configuração) ou 130 (interrompido).
- `vvpost list`, `vvpost validate`, `vvpost export`, `vvpost import` e `vvpost docs`.
- Segredos do CI só em memória (`VVPOST_SECRET_<NOME>`, `--secrets`, `--var`) e o Secret
  Sanitizer em toda saída.
- `vvpost-mcp`: o servidor MCP do VVPost (stdio ou HTTP) para agentes de IA.

Requer Node.js 22.19 ou mais novo. Sem dependências em runtime; os plugins oficiais vêm no pacote.

Guia completo: [docs/cli.md](https://github.com/victorverdoodt/vvpost-community/blob/main/docs/cli.md).
Licença Apache 2.0.
