// Bounded KV cache, HTTP fetch helper with polite headers & rate-limit cooldown,
// and item snapshot storage so /items/{id}, /changes, and /resolve stay fast.

import { rethrowIfHostFault } from "./text.ts";
import type { EtherHttpResponse, KindItem, PluginSettings } from "./types.ts";

const KV_PREFIX_CACHE = "c:";
const KV_PREFIX_ITEM = "item:";
const KV_PREFIX_COOLDOWN = "cd:";
const KV_KEY_STATS = "meta:stats";
const KV_KEY_PENDING_RESOLVE = "res:";
const KV_PREFIX_PART_URLS = "purls:";
const KV_QUOTA_GUARD_RATIO = 0.85;

interface CacheEnvelope<T> {
  exp: number;
  v: T;
}

export interface SyncStats {
  booksCount: number;
  audiobooksCount: number;
  lastSyncAt: number;
  sources: Record<string, { ok: boolean; count: number; note?: string }>;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function readSettings(): PluginSettings {
  let raw: Record<string, unknown> = {};
  try {
    raw = ether.settings.get() || {};
  } catch (err) {
    rethrowIfHostFault(err);
  }
  let hardcoverToken = "";
  try {
    const sec = ether.secret.get("hardcover_token");
    if (typeof sec === "string") hardcoverToken = sec.trim();
  } catch (err) {
    rethrowIfHostFault(err);
  }
  let metronPassword = "";
  try {
    const sec = ether.secret.get("metron_password");
    if (typeof sec === "string") metronPassword = sec.trim();
  } catch (err) {
    rethrowIfHostFault(err);
  }
  const boolVal = (k: string, def: boolean): boolean =>
    typeof raw[k] === "boolean" ? (raw[k] as boolean) : def;
  const strVal = (k: string, def: string): string =>
    typeof raw[k] === "string" && (raw[k] as string).trim() ? (raw[k] as string).trim() : def;

  const lang = strVal("language", "en") === "any" ? "any" : "en";
  const sizeRaw = strVal("catalog_size", "standard");
  const catalogSize =
    sizeRaw === "compact" || sizeRaw === "large" ? sizeRaw : "standard";

  return {
    hardcoverToken,
    enableOpenLibrary: boolVal("enable_openlibrary", true),
    enableAudibleMetadata: boolVal("enable_audible_metadata", true),
    enableStandardEbooks: boolVal("enable_standard_ebooks", true),
    enableLibriVox: boolVal("enable_librivox", true),
    enableGutenberg: boolVal("enable_gutenberg", false),
    language: lang,
    catalogSize,
    ebookCategories: strVal("ebook_categories", "7000,7020"),
    audiobookCategories: strVal("audiobook_categories", "3030"),
    preferUnabridged: boolVal("prefer_unabridged", true),
    preferCached: boolVal("prefer_cached", true),
    contactEmail: typeof raw["contact_email"] === "string" ? (raw["contact_email"] as string).trim() : "",
    enableManga: boolVal("enable_manga", true),
    mangaTitles: Math.max(20, Math.min(1000, Math.trunc(Number(raw["manga_titles"]) || 100))),
    mangaOrder: ["popular", "trending", "newest"].includes(strVal("manga_order", "popular"))
      ? strVal("manga_order", "popular")
      : "popular",
    includeAdultManga: boolVal("include_adult_manga", false),
    enableMangaUpdates: boolVal("enable_mangaupdates", true),
    volumesPerSeries: Math.max(1, Math.min(300, Math.trunc(Number(raw["volumes_per_series"]) || 50))),
    metronUser: strVal("metron_username", ""),
    metronPassword,
    comicSeries: (Array.isArray(raw["comic_series"])
      ? (raw["comic_series"] as unknown[])
      : String(raw["comic_series"] || "").split(/[\n,]+/)
    )
      .map((x) => String(x || "").trim())
      .filter(Boolean)
      .slice(0, 100),
    comicNewWeeks: Math.max(0, Math.min(12, Math.trunc(Number(raw["comic_new_weeks"] ?? 2)))),
    comicsCategories: strVal("comics_categories", "7030"),
  };
}

function kvCanWrite(): boolean {
  try {
    const u = ether.kv.usage();
    if (!u || !u.quotaBytes || !u.quotaKeys) return true;
    return (
      u.bytes < u.quotaBytes * KV_QUOTA_GUARD_RATIO &&
      u.keys < u.quotaKeys * KV_QUOTA_GUARD_RATIO
    );
  } catch (err) {
    rethrowIfHostFault(err);
    return true;
  }
}

export function kvGetJson<T>(key: string): T | null {
  try {
    const raw = ether.kv.get(key);
    if (!raw) return null;
    const env = JSON.parse(raw) as CacheEnvelope<T>;
    if (!env || typeof env !== "object") return null;
    if (env.exp > 0 && nowSec() > env.exp) {
      try {
        ether.kv.delete(key);
      } catch {
        // ignore cleanup failure
      }
      return null;
    }
    return env.v;
  } catch (err) {
    rethrowIfHostFault(err);
    return null;
  }
}

export function kvPutJson<T>(key: string, value: T, ttlSec: number): void {
  if (!kvCanWrite()) return;
  try {
    const payload = JSON.stringify({
      exp: ttlSec > 0 ? nowSec() + ttlSec : 0,
      v: value,
    });
    // Keep single values safely bounded under 256 KB.
    if (payload.length > 256 * 1024) return;
    ether.kv.put(key, payload);
  } catch (err) {
    rethrowIfHostFault(err);
  }
}

export function cacheGet<T>(key: string): T | null {
  return kvGetJson<T>(KV_PREFIX_CACHE + key);
}

export function cachePut<T>(key: string, value: T, ttlSec: number): void {
  kvPutJson(KV_PREFIX_CACHE + key, value, ttlSec);
}

export function clearMetadataCache(): number {
  let cleared = 0;
  try {
    const keys = ether.kv.list(KV_PREFIX_CACHE) || [];
    for (const k of keys) {
      ether.kv.delete(k);
      cleared++;
    }
    const cds = ether.kv.list(KV_PREFIX_COOLDOWN) || [];
    for (const k of cds) {
      ether.kv.delete(k);
      cleared++;
    }
  } catch (err) {
    rethrowIfHostFault(err);
  }
  return cleared;
}

export function isOnCooldown(provider: string): boolean {
  const until = kvGetJson<number>(KV_PREFIX_COOLDOWN + provider);
  return typeof until === "number" && until > nowSec();
}

export function setCooldown(provider: string, seconds: number): void {
  const until = nowSec() + Math.max(15, seconds);
  kvPutJson(KV_PREFIX_COOLDOWN + provider, until, Math.max(15, seconds) + 10);
}

export function storeItemSnapshot(kind: "books" | "audiobooks", item: KindItem): void {
  kvPutJson(`${KV_PREFIX_ITEM}${kind}:${item.id}`, item, 7 * 24 * 3600);
}

export function loadItemSnapshot(kind: "books" | "audiobooks", id: string): KindItem | null {
  return kvGetJson<KindItem>(`${KV_PREFIX_ITEM}${kind}:${id}`);
}

export function saveSyncStats(stats: SyncStats): void {
  kvPutJson(KV_KEY_STATS, stats, 30 * 24 * 3600);
}

export function loadSyncStats(): SyncStats | null {
  return kvGetJson<SyncStats>(KV_KEY_STATS);
}

export function storePreparedSources(key: string, value: unknown, ttlSec = 1800): void {
  kvPutJson(KV_KEY_PENDING_RESOLVE + key, value, ttlSec);
}

export function loadPreparedSources<T>(key: string): T | null {
  return kvGetJson<T>(KV_KEY_PENDING_RESOLVE + key);
}

export function storePartUrls(itemId: string, urls: string[]): void {
  if (!itemId || !urls.length) return;
  kvPutJson(KV_PREFIX_PART_URLS + itemId, urls, 14 * 24 * 3600);
}

export function loadPartUrls(itemId: string): string[] | null {
  if (!itemId) return null;
  return kvGetJson<string[]>(KV_PREFIX_PART_URLS + itemId);
}

export function buildUserAgent(settings?: PluginSettings): string {
  const email = settings?.contactEmail?.trim();
  return email
    ? `EtherBooksPlugin/1.0 (${email})`
    : "EtherBooksPlugin/1.0 (https://github.com/braedonsaunders/ether)";
}

export function fetchText(
  url: string,
  opts?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    provider?: string;
    settings?: PluginSettings;
  },
): EtherHttpResponse | null {
  const provider = opts?.provider;
  if (provider && isOnCooldown(provider)) {
    return null;
  }
  const headers: Record<string, string> = {
    "User-Agent": buildUserAgent(opts?.settings),
    Accept: "application/json, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
    ...(opts?.headers || {}),
  };
  let resp: EtherHttpResponse;
  try {
    resp = ether.http.fetch({
      method: opts?.method || "GET",
      url,
      headers,
      body: opts?.body,
    });
  } catch (err) {
    rethrowIfHostFault(err);
    ether.log(`http.fetch error (${provider || "http"}) ${url}: ${String(err)}`);
    return null;
  }
  if (resp.status === 429) {
    const retryAfter = parseInt(resp.headers?.["retry-after"] || resp.headers?.["Retry-After"] || "60", 10);
    if (provider) setCooldown(provider, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 600) : 60);
    return resp;
  }
  if (resp.status >= 500 && provider) {
    setCooldown(provider, 30);
  }
  return resp;
}

export function fetchJson<T>(
  url: string,
  opts?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    provider?: string;
    settings?: PluginSettings;
    cacheKey?: string;
    cacheTtlSec?: number;
  },
): T | null {
  if (opts?.cacheKey) {
    const hit = cacheGet<T>(opts.cacheKey);
    if (hit !== null) return hit;
  }
  const resp = fetchText(url, opts);
  if (!resp || resp.status < 200 || resp.status >= 300 || !resp.body) {
    return null;
  }
  try {
    const parsed = JSON.parse(resp.body) as T;
    if (opts?.cacheKey && opts?.cacheTtlSec) {
      cachePut(opts.cacheKey, parsed, opts.cacheTtlSec);
    }
    return parsed;
  } catch {
    return null;
  }
}
