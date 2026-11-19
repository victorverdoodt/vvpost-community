export class ErroApi extends Error {
  constructor(status, codigo, mensagem) {
    super(mensagem)
    this.status = status
    this.codigo = codigo
  }
}

export function corpoDeErro(e) {
  return { erro: { codigo: e.codigo, mensagem: e.message } }
}
