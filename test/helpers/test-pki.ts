import 'reflect-metadata'
import { randomBytes, webcrypto, type webcrypto as WebCrypto } from 'node:crypto'
import * as x509 from '@peculiar/x509'

export interface TestPki {
  /** Certificado da CA de teste, em PEM. */
  ca: string
  server: { cert: string; key: string }
  client: { cert: string; key: string }
}

const ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 }

/**
 * CA, certificado de servidor (127.0.0.1/localhost) e de cliente gerados na hora,
 * só em memória: nenhuma chave privada fica commitada no repositório.
 * As chaves e as assinaturas vêm do WebCrypto do Node; o @peculiar/x509 só monta os X.509.
 */
export async function createTestPki(): Promise<TestPki> {
  // Os tipos do WebCrypto do Node e os do DOM que a biblioteca espera não batem; o objeto é o mesmo.
  x509.cryptoProvider.set(webcrypto as never)
  const keyPair = () => webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify']) as Promise<WebCrypto.CryptoKeyPair>
  const keyPem = async (key: WebCrypto.CryptoKey) =>
    x509.PemConverter.encode(await webcrypto.subtle.exportKey('pkcs8', key), 'PRIVATE KEY')
  const validity = { notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 24 * 3600_000) }
  // Serial positivo: o primeiro byte abaixo de 0x80.
  const serialNumber = () => `01${randomBytes(8).toString('hex')}`

  const caKeys = await keyPair()
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serialNumber(),
    name: 'CN=VVPost Test CA',
    ...validity,
    keys: caKeys,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true)
    ]
  })
  const leaf = async (subject: string, extensions: x509.Extension[]) => {
    const keys = await keyPair()
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: serialNumber(),
      subject: `CN=${subject}`,
      issuer: ca.subject,
      ...validity,
      publicKey: keys.publicKey,
      signingKey: caKeys.privateKey,
      signingAlgorithm: ALG,
      extensions: [
        new x509.BasicConstraintsExtension(false),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
        ...extensions
      ]
    })
    return { cert: cert.toString('pem'), key: await keyPem(keys.privateKey) }
  }

  return {
    ca: ca.toString('pem'),
    server: await leaf('vvpost-test-server', [
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension([
        { type: 'ip', value: '127.0.0.1' },
        { type: 'dns', value: 'localhost' }
      ])
    ]),
    client: await leaf('vvpost-test-client', [new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth])])
  }
}
