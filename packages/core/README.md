# @vvpost/core

O motor do VVPost em Node puro, sem Electron nem interface. Clientes: o app (main process, via
IPC do renderer), o CLI `vvpost` (`src/main/cli`) e o servidor MCP (`src/main/mcp`).

| Módulo | O que faz |
| --- | --- |
| `connectors/` | Leitura do workspace, herança de conectores, variáveis `{{VAR}}`, auth headless e registry |
| `http/` | Dispatcher Undici (pool keep-alive, cancelamento, erros tipados, mTLS) |
| `scenarios/` | Matriz de cenários e motor de asserções |
| `flows/` | Context Engine (`$nodes`, ordem topológica), nó Python e nós de plugin |
| `plugins/` | Gerenciador de plugins, um processo com sandbox por plugin |
| `sandbox/` | Regras de rede de plugins e do nó Python, e o namespace de rede do Linux |
| `policy/` | Limites de disparo (`RequestGuard`) para a IA e os plugins |
| `sanitizer.ts`, `secrets.ts` | Secret Sanitizer e as regras de nome sensível |
| `session.ts`, `run.ts` | O motor montado para o CLI e runners; execução de cenários e fluxos dividida com o app |
| `types.ts` | Tipos do motor; `src/shared/ipc.ts` os reexporta para o renderer |

O pacote exporta TypeScript direto (como o `@vvpost/schemas`) e entra no bundle de quem o usa:
`@vvpost/core` para o índice e `@vvpost/core/<caminho>` para cada módulo, por exemplo
`@vvpost/core/connectors/auth`. Só pode importar Node, ele mesmo, `@vvpost/schemas` e `undici`;
`test/core-boundary.test.ts` confere isso.
