// Main entry point for ether.books (Books and audiobooks content plugin).
// Handles all catalog_provider, kind_resolver, matcher, job, health, and UI routes.

import { clearMetadataCache, nowSec, readSettings } from "./cache.ts";
import {
  buildCatalogItems,
  expandCatalogFacet,
  getItemDetail,
  liveSearchCatalog,
  reconcileStoredCatalog,
  resetCatalogCachesForUpgrade,
} from "./curated.ts";
import { comicsChildren, comicsEnabled, comicsItemDetail, comicsSeriesItems } from "./comics.ts";
import { matchKindCandidates, resolveKindItem, runPrepareJob } from "./resolver.ts";
import { rethrowIfHostFault } from "./text.ts";
import type {
  KindBrowseRequest,
  KindChangePage,
  KindExpandRequest,
  KindItem,
  KindMatchRequest,
  KindPage,
  KindResolveRequest,
  PluginRequest,
  PluginResponse,
} from "./types.ts";
import {
  buildStatusView,
  handleClearCacheAction,
  runCatalogConnectivityTest,
} from "./views.ts";

function jsonResp(status: number, body: unknown): PluginResponse {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body,
  };
}

function errorResp(status: number, code: string, message: string): PluginResponse {
  return jsonResp(status, { error: { code, message } });
}

const PLUGIN_VERSION = "1.1.0";
const CHANGES_REV = "v6";

function mergeCatalogUpserts(
  catalog: KindItem[],
  extraUpserts: KindItem[],
  suppressedFreshIds: string[],
): KindItem[] {
  if (extraUpserts.length === 0 && suppressedFreshIds.length === 0) {
    return catalog;
  }
  const suppressed = new Set(suppressedFreshIds);
  const extraById = new Map<string, KindItem>();
  for (const item of extraUpserts) {
    if (item?.id) extraById.set(item.id, item);
  }
  const seen = new Set<string>();
  const out: KindItem[] = [];
  for (const item of catalog) {
    if (!item?.id || suppressed.has(item.id)) continue;
    const replacement = extraById.get(item.id);
    out.push(replacement || item);
    seen.add(item.id);
  }
  for (const item of extraUpserts) {
    if (!item?.id || seen.has(item.id)) continue;
    out.push(item);
    seen.add(item.id);
  }
  return out;
}

function parseBody<T>(req: PluginRequest): T {
  if (!req.body) return {} as T;
  if (typeof req.body === "object") return req.body as unknown as T;
  try {
    return JSON.parse(req.body) as T;
  } catch {
    return {} as T;
  }
}

function paginateItems(
  items: KindItem[],
  cursorRaw?: string,
  limitRaw?: number,
): KindPage {
  const limit = Math.max(1, Math.min(limitRaw && limitRaw > 0 ? limitRaw : 50, 200));
  const offset = cursorRaw ? Math.max(0, parseInt(cursorRaw, 10) || 0) : 0;
  const slice = items.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  return {
    items: slice,
    nextCursor: nextOffset < items.length ? String(nextOffset) : undefined,
    total: items.length,
  };
}

function parseKindRoute(
  path: string,
): { kind: "books" | "audiobooks" | "comics"; action: string; itemId?: string } | null {
  const prefix = "/ether/v1/kinds/";
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  const parts = rest.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const kind = parts[0];
  if (kind !== "books" && kind !== "audiobooks" && kind !== "comics") return null;
  if (parts[1] === "items" && parts.length >= 3) {
    return { kind, action: "item", itemId: decodeURIComponent(parts.slice(2).join("/")) };
  }
  return { kind, action: parts[1] };
}

