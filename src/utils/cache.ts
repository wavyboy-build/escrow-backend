import type NodeCache from "node-cache";
import logger from "./logger.js";

// ---------------------------------------------------------------------------
// Bounded-cache helper (#1043)
// ---------------------------------------------------------------------------
// Every NodeCache is created with a `maxKeys` bound so a burst of
// attacker-controlled keys cannot grow the cache until the container is OOM
// killed. node-cache throws an `ECACHEFULL` error once that bound is reached;
// a bounded cache that cannot accept another entry is a cache miss, never a
// request failure, so `safeCacheSet` logs at debug and skips the write.

function isCacheFullError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { errorcode?: unknown }).errorcode === "ECACHEFULL"
  );
}

/**
 * Store a value in `cache`, tolerating a cache that is at its `maxKeys` bound.
 * Any error other than `ECACHEFULL` is rethrown.
 */
export function safeCacheSet<T>(
  cache: NodeCache,
  key: string,
  value: T,
  ttl?: number,
): void {
  try {
    if (ttl === undefined) {
      cache.set<T>(key, value);
    } else {
      cache.set<T>(key, value, ttl);
    }
  } catch (err) {
    if (!isCacheFullError(err)) throw err;
    logger.debug("Cache at maxKeys capacity – skipping entry", { key });
  }
}
