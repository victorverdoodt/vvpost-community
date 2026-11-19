# Desenvolvimento

Como o código está organizado, como rodar, testar e medir. Para abrir um PR, veja também o
[guia de contribuição](../CONTRIBUTING.md).

## Stack

Electron 44, Vite 8 (via electron-vite), React 18, TypeScript 6 e Tailwind 4.

```
src/
  main/         processo principal (janela, IPC, medição de memória, modo benchmark)
    cli/          CLI `vvpost` para CI/CD (out/main/cli.js)
    mcp/          servidor MCP (out/main/mcp.js) e o toggle dele no app
    webhooks/     servidor local de webhooks (Fastify): caixa de entrada, hooks, assinatura e disparos
    history/      histórico rico de execuções em SQLite (Kysely + node:sqlite, WAL)
    importers/    importadores do Postman, do pacote do VVPost e de OpenAPI/Swagger, com a revisão (planImport)
    bundle/       exportação do pacote do VVPost (.vvpost.bundle.json)
    project/      camada de escrita em lote do projeto (MCP, importador, menus) e a revisão das mudanças da IA
    docs/         PDF da documentação rica
    workspace/    Git Workspace (git do sistema), vault local de segredos e leak guard
    secret-engine/ mock de Secret Managers (porta 4460) e o contrato do módulo Enterprise
    enterprise/   pontos de extensão do módulo Enterprise: Control Plane, execução remota e identidade
    identity.ts   perfil local e registerIdentityProvider
    ux-study.ts   instrumentação local do teste com usuários (--ux-study)
  preload/      ponte contextBridge: a única API que o renderer enxerga (window.vvpost)
  renderer/     interface React; cada painel é um chunk carregado sob demanda
    app/          shell (barra superior, sidebar, status bar, Command Palette, busca no projeto)
    design-system/ tokens e componentes compartilhados
    modules/      um módulo por painel (quick-request, connectors, tests, flow-studio, history...)
  shared/       contrato IPC tipado, usado pelos três lados
packages/
  core/         motor em Node puro (@vvpost/core), usado pelo app, pelo CLI e pelo MCP:
    connectors/   workspace, herança de conectores, variáveis {{VAR}} e auth headless
    http/         dispatcher HTTP (undici, pool de sockets keep-alive)
    scenarios/    matriz de cenários e motor de asserções
    flows/        Context Engine do Flow Studio ($nodes, execução topológica), nó Python e nós de plugin
    plugins/      Plugin SDK: gerenciador de plugins e um processo com sandbox por plugin
    sandbox/      regras de rede de plugins e do nó Python, namespace de rede do Linux
    policy/       limites de disparo para quem dispara sem humano (IA, plugins)
    docs/         modelo e Markdown da documentação rica (app, `vvpost docs` e `generate_docs`)
    recorder.ts   gravador das requisições para o histórico
    session.ts    o motor fora do Electron (CLI e runners); sanitizer.ts, o Secret Sanitizer
  schemas/      JSON Schemas v1 (conector, ambiente, secrets engine, fluxo, plugin, pacote), tipos gerados e validadores
  plugin-sdk/   tipos da API de plugins (@vvpost/plugin-sdk)
plugins/        plugins oficiais: vvpost-plugin-javascript, -graphql, -grpc e -kafka
examples/
  demo-workspace/ projeto de demonstração (com scripts/demo-server.mjs)
bench/
  agentes/      benchmark de agentes com e sem o VVPost (docs/benchmark-agentes.md), com os dados brutos
scripts/
  bench-startup.mjs   mede cold start, RAM em repouso e overhead de disparo contra perf-budgets.json
  bench-modules.mjs   abertura e volta de cada módulo e a primeira execução (roda no fim do bench-startup)
  bench-memory-tour.mjs memória depois de passar por todos os módulos do projeto de demonstração
  e2e-*.mjs           um E2E por área no app real (build de produção em out/): Quick Request, importador
                      do Postman, import de OpenAPI, pacote, Git, auth headless, cenários, editores, Secret Engine, módulo
                      Secrets, Catálogo, documentação rica, Flow Studio, MCP, plugins, CLI, execução
                      remota, acessibilidade, identidade local e corporativa, teste com usuários,
                      primeiros passos, modos da resposta, menus de contexto e webhooks
  demo-server.mjs     API de mentira do projeto de demonstração (porta 4010)
  docs-screenshots.mjs as capturas de docs/assets/screenshots, tiradas do projeto de demonstração
  docs-gifs.mjs       os GIFs de docs/assets/gifs (agente pelo MCP, prévia, PDF e canvas), com ffmpeg
  ux-audit.mjs        auditoria visual em 100%, 125% e 150%
  ux-study-report.mjs resumo das sessões do teste com usuários (--ux-study)
  make-icons.mjs      gera os ícones do app a partir de resources/icon.svg
test/                 testes unitários (Vitest)
```

O renderer roda com `sandbox`, `contextIsolation` e sem `nodeIntegration`. Todo canal
IPC novo é declarado em `src/shared/ipc.ts` e exposto explicitamente no preload.

## Comandos

```bash
npm ci
npm run dev         # app com hot reload
npm run typecheck
npm test            # testes unitários (Vitest)
npm run build       # gera out/
npm run test:e2e    # todos os scripts/e2e-*.mjs em sequência (precisa do build e do git)
node scripts/e2e-flows.mjs           # um E2E só
npm run vvpost -- run --workspace <pasta>  # CLI (precisa do build)
npm run mcp -- --workspace <pasta>   # servidor MCP por stdio (precisa do build)
npm run bench       # roda o build 5 vezes e compara com as metas; depois mede os módulos
```

No Linux sem display (CI, containers), rode o benchmark e o E2E com `xvfb-run -a`.

O benchmark usa uma pasta de dados temporária por execução (`--user-data-dir`), então roda com o
VVPost aberto e sem o workspace do usuário. O overhead de disparo é medido depois da RAM: 200
requisições a um servidor em loopback pelo caminho do botão Enviar (IPC, herança do conector,
auth por API key, `{{VAR}}`, gravador, Secret Sanitizer e histórico) contra as mesmas pelo Undici
direto no main process; a meta vale para a diferença das medianas. Se o app sair sem reportar, a mensagem diz se foi o lock de
instância única ou se ele fechou antes do primeiro paint.

## Metas de desempenho

As metas ficam em `perf-budgets.json` e o CI roda o benchmark em Linux e
Windows a cada push. Uma meta com `enforce: true` reprova o build quando é estourada.

| Métrica | Meta | Medido (Linux, xvfb) | No CI |
| --- | --- | --- | --- |
| Cold start (spawn até o primeiro paint) | < 800 ms | ~410 ms | reprova |
| RAM em repouso (soma de todos os processos) | < 150 MB | ~202 MB (PSS) | só reporta |
| Overhead de disparo (Quick Request além do Undici direto) | < 5 ms | ~2,4 ms | reprova |

A RAM é medida como PSS no Linux e private bytes no Windows (o mesmo número do
Gerenciador de Tarefas), para não contar várias vezes as bibliotecas compartilhadas
entre os processos do Chromium. O rodapé do app mostra o mesmo número.

O app usa composição por software, com o processo de GPU dentro do main, o que tira
~77 MB da RAM em repouso. Para usar a aceleração por hardware, abra o VVPost com
`VVPOST_GPU=1`. Uma página vazia do Electron 44 com a mesma configuração já ocupa
~178 MB (PSS, Linux), então a meta de 150 MB não é alcançável só com ajustes no app.
