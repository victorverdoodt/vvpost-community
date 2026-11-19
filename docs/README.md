# Documentação do VVPost

O VVPost é um workspace de documentação viva para backend. Conectores, endpoints, cenários de
teste, fluxos, diagramas e páginas em Markdown são arquivos do projeto que se citam em vez de se
copiar, e o app, o CLI e o servidor MCP leem e gravam esses arquivos pelas mesmas regras. Por isso a
documentação pode ser executada (cada endpoint tem **Testar**, cada exemplo pode ser um cenário),
conferida no CI (`validate`, `lint`, `sync --check`) e mantida por um agente de IA sem que ele veja
as credenciais. No app, o projeto abre como um workspace, com um explorador e abas cujo editor muda
pelo tipo do arquivo. Comece pelo [Documento do projeto](documentation.md) e pela
[Interface](interface.md).

## Guias de uso

| Guia | O que cobre |
| --- | --- |
| [Interface](interface.md) | Workspace de abas, explorador, botão Novo, módulos, atalhos, Command Palette, menus de contexto, primeiros passos e conta |
| [Quick Request e auth headless](quick-request.md) | Disparo, Params, modos da resposta, histórico, conectores no Quick Request e os tipos de auth |
| [Catálogo e documentação viva](catalog.md) | Árvore de herança, configuração efetiva, Markdown e Mermaid, validação de corpo, editor e documentação rica em `.md` e PDF |
| [Documento do projeto](documentation.md) | Markdown com prévia em PDF: modelo com logo, capa, cabeçalho e rodapé, diretivas de trechos, modelos C4/arc42/Diátaxis/ADR, Testar, CLI e MCP |
| [Enviar para…](publish.md) | Exportar a documentação como site HTML estático (portal de parceiros, Backstage, com a página Mudanças), em MkDocs ou no formato de um plugin, e publicar em outro lugar (Confluence Cloud no Enterprise): o `vvpost.publish.json`, o plano com confirmação, `vvpost docs export` e os pontos de extensão |
| [Cenários de teste](tests.md) | Matriz cenário × ambiente, overrides, asserções, expectativa por ambiente e cenários encadeados |
| [Importar e exportar](import-export.md) | Pacote do VVPost e importadores do Postman, OpenAPI, Insomnia, Bruno, HAR e WSDL, com revisão antes de gravar |
| [Sincronizar com a OpenAPI do código](openapi-sync.md) | Para times code-first: a spec gerada pelo código como fonte do contrato, `vvpost sync`, relatório de drift e o `--check` no CI |
| [Lint de regras](lint.md) | Estilo e erros comuns com regras por JSONPath no formato do Spectral: ruleset padrão, ruleset do time, OpenAPI, app, `vvpost lint` (SARIF e JUnit) e MCP |
| [Marca e produto](brand.md) | O contrato do frontend: tokens no formato W3C DTCG em `brand/`, contraste por modo, o código conferido contra os tokens no lint, as diretivas `{{> tokens}}` e `{{> contrast}}` e o `get_brand` do MCP |
| [Adotar no time](adocao.md) | Só com o CLI e o MCP, sem o app; workspace num repositório central ou no de cada serviço; política do agente obrigatória no Enterprise |
| [Git Workspace](git-workspace.md) | Commit com redação de segredos, branches, pull e onboarding após clone |
| [Flow Studio](flows.md) | Formato dos fluxos, Context Engine (`$nodes`), polling, espera, asserção e nó Python |
| [CLI para CI/CD](cli.md) | `vvpost run`, `lint`, `export`, `import`, `sync` e `docs`, JUnit e JSON, códigos de saída e segredos do CI |
| [Prontidão](readiness.md) | O que impede o workspace de rodar, por ambiente e de uma vez: `vvpost doctor` e `check_readiness` no MCP |
| [Servidor MCP](mcp.md) | O contrato para agentes (versões, erros com `code`, escritas atômicas), código e documentação juntos, como conectar os clientes e o que o Secret Sanitizer mascara |
| [Secret Engine](secret-engine.md) | Emulador de Azure Key Vault, AWS Secrets Manager e HashiCorp Vault, e os pontos de extensão |
| [Exemplos de resposta e mock server](mock.md) | Respostas de exemplo nos endpoints e o mock server local (app e `vvpost mock`) |
| [Servidor local de webhooks](webhooks.md) | Receber, inspecionar e reenviar eventos, hooks com assinatura, disparo de fluxos e cenários, nó webhook |
| [Plugin SDK e Extensions Hub](plugins.md) | Plugins em processos com sandbox, nós e adapters de protocolo, permissões e modelo de confiança |

## Referência para quem contribui

| Documento | O que cobre |
| --- | --- |
| [Arquitetura e contratos](architecture.md) | Partes do app, pontos de extensão, contrato de autenticação, herança e versionamento dos schemas |
| [Modelo de segurança](security-model.md) | Secret Sanitizer, ler e usar um segredo, limites de disparo e garantias contra vazamento de segredos |
| [Benchmark de agentes](benchmark-agentes.md) | A mesma tarefa de manutenção com e sem o VVPost: metodologia, dados brutos e resultado |
| [Desenvolvimento](development.md) | Stack, organização do código, comandos, testes e metas de desempenho |
| [Empacotamento](packaging.md) | Instaladores, tamanho, assinatura e o pacote npm do CLI |
| [Schemas JSON](../packages/schemas/README.md) | Conector, ambiente, secrets engine, fluxo, plugin e pacote |

O VVPost Enterprise (módulo comercial) tem documentação própria, fora deste repositório. Aqui
ficam só os [pontos de extensão](architecture.md#pontos-de-extensão-para-o-módulo-enterprise) que o
core oferece a ele.
