import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// O cofre local (@vvpost/core/vault) dos testes: uma pasta por arquivo de teste e a chave em
// arquivo, nunca o cofre nem o keychain de quem roda os testes.
process.env['VVPOST_VAULT_DIR'] = mkdtempSync(join(tmpdir(), 'vvpost-vault-'))
process.env['VVPOST_VAULT_KEYSTORE'] = 'file'
