import { healthcheck } from '.'
import { Hono } from '../../hono'

describe('healthcheck middleware', () => {
  it('returns a minimal liveness response without exposing metadata', async () => {
    const app = new Hono()
    app.get('/livez', healthcheck())

    const res = await app.request('/livez')

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('reports successful checks as ready', async () => {
    const app = new Hono()
    app.get(
      '/readyz',
      healthcheck({
        checks: [
          { name: 'database', check: async () => {} },
          { name: 'cache', check: async () => {} },
        ],
      })
    )

    const res = await app.request('/readyz')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: 'ok',
      checks: { database: 'ok', cache: 'ok' },
    })
  })

  it('returns 503 for a failed critical check without exposing its error', async () => {
    const app = new Hono()
    app.get(
      '/readyz',
      healthcheck({
        checks: [
          {
            name: 'database',
            check: async () => {
              throw new Error('connection string must stay private')
            },
          },
        ],
      })
    )

    const res = await app.request('/readyz')
    const body = await res.text()

    expect(res.status).toBe(503)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(JSON.parse(body)).toEqual({
      status: 'unhealthy',
      checks: { database: 'error' },
    })
    expect(body).not.toContain('connection string must stay private')
  })

  it('returns 200 with degraded status for a failed non-critical check', async () => {
    const app = new Hono()
    app.get(
      '/readyz',
      healthcheck({
        checks: [
          {
            name: 'redis_cache',
            critical: false,
            check: async () => {
              throw new Error('cache unavailable')
            },
          },
        ],
      })
    )

    const res = await app.request('/readyz')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: 'degraded',
      checks: { redis_cache: 'error' },
    })
  })

  it('includes uptime and custom info only when requested', async () => {
    const app = new Hono()
    app.get('/livez', healthcheck({ uptime: true, info: { version: '1.0.0' } }))

    const res = await app.request('/livez')
    const body = (await res.json()) as { status: string; uptime: number; info: object }

    expect(body.status).toBe('ok')
    expect(body.uptime).toBeGreaterThanOrEqual(0)
    expect(body.info).toEqual({ version: '1.0.0' })
  })

  it('marks a timed out check and aborts its signal', async () => {
    const app = new Hono()
    let aborted = false
    app.get(
      '/readyz',
      healthcheck({
        checks: [
          {
            name: 'database',
            timeout: 5,
            check: (_c, signal) =>
              new Promise<void>((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                  aborted = true
                  reject(new Error('aborted'))
                })
              }),
          },
        ],
      })
    )

    const res = await app.request('/readyz')

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      status: 'unhealthy',
      checks: { database: 'timeout' },
    })
    expect(aborted).toBe(true)
  })

  it('returns at the per-check timeout if a check ignores its abort signal', async () => {
    const app = new Hono()
    let finishCheck: (() => void) | undefined
    app.get(
      '/readyz',
      healthcheck({
        checks: [
          {
            name: 'database',
            timeout: 5,
            check: () => new Promise<void>((resolve) => (finishCheck = resolve)),
          },
        ],
      })
    )

    const response = await Promise.race([
      app.request('/readyz'),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
    ])
    finishCheck?.()

    expect(response).not.toBeNull()
    if (!response) {
      return
    }
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      status: 'unhealthy',
      checks: { database: 'timeout' },
    })
  })

  it('marks unfinished checks as timed out when the global timeout expires', async () => {
    const app = new Hono()
    app.get(
      '/readyz',
      healthcheck({
        timeout: 5,
        checks: [
          { name: 'database', check: async () => {} },
          { name: 'cache', check: () => new Promise<void>(() => {}) },
        ],
      })
    )

    const res = await app.request('/readyz')

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      status: 'unhealthy',
      checks: { database: 'ok', cache: 'timeout' },
    })
  })
})
