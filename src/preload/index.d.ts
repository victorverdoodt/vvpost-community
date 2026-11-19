import type { VvpostApi } from '../shared/ipc'

declare global {
  interface Window {
    vvpost: VvpostApi
  }
}

export {}
