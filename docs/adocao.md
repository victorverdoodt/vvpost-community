# Adotar no time

Como entrar com o VVPost sem trocar o dia a dia de ninguém, onde guardar o workspace e, no
Enterprise, como fazer a política do agente valer para todos.

## Só com o CLI e o MCP

O app é opcional. O CLI (`npx vvpost`) e o servidor MCP (`vvpost-mcp`) usam o mesmo motor
(`@vvpost/core`), e quase tudo o que o app faz no projeto também roda sem ele:

| Etapa | Comando |
| --- | --- |
| Montar o projeto | `vvpost import` (OpenAPI, Postman, Insomnia, Bruno, HAR, WSDL) ou `vvpost sync`, com a spec gerada pelo código como fonte ([sync](openapi-sync.md)) |
| Ligar o agente | `vvpost connect <repositório>` registra o MCP no Claude Code, Cursor, Copilot ou Codex e grava a regra no `CLAUDE.md`/`AGENTS.md` ([CLI](cli.md#vvpost-connect)) |
| Documentar | `vvpost docs init --template c4` (ou `arc42`, `diataxis`, `adr`) e `vvpost docs` |
| Conferir no CI | `vvpost sync --check`, `vvpost validate`, `vvpost lint` e `vvpost run` |
| Proteger commits | `vvpost guard --install` |
| Guardar os segredos | `vvpost secrets set <ambiente> <VAR>` grava no [cofre local](security-model.md#cofre-local), com o valor digitado sem eco ou vindo do stdin; `vvpost secrets list` mostra o que falta ([CLI](cli.md#vvpost-secrets)) |

O agente edita conectores, cenários, fluxos e páginas pelo MCP. Quem não usa o app continua no
cliente HTTP e no editor que já usa. No CI, os segredos chegam por `VVPOST_SECRET_<VAR>` ou
`--secrets`. A IA nunca grava um segredo.

## Onde fica o workspace

O workspace é uma pasta com JSON e Markdown. Dois modelos funcionam, e dá para misturar:

- **Um repositório central da organização.** Um repositório com um [projeto](git-workspace.md#projetos)
  por serviço e o que é comum (a auth corporativa, os ambientes) na raiz, compartilhado por todos.
  Cada repositório de código aponta para ele com `vvpost connect ../repo-do-servico --project
  <id>`. É o modelo em que as bases compartilhadas funcionam sem nada a mais.
- **Dentro do repositório de cada serviço.** Uma pasta (por exemplo `api/`) no próprio repositório
  do código, versionada e revisada no mesmo PR que a mudança. O `vvpost sync --check` roda no CI
  daquele repositório. As bases compartilhadas entre serviços chegam de duas formas: copiadas para
  a raiz do workspace (submódulo do Git, por exemplo) ou, no Enterprise, pelo
  [catálogo centralizado](cli.md#catálogo-centralizado-no-ci) do Control Plane, que o app e o
  `vvpost-mcp` sincronizam sozinhos depois do login e o CI recebe com `--catalog` (o `vvpost-mcp`
  também aceita `--catalog`, para quem roda sem o módulo).

## Política do agente obrigatória (Enterprise)

A configuração da organização vem do Control Plane, não de um arquivo na máquina de cada pessoa.
Antes do login só é preciso saber o endereço dele, e ele chega de dois jeitos:

- **O workspace declara.** `.vvpost/organization.json`, versionado com o workspace, com
  `{ "controlPlane": "https://vvpost.contoso.com", "project": "payments" }`
  ([detalhes](mcp.md#o-workspace-declara-a-organização)).
- **A pessoa registra.** `vvpost login https://vvpost.contoso.com --project payments`, para quem
  trabalha fora de um workspace da organização ([CLI](cli.md#vvpost-login)).

Com o endereço, o módulo Enterprise busca no Control Plane o IdP e o cliente de login, abre o
login e, com ele, aplica a [política central](mcp.md#política-central-módulo-enterprise) e o
catálogo, relidos durante a sessão. A política só restringe as opções locais e falha fechado: sem
login ou sem Control Plane, o MCP não envia nada às APIs nem grava no projeto.

**Quem não faz login ou usa o build Community.** Num workspace que declara a organização, o MCP
fica no modo mais restrito também sem o módulo Enterprise: lê o catálogo e os documentos e não
envia nem grava nada. Como o login automático só abre para um host confirmado (pelo `vvpost login`
ou pelo botão Entrar do app), um repositório clonado não consegue levar ninguém a um login falso.

Nenhuma checagem do lado do cliente impede, sozinha, quem controla a máquina de apagar o arquivo
ou rodar outro binário. O que garante a política nesse caso fica no servidor e na TI:

- **As credenciais só pelo broker.** Com `secretsBroker` na política do projeto, os segredos das
  APIs corporativas ficam no cofre da organização e só são entregues a quem fez login e tem papel
  no projeto. Um MCP sem login não tem credencial para chamar essas APIs.
- **Os servidores MCP permitidos, pela TI.** Os clientes de IA aceitam configuração gerenciada
  (no Claude Code, as configurações gerenciadas distribuídas por MDM) que limita quais servidores
  MCP o desenvolvedor pode usar. Libere só o `vvpost-mcp` com o módulo Enterprise.
- **A trilha.** Cada chamada do agente sob a política vira um evento `mcpToolCall` na auditoria
  da organização.

O `~/.vvpost/enterprise.json` continua aceito para organizações sem Control Plane (só o Cloud
Proxy de segredos com SSO) e vale só quando nem o workspace nem o `vvpost login` indicam um
Control Plane.
