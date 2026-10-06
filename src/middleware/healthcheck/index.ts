import type { HealthcheckVariables } from './healthcheck'

export type {
  HealthcheckOptions,
  HealthStatus,
  CheckStatus,
  HealthCheckResult,
  HealthCheckFunction,
  HealthCheckObject,
  HealthCheckItem,
  ChecksOption,
  StatusCodeOptions,
  CheckReport,
  HealthReport,
  HealthcheckVariables,
} from './healthcheck'
export { healthcheck } from './healthcheck'

declare module '../..' {
  interface ContextVariableMap extends HealthcheckVariables {}
}
