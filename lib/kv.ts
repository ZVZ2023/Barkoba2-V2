import { Redis } from "@upstash/redis";
import { env } from "./env";

// ---------------------------------------------------------------------------
// Minimal KV interface used by gameStore.ts, secretStore.ts, and
// rateLimit.ts. Backed by Upstash Redis in any deployed environment where
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are set. Falls back to
// an in-memory Map for local dev without Upstash configured.
//
// The in-memory fallback is NOT suitable for production: it does not persist
// across serverless function instances or restarts. It exists purely so
// `npm run dev` works out of the box without external setup.
// ---------------------------------------------------------------------------

export interface KVClient {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  incrWithExpiry(key: string, ttlSeconds: number): Promise<number>;
  /**
   * Added in 2.1.3.0. Nothing in Barkoba had ever removed a key before —
   * TTLs did all the work. Durable identity has no TTL, so deleting a claimed
   * Player needs an explicit operation. Kept to exactly that: no pattern
   * delete, no scan, no bulk.
   */
  del(key: string): Promise<void>;
  /**
   * V2.7.x — atomic read-and-delete, for exactly-once consumption of a
   * single-use credential (account-recovery tokens: lib/accountRecovery.ts).
   * A separate get() then del() is NOT equivalent: against real Upstash,
   * those are two independent HTTP round trips, and two concurrent requests
   * for the SAME token could both read a hit before either one's delete
   * lands — both would then be told the token is valid. GETDEL is one Redis
   * command (native since Redis 6.2); only one caller can ever observe a
   * non-null result for a given key, by construction, not by timing luck.
   */
  getdel<T>(key: string): Promise<T | null>;

  /**
   * V2.8.1 — a short-lived advisory lock. True if THIS caller now holds it,
   * false if someone else already does. One native `SET key val NX EX`
   * (atomic on Redis itself; no script needed) — see lib/gameStore.ts's
   * acquireTurnLock, the My Car Key integrity hotfix's guard against two
   * concurrent /turn requests both paying for a Racer call for the same
   * pending question.
   */
  acquireLock(key: string, ttlSeconds: number): Promise<boolean>;
  /** Release a lock this caller previously acquired. Always safe to call. */
  releaseLock(key: string): Promise<void>;

  /**
   * V2.8.1 — atomic compare-and-swap, keyed on a monotonic revision counter.
   *
   * Succeeds ONLY if the integer currently stored at `revisionKey` equals
   * `expectedRevision`; on success, both the revision bump and the
   * `newValue` write land together, atomically, as one Redis Lua script —
   * immune to interleaving from any other caller, unlike a JS-level
   * "read, compare, then write" (two separate HTTP round trips against
   * Upstash, with a window between them any other request can land in).
   *
   * Deliberately uses ONLY `redis.call('GET'|'SET', ...)` inside the script
   * — no external Lua library (no cjson, no bit ops) — so it needs nothing
   * beyond what any Redis-compatible EVAL already guarantees, Upstash's
   * REST-backed EVAL included.
   *
   * This is THE primitive the My Car Key integrity hotfix is built on: see
   * lib/gameStore.ts's saveGameIfRevisionMatches. A stale/retried/duplicate
   * caller's expected revision can never match after a legitimate write has
   * already advanced it, so a stale write can never land, by construction —
   * not by a timing assumption.
   */
  casSetWithRevision<T>(
    dataKey: string,
    revisionKey: string,
    expectedRevision: number,
    newValue: T,
    ttlSeconds: number
  ): Promise<{ ok: true; revision: number } | { ok: false; currentRevision: number }>;
}

class UpstashKV implements KVClient {
  private client: Redis;

  constructor(url: string, token: string) {
    this.client = new Redis({ url, token });
  }

  async get<T>(key: string): Promise<T | null> {
    const val = await this.client.get<T>(key);
    return val ?? null;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.set(key, value, { ex: ttlSeconds });
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async incrWithExpiry(key: string, ttlSeconds: number): Promise<number> {
    const count = await this.client.incr(key);
    if (count === 1) {
      // only set expiry on first increment in the window
      await this.client.expire(key, ttlSeconds);
    }
    return count;
  }

  async getdel<T>(key: string): Promise<T | null> {
    const val = await this.client.getdel<T>(key);
    return val ?? null;
  }

  async acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(key, "1", { nx: true, ex: ttlSeconds });
    return result === "OK";
  }

  async releaseLock(key: string): Promise<void> {
    await this.client.del(key);
  }

