import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PluginManagerOptions } from './plugins/manager'

/** Nome do app no Electron (package.json): define a pasta userData. */
const APP_NAME = 'vvpost'

/**
 * Pasta userData do app fora do Electron, a mesma de `app.getPath('userData')`, para o
 * CLI enxergar os plugins que o usuário instalou e desligou no Extensions Hub.
 * `VVPOST_USER_DATA` troca a pasta (CI, testes).
 */
export function defaultUserDataDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const override = env['VVPOST_USER_DATA']
  if (override) return override
  if (platform === 'win32') return join(env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), APP_NAME)
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', APP_NAME)
  return join(env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), APP_NAME)
}

/** Onde ficam os plugins: os oficiais vêm com o app (pasta plugins/), os do usuário em userData. */
export function pluginLocations(appDir: string, userDataDir: string): PluginManagerOptions {
  return {
    officialDir: join(appDir, 'plugins'),
    userDir: join(userDataDir, 'plugins'),
    stateFile: join(userDataDir, 'plugins.json')
  }
}
