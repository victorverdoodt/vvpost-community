# Guia de integração

Para cobrar um cliente, obtenha o token da base corporativa (o VVPost faz isso sozinho), crie a
cobrança e consulte o status pelo id devolvido.

## Criar uma cobrança

{{> endpoint connector.payments.v1/create_charge}}

## Erros comuns

| Código | Quando |
| --- | --- |
| `INVALID_AMOUNT` | Valor zero ou negativo |
| `401` | Token vencido ou client sem permissão |
