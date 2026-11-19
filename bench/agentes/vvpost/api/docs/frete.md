# Frete

O frete é cotado na criação do pedido, pelo peso somado dos itens e pelo CEP de entrega.

1. A Loja pede a cotação à **TransNorte** (`POST /cotacoes`, peso em kg). O valor vem em reais e
   é convertido para centavos.
2. Se a TransNorte falhar (erro HTTP ou rede), a Loja pede à **EntregaJá** (`GET /v1/frete`, peso
   em gramas). O valor já vem em centavos.
3. Se as duas falharem, o pedido não é criado e a API devolve `503 FRETE_INDISPONIVEL`, com a
   falha de cada transportadora na mensagem.

O campo `transportadora` do pedido diz quem cotou: `transnorte` ou `entregaja`.

## Configuração

| Variável | Uso |
| --- | --- |
| `TRANSNORTE_URL` | Base da API da TransNorte (padrão `https://api.transnorte.example/v2`) |
| `TRANSNORTE_API_KEY` | Chave da TransNorte, enviada em `X-Api-Key` |
| `ENTREGAJA_URL` | Base da API da EntregaJá (padrão `https://frete.entregaja.example`) |
| `ENTREGAJA_TOKEN` | Token da EntregaJá, enviado como `Authorization: Bearer` |
