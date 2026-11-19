import { afterEach, describe, expect, it, vi } from 'vitest'
import { auditHost, controlPlane, recordActivity, setControlPlaneForTests, type ActivityEvent } from '../src/main/enterprise/control-plane'
import { ENTERPRISE_API_VERSION, EnterpriseModuleMissingError, registerEnterpriseModule } from '../src/main/secret-engine/backend'

const event: ActivityEvent = {
  at: '2026-10-24T00:00:00.000Z',
  kind: 'request',
  method: 'GET',
  host: 'api.example.com',
  connectorId: null,
  environmentId: null,
  status: 200,
  errorCode: null,
  durationMs: 12
}

afterEach(() => {
  setControlPlaneForTests(undefined)
  registerEnterpriseModule(null)
})

describe('Control Plane opcional', () => {
  it('sem módulo Enterprise, recordActivity não faz nada e não lança', async () => {
    const cp = await controlPlane(() => Promise.reject(new EnterpriseModuleMissingError()))
    expect(cp).toBeNull()
    expect(() => recordActivity(event)).not.toThrow()
  })

  it('módulo sem controlPlane também vale: só os segredos são Enterprise', async () => {
    const cp = await controlPlane(async () => ({ apiVersion: ENTERPRISE_API_VERSION, createBackend: async () => ({}) as never, audit: () => {} }))
    expect(cp).toBeNull()
  })

  it('entrega a atividade ao controlPlane sem esperar por ele, e engole a falha', async () => {
    const received: ActivityEvent[] = []
    setControlPlaneForTests({ activity: (e) => void received.push(e) })
    recordActivity(event)
    await vi.waitFor(() => expect(received).toEqual([event]))

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    setControlPlaneForTests({
      activity: () => {
        throw new Error('fora do ar')
      }
    })
    expect(() => recordActivity(event)).not.toThrow()
    await vi.waitFor(() => expect(errors).toHaveBeenCalled())
    errors.mockRestore()
  })

  it('recusa um controlPlane sem activity()', () => {
    expect(() =>
      registerEnterpriseModule({
        apiVersion: ENTERPRISE_API_VERSION,
        createBackend: async () => ({}) as never,
        audit: () => {},
        controlPlane: {} as never
      })
    ).toThrow(/controlPlane sem activity/)
  })

  it('auditHost guarda só o host: sem caminho, query, usuário ou {{VAR}}', () => {
    expect(auditHost('https://user:pw@api.example.com:8443/v1/pay?token=abc')).toBe('api.example.com:8443')
    expect(auditHost('{{BASE_URL}}/v1')).toBeNull()
    expect(auditHost('não é url')).toBeNull()
  })
})
