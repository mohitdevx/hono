/**
 * @module
 * Healthcheck Middleware for Hono.
 */

import type { Context } from '../../context'
import type { MiddlewareHandler } from '../../types'
import type { JSONValue } from '../../utils/types'

type HealthcheckResult = 'ok' | 'error' | 'timeout'
type HealthcheckStatus = 'ok' | 'degraded' | 'unhealthy'

export type HealthcheckInfo = Record<string, JSONValue>

export type HealthcheckCheck = {
  /** A unique name used to identify this check in the response. */
  name: string
  /** Whether a failure should make the endpoint return 503. Defaults to `true`. */
  critical?: boolean
  /** Maximum time in milliseconds for this check. */
  timeout?: number
  /** Throw or reject when the dependency is unavailable. The signal is aborted on timeout. */
  check: (c: Context, signal: AbortSignal) => void | Promise<unknown>
}

export type HealthcheckOptions = {
  /** Checks to run concurrently for a readiness probe. */
  checks?: HealthcheckCheck[]
  /** Maximum time in milliseconds to wait for all checks. Unfinished checks are aborted. */
  timeout?: number
  /** Include process uptime in seconds in the response. */
  uptime?: boolean
  /** Optional JSON metadata to include in the response. */
  info?: HealthcheckInfo | ((c: Context) => HealthcheckInfo)
}

type CheckRecord = {
  check: HealthcheckCheck
  controller: AbortController
  result?: HealthcheckResult
  timeoutId?: ReturnType<typeof setTimeout>
}

const validateTimeout = (timeout: number | undefined, label: string) => {
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) {
    throw new RangeError(`${label} must be a finite number greater than or equal to 0`)
  }
}

/**
 * Healthcheck middleware for liveness and readiness endpoints.
 *
 * Checks run concurrently. A failed critical check returns `503` and an
 * `unhealthy` status. A failed non-critical check returns `200` and a
 * `degraded` status. Check errors are not included in the response.
 *
 * @param options - Readiness checks, timeouts, and optional response metadata.
 * @returns A Hono middleware handler.
 *
 * @example
 * ```ts
 * import { healthcheck } from 'hono/healthcheck'
 *
 * app.get('/livez', healthcheck())
 * app.get(
 *   '/readyz',
 *   healthcheck({
 *     timeout: 1000,
 *     checks: [
 *       {
 *         name: 'database',
 *         timeout: 500,
 *         check: async (_c, signal) => db.ping({ signal }),
 *       },
 *     ],
 *   })
 * )
 * ```
 */
export const healthcheck = (options: HealthcheckOptions = {}): MiddlewareHandler => {
  const startedAt = Date.now()
  const checks = options.checks ?? []

  validateTimeout(options.timeout, 'timeout')
  const names = new Set<string>()
  for (const check of checks) {
    validateTimeout(check.timeout, `timeout for check "${check.name}"`)
    if (names.has(check.name)) {
      throw new TypeError(`Healthcheck names must be unique: "${check.name}"`)
    }
    names.add(check.name)
  }

  return async (c) => {
    c.header('Cache-Control', 'no-store')

    const records: CheckRecord[] = checks.map((check) => ({
      check,
      controller: new AbortController(),
    }))

    const finishCheck = (record: CheckRecord, result: HealthcheckResult) => {
      if (record.result !== undefined) {
        return
      }

      record.result = result
      if (record.timeoutId !== undefined) {
        clearTimeout(record.timeoutId)
        record.timeoutId = undefined
      }
    }

    const checkPromises = records.map((record) => {
      const checkPromise = Promise.resolve()
        .then(() => record.check.check(c, record.controller.signal))
        .then(
          () => finishCheck(record, 'ok'),
          () => finishCheck(record, record.controller.signal.aborted ? 'timeout' : 'error')
        )

      if (record.check.timeout === undefined) {
        return checkPromise
      }

      const timeoutPromise = new Promise<void>((resolve) => {
        record.timeoutId = setTimeout(() => {
          record.controller.abort()
          finishCheck(record, 'timeout')
          resolve()
        }, record.check.timeout)
      })

      return Promise.race([checkPromise, timeoutPromise])
    })

    let globalTimeoutId: ReturnType<typeof setTimeout> | undefined
    try {
      if (options.timeout === undefined) {
        await Promise.all(checkPromises)
      } else {
        await Promise.race([
          Promise.all(checkPromises),
          new Promise<void>((resolve) => {
            globalTimeoutId = setTimeout(() => {
              for (const record of records) {
                if (record.result === undefined) {
                  record.controller.abort()
                  finishCheck(record, 'timeout')
                }
              }
              resolve()
            }, options.timeout)
          }),
        ])
      }
    } finally {
      if (globalTimeoutId !== undefined) {
        clearTimeout(globalTimeoutId)
      }
      for (const record of records) {
        if (record.timeoutId !== undefined) {
          clearTimeout(record.timeoutId)
        }
      }
    }

    const hasFailure = records.some((record) => record.result !== 'ok')
    const hasCriticalFailure = records.some(
      (record) => record.result !== 'ok' && record.check.critical !== false
    )
    const status: HealthcheckStatus = hasCriticalFailure
      ? 'unhealthy'
      : hasFailure
        ? 'degraded'
        : 'ok'

    const body: {
      status: HealthcheckStatus
      checks?: Record<string, HealthcheckResult>
      uptime?: number
      info?: HealthcheckInfo
    } = { status }

    if (records.length > 0) {
      body.checks = Object.fromEntries(
        records.map((record) => [record.check.name, record.result ?? 'timeout'])
      )
    }
    if (options.uptime) {
      body.uptime = Math.floor((Date.now() - startedAt) / 1000)
    }
    if (options.info !== undefined) {
      body.info = typeof options.info === 'function' ? options.info(c) : options.info
    }

    return c.json(body, status === 'unhealthy' ? 503 : 200)
  }
}
