/**
 * @module
 * Healthcheck Middleware for Hono.
 */

import type { Context } from '../../context'
import type { Env, MiddlewareHandler } from '../../types'
import type { ContentfulStatusCode } from '../../utils/http-status'

export type HealthStatus = 'ok' | 'degraded' | 'unhealthy'

export type CheckStatus = 'ok' | 'failed'

export type HealthCheckResult = boolean | void | Record<string, unknown>

export type HealthCheckFunction<E extends Env = Env> = (
  c: Context<E>
) => Promise<HealthCheckResult> | HealthCheckResult

export interface HealthCheckObject<E extends Env = Env> {
  name: string
  check: HealthCheckFunction<E>
  critical?: boolean
  timeout?: number
}

export type HealthCheckItem<E extends Env = Env> = HealthCheckObject<E>

export type ChecksOption<E extends Env = Env> =
  | Record<string, HealthCheckFunction<E>>
  | HealthCheckObject<E>[]

export interface StatusCodeOptions {
  ok?: ContentfulStatusCode
  degraded?: ContentfulStatusCode
  unhealthy?: ContentfulStatusCode
}

export interface HealthcheckOptions<E extends Env = Env> {
  checks?: ChecksOption<E>
  timeout?: number
  info?:
    | Record<string, unknown>
    | ((c: Context<E>) => Record<string, unknown> | Promise<Record<string, unknown>>)
  uptime?: boolean
  statusCode?: StatusCodeOptions
  headers?: Record<string, string>
  cacheControl?: string | false
}

export interface CheckReport {
  status: CheckStatus
  duration: number
  details?: Record<string, unknown>
  error?: string
}

export interface HealthReport {
  status: HealthStatus
  timestamp: string
  uptime?: number
  info?: Record<string, unknown>
  checks?: Record<string, CheckReport>
}

export type HealthcheckVariables = {
  health?: HealthReport
}

const startTime = Date.now()

const getTime = (): number => {
  try {
    return performance.now()
  } catch {}
  return Date.now()
}

const executeWithTimeout = async <T>(promise: Promise<T>, ms?: number): Promise<T> => {
  if (!ms || ms <= 0) {
    return promise
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Check timed out after ${ms}ms`))
    }, ms)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

/**
 * Healthcheck Middleware for Hono.
 *
 * @template E - The environment type.
 * @param {HealthcheckOptions<E>} [options] - The options for the healthcheck middleware.
 * @returns {MiddlewareHandler<E>} The middleware handler function.
 *
 * @example
 * ```ts
 * import { Hono } from 'hono'
 * import { healthcheck } from 'hono/healthcheck'
 *
 * const app = new Hono()
 *
 * // Simple liveness check
 * app.get('/livez', healthcheck())
 *
 * // Comprehensive readiness check with database and cache probes
 * app.get(
 *   '/readyz',
 *   healthcheck({
 *     timeout: 3000,
 *     uptime: true,
 *     checks: [
 *       {
 *         name: 'database',
 *         critical: true,
 *         check: async (c) => {
 *           // Ping DB
 *           return { latency: '4ms' }
 *         },
 *       },
 *       {
 *         name: 'redis',
 *         critical: false,
 *         check: async () => {
 *           // Ping cache
 *         },
 *       },
 *     ],
 *   })
 * )
 * ```
 */
export const healthcheck = <E extends Env = Env>(
  options?: HealthcheckOptions<E>
): MiddlewareHandler<E> => {
  const globalTimeout = options?.timeout
  const cacheControl =
    options?.cacheControl === false
      ? undefined
      : (options?.cacheControl ?? 'no-cache, no-store, must-revalidate')

  const okStatus: ContentfulStatusCode = options?.statusCode?.ok ?? 200
  const degradedStatus: ContentfulStatusCode = options?.statusCode?.degraded ?? 200
  const unhealthyStatus: ContentfulStatusCode = options?.statusCode?.unhealthy ?? 503

  return async function healthcheck(c) {
    const checkItems: HealthCheckObject<E>[] = []

    if (options?.checks) {
      if (Array.isArray(options.checks)) {
        checkItems.push(...options.checks)
      } else {
        for (const [name, check] of Object.entries(options.checks)) {
          checkItems.push({
            name,
            check,
            critical: true,
          })
        }
      }
    }

    let overallStatus: HealthStatus = 'ok'
    const checksResult: Record<string, CheckReport> = {}

    if (checkItems.length > 0) {
      const results = await Promise.all(
        checkItems.map(async (item) => {
          const checkStart = getTime()
          const isCritical = item.critical !== false
          const effectiveTimeout = item.timeout ?? globalTimeout

          try {
            const rawResult = await executeWithTimeout(
              Promise.resolve(item.check(c)),
              effectiveTimeout
            )
            const duration = Math.round((getTime() - checkStart) * 100) / 100

            if (rawResult === false) {
              return {
                name: item.name,
                critical: isCritical,
                report: {
                  status: 'failed' as const,
                  duration,
                  error: 'Check returned false',
                },
              }
            }

            const details =
              typeof rawResult === 'object' && rawResult !== null ? rawResult : undefined

            return {
              name: item.name,
              critical: isCritical,
              report: {
                status: 'ok' as const,
                duration,
                ...(details ? { details } : {}),
              },
            }
          } catch (err) {
            const duration = Math.round((getTime() - checkStart) * 100) / 100
            const errorMessage = err instanceof Error ? err.message : String(err)

            return {
              name: item.name,
              critical: isCritical,
              report: {
                status: 'failed' as const,
                duration,
                error: errorMessage,
              },
            }
          }
        })
      )

      for (const res of results) {
        checksResult[res.name] = res.report
        if (res.report.status === 'failed') {
          if (res.critical) {
            overallStatus = 'unhealthy'
          } else if (overallStatus !== 'unhealthy') {
            overallStatus = 'degraded'
          }
        }
      }
    }

    let infoResult: Record<string, unknown> | undefined
    if (options?.info) {
      if (typeof options.info === 'function') {
        infoResult = await options.info(c)
      } else {
        infoResult = options.info
      }
    }

    const report: HealthReport = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      ...(options?.uptime
        ? { uptime: Math.round(((Date.now() - startTime) / 1000) * 100) / 100 }
        : {}),
      ...(infoResult ? { info: infoResult } : {}),
      ...(checkItems.length > 0 ? { checks: checksResult } : {}),
    }

    const responseStatus: ContentfulStatusCode =
      overallStatus === 'ok'
        ? okStatus
        : overallStatus === 'degraded'
          ? degradedStatus
          : unhealthyStatus

    const headers = new Headers(options?.headers)
    if (cacheControl) {
      headers.set('Cache-Control', cacheControl)
    }

    return c.json(report, responseStatus, Object.fromEntries(headers.entries()))
  }
}
