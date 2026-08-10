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

  async incrWithExpiry(key: string, ttlSeconds: number): Promise<number> {
    const count = await this.client.incr(key);
    if (count === 1) {
      // only set expiry on first increment in the window
      await this.client.expire(key, ttlSeconds);
    }
    return count;
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

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
  }

  async incrWithExpiry(key: string, ttlSeconds: number): Promise<number> {
    const current = (await this.get<number>(key)) ?? 0;
    const next = current + 1;
    await this.set(key, next, ttlSeconds);
    return next;
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
