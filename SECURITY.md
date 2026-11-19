# Política de segurança

O VVPost lida com credenciais de APIs, então levamos vulnerabilidades a sério. Obrigado por
relatar de forma responsável.

## Como relatar

**Não abra uma issue pública.** Use o relato privado do GitHub: na aba **Security** deste
repositório, clique em **Report a vulnerability**. Inclua:

- a versão ou o commit afetado e o sistema operacional;
- o passo a passo para reproduzir, com um workspace mínimo se possível;
- o impacto que você enxerga (por exemplo, um segredo que aparece em claro num commit, log,
  export, relatório do CLI ou resposta do MCP).

Nunca envie credenciais reais no relato; use valores de teste.

## O que esperar

- Confirmação do recebimento em até 3 dias úteis.
- Uma primeira avaliação, com a gravidade e o plano, em até 10 dias úteis.
- Aviso quando a correção sair, e crédito no relato público se você quiser.

Pedimos que a vulnerabilidade não seja divulgada antes da correção ou de 90 dias, o que vier
primeiro.

## Escopo

Estão no escopo o app desktop, o CLI, o servidor MCP, o Secret Engine local, o Plugin SDK e os
plugins oficiais deste repositório. Interessam em especial as
[garantias contra vazamento de segredos](docs/security-model.md#garantias-contra-vazamento-de-segredos)
e os [limites de disparo](docs/security-model.md#limites-de-disparo).

Fora do escopo, por desenho e documentado: um plugin instalado roda com o acesso do usuário
([plugins.md](docs/plugins.md)), o nó Python não é uma sandbox ([flows.md](docs/flows.md)) e o
emulador de Secret Managers entrega segredos de desenvolvimento a processos locais
([secret-engine.md](docs/secret-engine.md)).

## Versões suportadas

Até a primeira versão estável, só a branch `main` recebe correções de segurança.