  async casSetWithRevision<T>(
    dataKey: string,
    revisionKey: string,
    expectedRevision: number,
    newValue: T,
    ttlSeconds: number
  ): Promise<{ ok: true; revision: number } | { ok: false; currentRevision: number }> {
    // Pure redis.call GET/SET — deliberately no cjson or other library, so
    // this runs on any Redis-compatible EVAL, Upstash's REST-backed one
    // included. current defaults to '0' for a never-initialized key so a
    // caller that legitimately expects revision 0 (a freshly created game)
    // is not rejected by a missing key.
    const script =
      "local current = redis.call('GET', KEYS[1])\n" +
      "if current == false then current = '0' end\n" +
      "if current ~= ARGV[1] then\n" +
      "  return {0, current}\n" +
      "end\n" +
      "local newRevision = tostring(tonumber(ARGV[1]) + 1)\n" +
      "redis.call('SET', KEYS[1], newRevision, 'EX', ARGV[3])\n" +
      "redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])\n" +
      "return {1, newRevision}";

    const [ok, revision] = await this.client.eval<[string, string, string], [number, string]>(
      script,
      [revisionKey, dataKey],
      [String(expectedRevision), JSON.stringify(newValue), String(ttlSeconds)]
    );

    if (ok === 1) return { ok: true, revision: Number(revision) };
    return { ok: false, currentRevision: Number(revision) };
  }
}

type InMemoryEntry = { value: unknown; expiresAt: number | null };

// The dev Map lives on globalThis, not in module scope. Next.js compiles route
// handlers into separate module graphs and re-evaluates modules on hot reload,
// so a module-scoped Map is NOT shared between /api/game/create and
// /api/game/[id]/turn — a game created by one route is invisible to the other,
// and `npm run dev` 404s on every turn. globalThis survives both.
//
// This makes the fallback usable for local development. It does nothing for
// production: separate serverless instances do not share a globalThis either.
const devStore = globalThis as unknown as {
  __barkobaDevKV?: Map<string, InMemoryEntry>;
};

class InMemoryKV implements KVClient {
  private store: Map<string, InMemoryEntry> =
    (devStore.__barkobaDevKV ??= new Map<string, InMemoryEntry>());

  /**
   * Real Upstash always returns a freshly-deserialized value on every GET —
   * there is no way for one caller's mutation of what it read back to reach
   * another caller, or to reach what is actually stored, since an HTTP round
   * trip sits in between. Returning `entry.value` directly here would make
   * this dev-only fallback hand out a SHARED, MUTABLE object reference
   * instead — two independent `getGame()` calls could silently alias the
   * same in-memory GameRecord, so a mutation either side makes (before its
   * own save) would leak into the other's view. That is a fine-in-a-single-
   * process illusion of isolation that real infrastructure never provides,
   * and would make a correctness bug (or a test asserting on it) here and
   * only here. structuredClone makes this fallback match Upstash's actual
   * independent-copy semantics.
   */
  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return structuredClone(entry.value) as T;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    // Cloned on the way in too — otherwise a caller mutating its own
    // in-memory object AFTER calling set() would silently mutate what is
    // "stored", which real serialize-over-HTTP storage can never do either.
    this.store.set(key, {
      value: structuredClone(value),
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async incrWithExpiry(key: string, ttlSeconds: number): Promise<number> {
    const current = (await this.get<number>(key)) ?? 0;
    const next = current + 1;
    await this.set(key, next, ttlSeconds);
    return next;
  }

  /**
   * Synchronous read+delete on the underlying Map, with no `await` between
   * them — safe under Node's single-threaded execution even though this
   * class has no real atomicity primitive of its own: nothing else can run
   * between two synchronous statements in the same turn of the event loop.
   * (This dev-only fallback was never actually the risk the atomic
   * consumption requirement is about — a real concurrent-request race can
   * only happen against Upstash, where get() and del() are separate HTTP
   * round trips. See UpstashKV.getdel, which uses the real GETDEL command.)
   */
  async getdel<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    this.store.delete(key);
    if (entry.expiresAt && entry.expiresAt < Date.now()) return null;
    return structuredClone(entry.value) as T; // see get()'s comment on why
  }

  /**
   * No `await` between the read and the write below — safe under Node's
   * single-threaded execution for the same reason getdel's comment gives:
   * nothing else can run between two synchronous statements in one turn of
   * the event loop. Real concurrent-request atomicity is UpstashKV's job
   * (native SET NX); this dev-only fallback just needs to behave the same
   * way for a single process.
   */
  async acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
    const entry = this.store.get(key);
    const live = entry && (!entry.expiresAt || entry.expiresAt >= Date.now());
    if (live) return false;
    this.store.set(key, { value: "1", expiresAt: Date.now() + ttlSeconds * 1000 });
    return true;
  }

