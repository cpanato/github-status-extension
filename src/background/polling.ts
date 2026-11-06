import { github, type Cache, type Settings } from "../domain.js";
import { ProviderError, type StatusProvider } from "../providers/github.js";
export function retryDelay(
  failures: number,
  interval: number,
  retryAfter = 0,
  random = Math.random(),
): number {
  return Math.max(
    retryAfter,
    Math.min(60 * 60_000, interval * 60_000 * 2 ** Math.min(failures, 6)) *
      (1 + random * 0.1),
  );
}
export async function fetchCache(
  cache: Cache,
  settings: Settings,
  provider: StatusProvider,
): Promise<Cache> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const snapshot = await provider.fetchStatus(
      github,
      controller.signal,
      settings.intervalMinutes,
    );
    return {
      snapshot,
      checkedAt: Date.now(),
      lastFailure: cache.lastFailure,
      failures: 0,
      nextAttemptAt: Date.now() + settings.intervalMinutes * 60_000,
    };
  } catch (error) {
    const failure =
      error instanceof ProviderError
        ? error
        : new ProviderError(controller.signal.aborted ? "timeout" : "network");
    const now = Date.now();
    const failures = cache.failures + 1;
    return {
      ...cache,
      checkedAt: now,
      lastFailure: now,
      error: failure.kind,
      failures,
      nextAttemptAt:
        now +
        retryDelay(failures, settings.intervalMinutes, failure.retryAfter),
    };
  } finally {
    clearTimeout(timeout);
  }
}