export function handle(req: PluginRequest): PluginResponse {
  try {
    const path = req.path || "/";
    const settings = readSettings();

    // Standard lifecycle & diagnostics routes
    if (path === "/ether/health") {
      return jsonResp(200, {
        status: "ok",
        plugin: "ether.books",
        version: PLUGIN_VERSION,
        kinds: ["books", "audiobooks", "comics"],
      });
    }

    if (path === "/ether/configure") {
      clearMetadataCache();
      return jsonResp(200, { ok: true });
    }

    if (path === "/ether/test") {
      const result = runCatalogConnectivityTest(settings);
      return jsonResp(result.ok ? 200 : 502, result);
    }

    // Console UI status page & actions
    if (path === "/ether/view/status") {
      return jsonResp(200, buildStatusView(settings));
    }

    if (path === "/ether/action/clearCache") {
      return jsonResp(200, handleClearCacheAction());
    }

    if (path === "/ether/action/testConnections") {
      return jsonResp(200, runCatalogConnectivityTest(settings));
    }

    // Background job for slow release_files preparation
    if (path === "/ether/job/prepare") {
      const body = parseBody<Record<string, unknown>>(req);
      return jsonResp(200, runPrepareJob(body, settings));
    }

    // Kind provider / resolver / matcher routes
    const route = parseKindRoute(path);
    if (!route) {
      return errorResp(404, "not_found", `Unknown route: ${path}`);
    }

    const { kind, action, itemId } = route;

    // Comics & Manga: one card per series at the top level, its volumes or
    // issues inside it. Resolve and match use the shared book paths, which
    // pick the comics queries and scoring for comics items.
    if (kind === "comics") {
      if (action === "resolve") {
        return jsonResp(200, resolveKindItem(parseBody<KindResolveRequest>(req), settings));
      }
      if (action === "match") {
        return jsonResp(200, matchKindCandidates(parseBody<KindMatchRequest>(req), settings));
      }
      if (action === "browse") {
        const body = parseBody<KindBrowseRequest>(req);
        if (!comicsEnabled(settings)) return jsonResp(200, { items: [] });
        if (body.parentId) {
          return jsonResp(
            200,
            paginateItems(comicsChildren(String(body.parentId), settings), body.cursor, body.limit),
          );
        }
        return jsonResp(200, paginateItems(comicsSeriesItems(settings), body.cursor, body.limit));
      }
      if (action === "item" && itemId) {
        const detail = comicsEnabled(settings) ? comicsItemDetail(itemId, settings) : null;
        return detail
          ? jsonResp(200, detail)
          : errorResp(404, "not_found", `Item ${itemId} not found`);
      }
      // No delta feed: Ether re-walks the cached list and keeps unchanged items by etag.
      if (action === "changes") {
        return errorResp(501, "not_implemented", "Comics are re-listed on each refresh.");
      }
      return errorResp(404, "not_found", `Unsupported comics action: ${action}`);
    }

    if (action === "browse") {
      const body = parseBody<KindBrowseRequest>(req);
      // Both kinds are single-level roots; any child parentId has no sub-levels.
      if (body.parentId) {
        return jsonResp(200, { items: [] });
      }
      const catalog = buildCatalogItems(kind, settings);
      return jsonResp(200, paginateItems(catalog, body.cursor, body.limit));
    }

    if (action === "changes") {
      const body = parseBody<{ cursor?: string; limit?: number }>(req);
      const limit = Math.max(1, Math.min(body.limit && body.limit > 0 ? body.limit : 100, 250));
      const cursor = (body.cursor || "").trim();

      // Cursor format: "sync:<unixTs>:<offset>" or "<CHANGES_REV>:<unixTs>" (steady-state token).
      // Any cursor from an earlier revision (e.g. after an in-place plugin upgrade) or older
      // than 3 hours triggers a clean catalog upsert + stored-item hygiene reconciliation.
      const revPrefix = `${CHANGES_REV}:`;
      if (cursor.startsWith("v")) {
        const isCurrentRev = cursor.startsWith(revPrefix);
        const lastTs = isCurrentRev ? parseInt(cursor.slice(revPrefix.length), 10) || 0 : 0;
        if (isCurrentRev && nowSec() - lastTs < 3 * 3600) {
          const resp: KindChangePage = {
            upserts: [],
            deletes: [],
            nextCursor: cursor,
            complete: true,
          };
          return jsonResp(200, resp);
        }
        if (!isCurrentRev) {
          resetCatalogCachesForUpgrade();
        }
        const ts = nowSec();
        const catalog = buildCatalogItems(kind, settings);
        const { extraUpserts, deletes, suppressedFreshIds } = reconcileStoredCatalog(
          kind,
          catalog,
          settings,
        );
        const allUpserts = mergeCatalogUpserts(catalog, extraUpserts, suppressedFreshIds);
        const slice = allUpserts.slice(0, limit);
        const done = slice.length >= allUpserts.length;
        if (!done && (extraUpserts.length > 0 || suppressedFreshIds.length > 0)) {
          try {
            ether.kv.put(
              `c:sync_extra:${kind}:${ts}`,
              JSON.stringify({
                exp: ts + 600,
                v: extraUpserts,
                s: suppressedFreshIds,
              }),
            );
          } catch {
            // non-fatal
          }
        }
        const resp: KindChangePage = {
          upserts: slice,
          deletes,
          nextCursor: done ? `${revPrefix}${ts}` : `sync:${ts}:${slice.length}`,
          complete: done,
        };
        return jsonResp(200, resp);
      }

      if (cursor.startsWith("sync:")) {
        const parts = cursor.split(":");
        const ts = parseInt(parts[1] || "0", 10) || nowSec();
        const offset = Math.max(0, parseInt(parts[2] || "0", 10) || 0);
        const catalog = buildCatalogItems(kind, settings);
        let extraUpserts: KindItem[] = [];
        let suppressedFreshIds: string[] = [];
        try {
          const rawExtra = ether.kv.get(`c:sync_extra:${kind}:${ts}`);
          if (rawExtra) {
            const parsed = JSON.parse(rawExtra) as { v?: KindItem[]; s?: string[] };
            if (Array.isArray(parsed?.v)) extraUpserts = parsed.v;
            if (Array.isArray(parsed?.s)) suppressedFreshIds = parsed.s;
          }
        } catch {
          // ignore
        }
        const allUpserts = mergeCatalogUpserts(catalog, extraUpserts, suppressedFreshIds);
        const slice = allUpserts.slice(offset, offset + limit);
        const nextOffset = offset + slice.length;
        const done = nextOffset >= allUpserts.length;
        if (done) {
          try {
            ether.kv.delete(`c:sync_extra:${kind}:${ts}`);
          } catch {
            // ignore
          }
        }
        const resp: KindChangePage = {
          upserts: slice,
          deletes: [],
          nextCursor: done ? `${revPrefix}${ts}` : `sync:${ts}:${nextOffset}`,
          complete: done,
        };
        return jsonResp(200, resp);
      }

      // Initial changes probe right after full browse walk: anchor cursor cleanly
      const resp: KindChangePage = {
        upserts: [],
        deletes: [],
        nextCursor: `${revPrefix}${nowSec()}`,
        complete: true,
      };
      return jsonResp(200, resp);
    }

    if (action === "search") {
      const body = parseBody<KindBrowseRequest>(req);
      const q = (body.query || "").trim();
      const limit = Math.max(1, Math.min(body.limit && body.limit > 0 ? body.limit : 24, 50));
      if (!q) {
        return jsonResp(200, { items: [] });
      }
      const items = liveSearchCatalog(kind, q, settings, limit);
      return jsonResp(200, { items, total: items.length });
    }

    if (action === "expand") {
      const body = parseBody<KindExpandRequest>(req);
      const expanded = expandCatalogFacet(kind, body.facet || "", body.value || "", body.cursor, settings);
      return jsonResp(200, expanded);
    }

    if (action === "item" && itemId) {
      const detail = getItemDetail(kind, itemId, settings);
      if (!detail) {
        return errorResp(404, "not_found", `Item ${itemId} not found`);
      }
      return jsonResp(200, detail);
    }

    if (action === "resolve") {
      const body = parseBody<KindResolveRequest>(req);
      const res = resolveKindItem(body, settings);
      return jsonResp(200, res);
    }

    if (action === "match") {
      const body = parseBody<KindMatchRequest>(req);
      const res = matchKindCandidates(body, settings);
      return jsonResp(200, res);
    }

    return errorResp(404, "not_found", `Unsupported kind action: ${action}`);
  } catch (err) {
    rethrowIfHostFault(err);
    ether.log(`Unhandled plugin error on ${req.path}: ${String(err)}`);
    return errorResp(500, "internal_error", String(err));
  }
}

(globalThis as Record<string, unknown>).handle = handle;
