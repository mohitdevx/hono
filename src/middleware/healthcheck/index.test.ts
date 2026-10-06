import { Hono } from '../../hono'
import { healthcheck } from './index'

describe('Healthcheck Middleware', () => {
  it('Should return 200 OK with default liveness report', async () => {
    const app = new Hono()
    app.get('/health', healthcheck())

    const res = await app.request('http://localhost/health')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-cache, no-store, must-revalidate')
    expect(res.headers.get('Content-Type')).toMatch(/application\/json/)

    const data = await res.json()
    expect(data.status).toBe('ok')
    expect(typeof data.timestamp).toBe('string')
    expect(new Date(data.timestamp).getTime()).not.toBeNaN()
    expect(data.checks).toBeUndefined()
  })

  it('Should support record-style checks that all pass', async () => {
    const app = new Hono()
    app.get(
      '/health',
      healthcheck({
        checks: {
          syncCheck: () => true,
          asyncCheck: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5))
            return { memory: '50MB' }
          },
          voidCheck: () => {
            // does not return anything
          },
        },
      })
    )

    const res = await app.request('http://localhost/health')
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.status).toBe('ok')
    expect(data.checks.syncCheck.status).toBe('ok')
    expect(typeof data.checks.syncCheck.duration).toBe('number')
    expect(data.checks.asyncCheck.status).toBe('ok')
    expect(data.checks.asyncCheck.details).toEqual({ memory: '50MB' })
    expect(data.checks.voidCheck.status).toBe('ok')
  })

  it('Should return 503 Unhealthy when a critical check fails or throws', async () => {
    const app = new Hono()
    app.get(
      '/health',
      healthcheck({
        checks: [
          {
            name: 'db',
            critical: true,
            check: async () => {
              throw new Error('Database connection failed')
            },
          },
          {
            name: 'cache',
            check: () => true,
          },
        ],
      })
    )

    const res = await app.request('http://localhost/health')
    expect(res.status).toBe(503)

    const data = await res.json()
    expect(data.status).toBe('unhealthy')
    expect(data.checks.db.status).toBe('failed')
    expect(data.checks.db.error).toBe('Database connection failed')
    expect(data.checks.cache.status).toBe('ok')
  })

  it('Should return 503 Unhealthy when a check returns false', async () => {
    const app = new Hono()
    app.get(
      '/health',
      healthcheck({
        checks: {
          ping: () => false,
        },
      })
    )

    const res = await app.request('http://localhost/health')
    expect(res.status).toBe(503)

    const data = await res.json()
    expect(data.status).toBe('unhealthy')
    expect(data.checks.ping.status).toBe('failed')
    expect(data.checks.ping.error).toBe('Check returned false')
  })

  it('Should return 200 Degraded when only non-critical checks fail', async () => {
    const app = new Hono()
    app.get(
      '/health',
      healthcheck({
        checks: [
          {
            name: 'criticalDb',
            critical: true,
            check: () => true,
          },
          {
            name: 'nonCriticalMetrics',
            critical: false,
            check: async () => {
              throw new Error('Metrics backend unavailable')
            },
          },
        ],
      })
    )

    const res = await app.request('http://localhost/health')
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.status).toBe('degraded')
    expect(data.checks.criticalDb.status).toBe('ok')
    expect(data.checks.nonCriticalMetrics.status).toBe('failed')
    expect(data.checks.nonCriticalMetrics.error).toBe('Metrics backend unavailable')
  })

  it('Should enforce timeout on slow checks', async () => {
    const app = new Hono()
    app.get(
      '/health',
      healthcheck({
        timeout: 20,
        checks: [
          {
            name: 'fast',
            check: async () => {
              await new Promise((resolve) => setTimeout(resolve, 5))
              return true
            },
          },
          {
            name: 'slow',
            timeout: 10,
            check: async () => {
              await new Promise((resolve) => setTimeout(resolve, 50))
              return true
            },
          },
        ],
      })
    )

    const res = await app.request('http://localhost/health')
    expect(res.status).toBe(503)

    const data = await res.json()
    expect(data.status).toBe('unhealthy')
    expect(data.checks.fast.status).toBe('ok')
    expect(data.checks.slow.status).toBe('failed')
    expect(data.checks.slow.error).toContain('timed out')
  })

  it('Should include uptime and info metadata', async () => {
    type EnvType = { Bindings: { APP_ENV: string } }
    const app = new Hono<EnvType>()
    app.get(
      '/health',
      healthcheck<EnvType>({
        uptime: true,
        info: (c) => ({
          env: c.env?.APP_ENV ?? 'test',
          version: '1.0.0',
        }),
      })
    )

    const res = await app.request('http://localhost/health')
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.status).toBe('ok')
    expect(typeof data.uptime).toBe('number')
    expect(data.uptime).toBeGreaterThanOrEqual(0)
    expect(data.info).toEqual({
      env: 'test',
      version: '1.0.0',
    })
  })

  it('Should support custom status codes, headers, and cache-control options', async () => {
    const app = new Hono()
    app.get(
      '/health-custom',
      healthcheck({
        statusCode: {
          ok: 200,
          degraded: 207,
          unhealthy: 500,
        },
        cacheControl: 'public, max-age=60',
        headers: {
          'X-Custom-Header': 'HealthService',
        },
        checks: [
          {
            name: 'warnCheck',
            critical: false,
            check: () => false,
          },
        ],
      })
    )

    const res = await app.request('http://localhost/health-custom')
    expect(res.status).toBe(207)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect(res.headers.get('X-Custom-Header')).toBe('HealthService')

    const data = await res.json()
    expect(data.status).toBe('degraded')
  })

  it('Should disable Cache-Control when cacheControl is set to false', async () => {
    const app = new Hono()
    app.get(
      '/health-no-cache-header',
      healthcheck({
        cacheControl: false,
      })
    )

    const res = await app.request('http://localhost/health-no-cache-header')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBeNull()
  })

  it('Should allow checks to access Context c.req properties', async () => {
    const app = new Hono()
    app.get(
      '/health',
      healthcheck({
        checks: {
          headerCheck: (c) => {
            const auth = c.req.header('x-health-token')
            if (auth !== 'secret') {
              throw new Error('Invalid token')
            }
            return true
          },
        },
      })
    )

    // Unauthorized request
    const unauthRes = await app.request('http://localhost/health')
    expect(unauthRes.status).toBe(503)

    // Authorized request
    const authRes = await app.request('http://localhost/health', {
      headers: {
        'x-health-token': 'secret',
      },
    })
    expect(authRes.status).toBe(200)
    const data = await authRes.json()
    expect(data.status).toBe('ok')
    expect(data.checks.headerCheck.status).toBe('ok')
  })

  it('Should support static info object', async () => {
    const app = new Hono()
    app.get(
      '/health-static-info',
      healthcheck({
        info: {
          service: 'auth-service',
          version: '2.1.0',
        },
      })
    )
    const res = await app.request('http://localhost/health-static-info')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.info).toEqual({
      service: 'auth-service',
      version: '2.1.0',
    })
  })

  it('Should handle non-Error throws in checks', async () => {
    const app = new Hono()
    app.get(
      '/health-throw-string',
      healthcheck({
        checks: {
          strError: () => {
            throw 'string failure'
          },
        },
      })
    )
    const res = await app.request('http://localhost/health-throw-string')
    expect(res.status).toBe(503)
    const data = await res.json()
    expect(data.checks.strError.error).toBe('string failure')
  })
})
