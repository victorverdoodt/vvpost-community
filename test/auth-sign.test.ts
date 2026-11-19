import { describe, expect, it } from 'vitest'
import {
  digestAuthorization,
  md4,
  ntlmNegotiate,
  ntlmv2Responses,
  ntowfv2,
  parseChallenge,
  parseNtlmChallenge,
  signOAuth1,
  signSigV4
} from '@vvpost/core/connectors/auth-sign'

// Vetores publicados (RFCs, AWS e MS-NLMP): as assinaturas batem byte a byte com as referências.

describe('AWS SigV4', () => {
  const creds = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'service' }
  const at = new Date('2015-08-30T12:36:00Z')

  it('get-vanilla da suíte de testes da AWS', () => {
    const headers = signSigV4({ method: 'GET', url: 'https://example.amazonaws.com/', headers: [] }, creds, at)
    expect(headers).toEqual([
      { name: 'X-Amz-Date', value: '20150830T123600Z' },
      {
        name: 'Authorization',
        value:
          'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
      }
    ])
  })

  it('S3 manda o hash do corpo e o token de sessão entra assinado', () => {
    const headers = signSigV4(
      { method: 'PUT', url: 'https://b.s3.amazonaws.com/a b.txt', headers: [], body: 'oi' },
      { ...creds, service: 's3', sessionToken: 'sessao' },
      at
    )
    const names = headers.map((h) => h.name)
    expect(names).toEqual(['X-Amz-Date', 'X-Amz-Content-Sha256', 'X-Amz-Security-Token', 'Authorization'])
    expect(headers.at(-1)!.value).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token')
  })
})

describe('OAuth 1.0', () => {
  it('exemplo da RFC 5849 (seção 1.2)', () => {
    const [h] = signOAuth1(
      { method: 'GET', url: 'http://photos.example.net/photos?file=vacation.jpg&size=original', headers: [] },
      { consumerKey: 'dpf43f3p2l4k3l03', consumerSecret: 'kd94hf93k423kf44', token: 'nnch734d00sl2jdk', tokenSecret: 'pfkkdhi9sl3r4s00', realm: 'Photos' },
      { nonce: 'chapoH', timestamp: 137131202, version: false }
    )
    expect(h!.value).toMatch(/^OAuth realm="Photos", oauth_consumer_key="dpf43f3p2l4k3l03", /)
    expect(h!.value).toContain('oauth_signature="MdpQcU8iPSUjWoN%2FUDMsK2sui9I%3D"')
  })

  it('PLAINTEXT manda os segredos como assinatura', () => {
    const [h] = signOAuth1({ method: 'POST', url: 'https://x/', headers: [] }, { consumerKey: 'k', consumerSecret: 'a&b', signatureMethod: 'PLAINTEXT' })
    expect(h!.value).toContain('oauth_signature="a%2526b%26"')
  })
})

describe('Digest', () => {
  it('exemplo da RFC 2617 (Mufasa)', () => {
    const value = digestAuthorization(
      ['Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"'],
      { method: 'GET', url: 'http://h/dir/index.html' },
      { username: 'Mufasa', password: 'Circle Of Life' },
      '0a4f113b'
    )
    expect(value).toContain('response="6629fae49393a05397450978507c4ef1"')
    expect(value).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"')
    expect(value).toContain('qop=auth, nc=00000001, cnonce="0a4f113b"')
  })

  it('entre vários desafios, prefere SHA-256', () => {
    const value = digestAuthorization(
      ['Digest realm="r", nonce="n", algorithm=MD5, qop="auth"', 'Digest realm="r", nonce="n", algorithm=SHA-256, qop="auth"'],
      { method: 'GET', url: 'http://h/' },
      { username: 'u', password: 'p' }
    )
    expect(value).toContain('algorithm=SHA-256')
    expect(parseChallenge('Digest realm="a, \\"b\\"", nonce=x').params).toEqual({ realm: 'a, "b"', nonce: 'x' })
  })
})

describe('NTLM', () => {
  it('MD4 da RFC 1320', () => {
    expect(md4(Buffer.from('')).toString('hex')).toBe('31d6cfe0d16ae931b73c59d7e0c089c0')
    expect(md4(Buffer.from('abc')).toString('hex')).toBe('a448017aaf21d8525fc10ae87aa6729d')
    expect(md4(Buffer.from('12345678901234567890123456789012345678901234567890123456789012345678901234567890')).toString('hex')).toBe(
      'e33b4ddc9c38f2199c3e7b164fcc0536'
    )
  })

  it('NTLMv2 do exemplo da MS-NLMP (4.2.4)', () => {
    expect(ntowfv2('User', 'Password', 'Domain').toString('hex')).toBe('0c868a403bfd7a93a3001ef22ef02e3f')
    const targetInfo = Buffer.concat([
      Buffer.from([2, 0, 12, 0]),
      Buffer.from('Domain', 'utf16le'),
      Buffer.from([1, 0, 12, 0]),
      Buffer.from('Server', 'utf16le'),
      Buffer.alloc(4)
    ])
    const { nt, lm } = ntlmv2Responses(
      { flags: 0, serverChallenge: Buffer.from('0123456789abcdef', 'hex'), targetInfo },
      { username: 'User', password: 'Password', domain: 'Domain' },
      Buffer.alloc(8, 0xaa),
      Buffer.alloc(8)
    )
    expect(nt.subarray(0, 16).toString('hex')).toBe('68cd0ab851e51c96aabc927bebef6a1c')
    expect(lm.toString('hex')).toBe('86c35097ac9cec102554764a57cccc19aaaaaaaaaaaaaaaa')
  })

  it('negotiate tem a assinatura NTLMSSP e um challenge inválido é recusado', () => {
    expect(Buffer.from(ntlmNegotiate(), 'base64').subarray(0, 8).toString('latin1')).toBe('NTLMSSP\0')
    expect(parseNtlmChallenge(ntlmNegotiate())).toBeNull()
  })
})