  async releaseLock(key: string): Promise<void> {
    this.store.delete(key);
  }

  async casSetWithRevision<T>(
    dataKey: string,
    revisionKey: string,
    expectedRevision: number,
    newValue: T,
    ttlSeconds: number
  ): Promise<{ ok: true; revision: number } | { ok: false; currentRevision: number }> {
    const currentEntry = this.store.get(revisionKey);
    const current = typeof currentEntry?.value === "number" ? currentEntry.value : 0;
    if (current !== expectedRevision) {
      return { ok: false, currentRevision: current };
    }
    const newRevision = current + 1;
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.store.set(revisionKey, { value: newRevision, expiresAt });
    // Cloned in, same as set() — the caller's in-memory object must not
    // remain aliased to what is now "stored". See get()'s comment.
    this.store.set(dataKey, { value: structuredClone(newValue), expiresAt });
    return { ok: true, revision: newRevision };
  }
}

/**
 * Is durable, cross-instance storage configured?
 *
 * Without it the in-memory fallback is used, and on a serverless host that
 * produces the worst possible failure: game creation succeeds, then every
 * subsequent turn 404s because the next request landed on a different
 * instance. The symptom points nowhere near the cause. /api/game/create checks
 * this and refuses to start a game it cannot finish.
 */
export function isPersistentKvConfigured(): boolean {
  return Boolean(env.upstashUrl() && env.upstashToken());
}

/**
 * Apply the configured namespace to a key.
 *
 * Read lazily on every call rather than captured at construction, because
 * getKV() memoizes its client — a prefix captured once would freeze the
 * namespace for the life of the process and quietly ignore configuration.
 */
export function namespacedKey(key: string): string {
  return `${env.kvNamespace()}${key}`;
}

/**
 * V2.1.1.1 — namespace isolation.
 *
 * V1 and V2 share one Upstash database (a known, temporary infrastructure
 * compromise). Sharing the STORE was tolerable; sharing the COUNTERS was not.
 * `budget:racercalls:<date>` is the daily AI spend ceiling, and callBudget
 * fails closed — so V2 traffic could drive the shared counter to its limit and
 * V1 would then refuse to start games, with its own Anthropic key untouched and
 * full. Separate API keys never covered that, because the binding constraint is
 * Barkóba's own counter rather than anything at the vendor.
 *
 * Every KV operation already funnels through getKV(), so wrapping the client is
 * the entire fix: the four key builders in gameStore, secretStore, rateLimit
 * and callBudget are untouched and cannot forget to apply it.
 */
class NamespacedKV implements KVClient {
  constructor(private readonly inner: KVClient) {}

  get<T>(key: string): Promise<T | null> {
    return this.inner.get<T>(namespacedKey(key));
  }

  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    return this.inner.set(namespacedKey(key), value, ttlSeconds);
  }

  incrWithExpiry(key: string, ttlSeconds: number): Promise<number> {
    return this.inner.incrWithExpiry(namespacedKey(key), ttlSeconds);
  }

  del(key: string): Promise<void> {
    return this.inner.del(namespacedKey(key));
  }

  getdel<T>(key: string): Promise<T | null> {
    return this.inner.getdel<T>(namespacedKey(key));
  }

  acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
    return this.inner.acquireLock(namespacedKey(key), ttlSeconds);
  }

  releaseLock(key: string): Promise<void> {
    return this.inner.releaseLock(namespacedKey(key));
  }

  casSetWithRevision<T>(
    dataKey: string,
    revisionKey: string,
    expectedRevision: number,
    newValue: T,
    ttlSeconds: number
  ): Promise<{ ok: true; revision: number } | { ok: false; currentRevision: number }> {
    return this.inner.casSetWithRevision(
      namespacedKey(dataKey),
      namespacedKey(revisionKey),
      expectedRevision,
      newValue,
      ttlSeconds
    );
  }
}

let cachedClient: KVClient | null = null;

export function getKV(): KVClient {
  if (cachedClient) return cachedClient;

  const url = env.upstashUrl();
  const token = env.upstashToken();

  if (url && token) {
    cachedClient = new NamespacedKV(new UpstashKV(url, token));
  } else {
    if (process.env.NODE_ENV === "production") {
      // eslint-disable-next-line no-console
      console.warn(
        "[barkoba] UPSTASH_REDIS_REST_URL/TOKEN not set in production — " +
          "falling back to in-memory KV. Game state will NOT persist across " +
          "requests reliably. Configure Upstash before real deployment."
      );
    }
    cachedClient = new NamespacedKV(new InMemoryKV());
  }

  return cachedClient;
}
