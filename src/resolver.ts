// Kind resolver (/resolve), matcher (/match), and background slow-resolve job
// (/ether/job/prepare). Resolves direct public-domain sources immediately and
// uses Ether's configured indexers + debrid + release_files inspection for all
// other editions with strict W186 #659 explicit file/fileIndex/fileHint targeting.

import { loadPartUrls, loadPreparedSources, storePreparedSources } from "./cache.ts";
import { fetchLibriVoxById } from "./providers/librivox.ts";
import {
  buildSearchQueries,
  candidateRefOf,
  extractTargetMeta,
  scoreCandidate,
  selectReleaseFiles,
} from "./matching.ts";
import { comicsQueries, comicsScore, isComicsItem } from "./comics.ts";
import { fnv1aHex, rethrowIfHostFault } from "./text.ts";
import type {
  KindItem,
  KindMatchRequest,
  KindMatchResponse,
  KindResolveRequest,
  KindResolveResponse,
  PlayableSource,
  PluginSettings,
  ReleaseFile,
  SourceCandidate,
} from "./types.ts";

const SOFT_RESOLVE_BUDGET_MS = 2100;
const MAX_USENET_CHECKS = 3;

interface UsenetCheckState {
  used: number;
  disabled: boolean;
}

// Comics and manga volumes search their own indexer category and use their
// own release queries and scoring (comics.ts).
function searchCategory(item: KindItem, kind: string, settings: PluginSettings): string {
  if (isComicsItem(item)) return settings.comicsCategories;
  return kind === "audiobooks" ? settings.audiobookCategories : settings.ebookCategories;
}

function queriesFor(item: KindItem): string[] {
  return isComicsItem(item) ? comicsQueries(item) : buildSearchQueries(item);
}

function scoreFor(item: KindItem, cand: SourceCandidate, settings: PluginSettings) {
  return isComicsItem(item) ? comicsScore(item, cand) : scoreCandidate(item, cand, settings);
}

function isUsenetOnlyCandidate(cand: SourceCandidate | undefined): boolean {
  return Boolean(cand?.nzbUrl && !cand.infoHash && !cand.magnet);
}

function isUsenetCandidateAlive(
  cand: SourceCandidate | undefined,
  state: UsenetCheckState,
): boolean {
  if (!cand || !isUsenetOnlyCandidate(cand)) return true;
  if (state.disabled || state.used >= MAX_USENET_CHECKS) return true;

  state.used++;
  try {
    const resp = ether.sources.resolve({
      kind: "usenet_check",
      nzbUrl: cand.nzbUrl,
      candidate: cand,
    });
    const verdict = resp?.candidates?.[0]?.usenetCheck;
    if (!verdict) return true;
    if (verdict.playbackFailed || verdict.available === false) {
      ether.log(
        `dropping dead usenet candidate "${cand.title || cand.nzbUrl}" ` +
          `(reason=${verdict.reason || "unavailable"} missing=${verdict.missing}/${verdict.checked} ` +
          `playbackFailed=${Boolean(verdict.playbackFailed)} cached=${Boolean(verdict.cached)})`,
      );
      return false;
    }
    return true;
  } catch (err) {
    rethrowIfHostFault(err);
    const msg = String((err as { message?: unknown })?.message ?? err);
    if (/rate_limit|429|invalid|unknown|unsupported|unavailable|background/i.test(msg)) {
      state.disabled = true;
    }
    ether.log(`usenet_check skipped for "${cand.title || cand.nzbUrl}": ${msg}`);
    return true;
  }
}

interface PreparedJobInput {
  item: KindItem;
  partIndex?: number;
  candidates: SourceCandidate[];
}

function preparedCacheKey(item: KindItem, partIndex?: number): string {
  const p = partIndex !== undefined ? `:p${partIndex}` : "";
  return `src:${item.level}:${item.id}${p}`;
}

function pendingJobKey(item: KindItem, partIndex?: number): string {
  const p = partIndex !== undefined ? `:p${partIndex}` : "";
  return `job:${item.level}:${item.id}${p}`;
}

function resolveDirectSources(
  item: KindItem,
  settings: PluginSettings,
  partIndex?: number,
): PlayableSource[] {
  const hints = item.hints;
  if (!hints) return [];

  // Multi-part direct audiobook (e.g. LibriVox ordered chapter MP3s):
  // prefer inline hints.partUrls (tests), then KV store, then live LibriVox hydration.
  let partUrls =
    Array.isArray(hints.partUrls) && hints.partUrls.length > 0
      ? hints.partUrls
      : loadPartUrls(item.id);
  if (
    (!partUrls || partUrls.length === 0) &&
    hints.source === "librivox" &&
    item.id.startsWith("lv-")
  ) {
    const fresh = fetchLibriVoxById(item.id, settings);
    if (fresh?.partUrls && fresh.partUrls.length > 0) {
      partUrls = fresh.partUrls;
    }
  }

  if (Array.isArray(partUrls) && partUrls.length > 0) {
    const idx =
      partIndex !== undefined ? Math.max(0, Math.min(partIndex, partUrls.length - 1)) : 0;
    const url = partUrls[idx];
    const partMeta = hints.parts?.[idx];
    if (url) {
      return [
        {
          id: `direct-${item.id}-part-${idx}`,
          label: partMeta?.name || `Part ${idx + 1}`,
          pattern: "range",
          mime: partMeta?.mime || "audio/mpeg",
          size: partMeta?.size,
          durationSec: partMeta?.durationSec,
          url,
        },
      ];
    }
  }

  // Direct ebook/audiobook files (e.g. Standard Ebooks / Project Gutenberg EPUBs)
  if (Array.isArray(hints.directSources) && hints.directSources.length > 0) {
    const isAudio = hints.kind === "audiobooks" || item.level === "audiobook";
    return hints.directSources
      .filter((s) => s.url)
      .map((s, i) => ({
        id: `direct-${item.id}-${i}`,
        label: s.label || `${s.format.toUpperCase()} edition`,
        pattern: isAudio ? "range" : "download",
        mime: s.mime,
        size: s.size,
        durationSec: s.durationSec,
        url: s.url,
      }));
  }

  return [];
}

function safeResolveSources(query: Parameters<typeof ether.sources.resolve>[0]): SourceCandidate[] {
  try {
    const resp = ether.sources.resolve(query);
    return Array.isArray(resp?.candidates) ? resp.candidates : [];
  } catch (err) {
    rethrowIfHostFault(err);
    ether.log(`sources.resolve(${query.kind}) failed: ${String(err)}`);
    return [];
  }
}

function inspectCandidateToPlayable(
  item: KindItem,
  cand: SourceCandidate,
  rankIndex: number,
  partIndex: number | undefined,
  filesOverride?: ReleaseFile[],
): PlayableSource | null {
  const meta = extractTargetMeta(item);
  const files = filesOverride ?? cand.files ?? [];
  const selected = files.length > 0 ? selectReleaseFiles(item, files, partIndex) : null;

  // If release_files returned a real file list with NO matching book/audio file (and not an archive), skip this candidate!
  if (files.length > 0 && !selected) {
    return null;
  }

  const fallbackMime =
    meta.kind === "audiobooks"
      ? /\bmp3\b/i.test(cand.title || "")
        ? "audio/mpeg"
        : "audio/mp4"
      : /\bpdf\b/i.test(cand.title || "")
        ? "application/pdf"
        : /\bcbz\b/i.test(cand.title || "")
          ? "application/vnd.comicbook+zip"
          : "application/epub+zip";

  const fallbackExt =
    meta.kind === "audiobooks"
      ? fallbackMime === "audio/mpeg"
        ? ".mp3"
        : ".m4b"
      : fallbackMime === "application/pdf"
        ? ".pdf"
        : fallbackMime === "application/vnd.comicbook+zip"
          ? ".cbz"
          : ".epub";

  const labelParts: string[] = [];
  if (selected?.format) labelParts.push(selected.format.toUpperCase());
  else labelParts.push(fallbackExt.slice(1).toUpperCase());
  if (cand.cached) labelParts.push("Cached");
  else if (cand.nzbUrl) labelParts.push("Usenet");
  if (cand.indexer) labelParts.push(cand.indexer);

  const release: PlayableSource["release"] = {
    candidate: cand,
    infoHash: cand.infoHash,
    magnet: cand.magnet,
    nzbUrl: cand.nzbUrl,
  };

  if (selected?.file) {
    release.file = selected.file.path;
    release.fileIndex = selected.file.index;
  } else if (selected?.fileHint) {
    release.fileHint = selected.fileHint;
  }
  // Per W186 #659: never guess a filename for fileHint when release_files hasn't yielded an exact
  // member path; omit fileHint and let Ether select the best member matching source.mime.

  const refHash = fnv1aHex(candidateRefOf(cand, rankIndex));
  const resolvedMime =
    selected?.isArchive && meta.kind === "audiobooks"
      ? /\bmp3\b/i.test(cand.title || "") && !/\bm4[ab]\b/i.test(cand.title || "")
        ? "audio/mpeg"
        : selected.mime
      : selected?.mime || fallbackMime;
  return {
    id: `rel-${item.id}-${rankIndex}-${refHash}`,
    label: labelParts.join(" · "),
    pattern: "release",
    mime: resolvedMime,
    size: selected?.file?.size || cand.size,
    durationSec: meta.kind === "audiobooks" ? meta.durationSec : undefined,
    release,
  };
}

function dedupeCandidates(list: SourceCandidate[]): SourceCandidate[] {
  const seen = new Set<string>();
  const out: SourceCandidate[] = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const key = candidateRefOf(c, i);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export function resolveKindItem(
  req: KindResolveRequest,
  settings: PluginSettings,
): KindResolveResponse {
  const item = req.item;
  if (!item || !item.id) {
    return { sources: [] };
  }

  // 1. Direct public-domain sources resolve instantaneously.
  const direct = resolveDirectSources(item, settings, req.partIndex);
  if (direct.length > 0) {
    return { sources: direct, ttlSec: 6 * 3600 };
  }

  // 2. Check prepared cache (populated by /ether/job/prepare or previous resolve).
  // Re-validate cached Usenet-only sources against usenet_check so any recorded
  // playback failure (playbackFailed: true) drops dead NZBs immediately.
  const usenetState: UsenetCheckState = { used: 0, disabled: false };
  const cacheKey = preparedCacheKey(item, req.partIndex);
  const cached = loadPreparedSources<PlayableSource[]>(cacheKey);
  if (cached && cached.length > 0) {
    let droppedAny = false;
    const alive: PlayableSource[] = [];
    for (const src of cached) {
      const rel = src.release;
      // A pick made by an older matcher is checked again: a release the
      // current rules reject (another series, another volume) is dropped.
      const relTitle = rel?.candidate?.title;
      if (relTitle && scoreFor(item, { ...rel.candidate, title: relTitle }, settings).rejected) {
        droppedAny = true;
        continue;
      }
      if (rel?.nzbUrl && !rel.infoHash && !rel.magnet) {
        const probeCand: SourceCandidate = rel.candidate
          ? { ...rel.candidate, nzbUrl: rel.candidate.nzbUrl || rel.nzbUrl }
          : { nzbUrl: rel.nzbUrl, title: src.label };
        if (!isUsenetCandidateAlive(probeCand, usenetState)) {
          droppedAny = true;
          continue;
        }
      }
      alive.push(src);
    }
    if (alive.length > 0) {
      if (droppedAny) {
        storePreparedSources(cacheKey, alive, 1800);
      }
      return { sources: alive, ttlSec: 1800 };
    }
    // All cached sources were dead Usenet posts; fall through to fresh resolution.
  }

  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const meta = extractTargetMeta(item);
  const category = searchCategory(item, meta.kind, settings);
  const queries = queriesFor(item);

  // 3. Search configured Ether indexers (stay tight within the 5s /resolve deadline)
  let allCandidates: SourceCandidate[] = [];
  // Later queries run until enough candidates the matcher accepts were found:
  // a first query full of rejects (another series' volume of the same number)
  // must not stop the search before the form the right release uses.
  let acceptable = 0;
  for (let qi = 0; qi < queries.length; qi++) {
    if (qi > 0 && (acceptable >= 3 || elapsed() > 1100)) break;
    const found = safeResolveSources({
      kind: "indexer_search",
      query: queries[qi],
      category,
    });
    if (found.length > 0) {
      allCandidates.push(...found);
      acceptable += found.filter((c) => !scoreFor(item, c, settings).rejected).length;
    }
  }
  allCandidates = dedupeCandidates(allCandidates);

  if (allCandidates.length === 0) {
    return { sources: [], ttlSec: 120 };
  }

  // 4. Debrid cache check on torrent infoHashes if within budget
  const hashes = allCandidates
    .map((c) => c.infoHash?.toLowerCase())
    .filter((h): h is string => Boolean(h))
    .slice(0, 40);

  if (hashes.length > 0 && elapsed() < 1800) {
    const checked = safeResolveSources({
      kind: "debrid_check",
      infoHashes: hashes,
    });
    const cachedSet = new Set(
      checked.filter((c) => c.cached && c.infoHash).map((c) => c.infoHash!.toLowerCase()),
    );
    for (const c of allCandidates) {
      if (c.infoHash && cachedSet.has(c.infoHash.toLowerCase())) {
        c.cached = true;
      }
    }
  }

  // 5. Score & rank candidates
  const scored = allCandidates
    .map((cand) => ({ cand, eval: scoreFor(item, cand, settings) }))
    .filter((x) => !x.eval.rejected)
    .sort((a, b) => b.eval.score - a.eval.score);

  if (scored.length === 0) {
    return { sources: [], ttlSec: 180 };
  }

  // 6. Verify Usenet article availability (#665) and inspect release_files on top
  // candidates within the 5s /resolve deadline. If time is tight before finishing
  // inspection, hand off cleanly to /ether/job/prepare.
  const top = scored.slice(0, 8).map((s) => s.cand);
  const sources: PlayableSource[] = [];

  for (let i = 0; i < top.length && sources.length < 3; i++) {
    const cand = top[i];
    const canInspect = Boolean(cand.cached || cand.nzbUrl || cand.infoHash || cand.magnet);
    const hasInlineFiles = Array.isArray(cand.files) && cand.files.length > 0;
    const needsUsenetCheck = isUsenetOnlyCandidate(cand) && !usenetState.disabled && usenetState.used < MAX_USENET_CHECKS;

    // Never emit a guessed filename when release_files hasn't run yet and budget is tight;
    // hand off cleanly to /ether/job/prepare so usenet_check + exact file/fileIndex complete.
    if (
      elapsed() > SOFT_RESOLVE_BUDGET_MS ||
      ((canInspect && !hasInlineFiles || needsUsenetCheck) && elapsed() > SOFT_RESOLVE_BUDGET_MS - 300)
    ) {
      if (sources.length === 0) {
        const jobInput: PreparedJobInput = {
          item,
          partIndex: req.partIndex,
          candidates: scored.slice(0, 10).map((s) => s.cand),
        };
        storePreparedSources(pendingJobKey(item, req.partIndex), jobInput, 600);
        return {
          pending: true,
          retryInMs: 1000,
          job: "/ether/job/prepare",
          sources: [],
        };
      }
      break;
    }

    // Drop dead / previously playback-failed Usenet posts before inspecting or offering them.
    if (needsUsenetCheck && !isUsenetCandidateAlive(cand, usenetState)) {
      continue;
    }

    let inspectedFiles: ReleaseFile[] | undefined = hasInlineFiles ? cand.files : undefined;
    if (canInspect && !hasInlineFiles) {
      const rf = safeResolveSources({
        kind: "release_files",
        infoHash: cand.infoHash,
        magnet: cand.magnet,
        candidate: cand,
      });
      if (rf.length > 0 && Array.isArray(rf[0].files) && rf[0].files.length > 0) {
        inspectedFiles = rf[0].files;
      }
    }

    const playable = inspectCandidateToPlayable(item, cand, i, req.partIndex, inspectedFiles);
    if (playable) {
      sources.push(playable);
    }
  }

  if (sources.length > 0) {
    storePreparedSources(cacheKey, sources, 1800);
  }
  return { sources, ttlSec: 1800 };
}

export function runPrepareJob(
  body: Record<string, unknown>,
  settings: PluginSettings,
): { ok: boolean; prepared: number } {
  const item = body.item as KindItem | undefined;
  const partIndex = typeof body.partIndex === "number" ? body.partIndex : undefined;

  let jobInput: PreparedJobInput | null = null;
  if (item?.id) {
    jobInput = loadPreparedSources<PreparedJobInput>(pendingJobKey(item, partIndex));
  }
  if (!jobInput && item?.id) {
    // Run full indexer search + file inspection inside the generous job budget
    const meta = extractTargetMeta(item);
    const category = searchCategory(item, meta.kind, settings);
    const found: SourceCandidate[] = [];
    for (const q of queriesFor(item)) {
      found.push(...safeResolveSources({ kind: "indexer_search", query: q, category }));
    }
    const deduped = dedupeCandidates(found);
    const scored = deduped
      .map((cand) => ({ cand, eval: scoreFor(item, cand, settings) }))
      .filter((x) => !x.eval.rejected)
      .sort((a, b) => b.eval.score - a.eval.score)
      .slice(0, 8)
      .map((x) => x.cand);
    jobInput = { item, partIndex, candidates: scored };
  }

  if (!jobInput || !jobInput.item?.id) {
    return { ok: true, prepared: 0 };
  }

  const usenetState: UsenetCheckState = { used: 0, disabled: false };
  const sources: PlayableSource[] = [];
  for (let i = 0; i < jobInput.candidates.length && sources.length < 5; i++) {
    const cand = jobInput.candidates[i];
    if (isUsenetOnlyCandidate(cand) && !isUsenetCandidateAlive(cand, usenetState)) {
      continue;
    }
    const rf = safeResolveSources({
      kind: "release_files",
      infoHash: cand.infoHash,
      magnet: cand.magnet,
      candidate: cand,
    });
    const files = rf.length > 0 && Array.isArray(rf[0].files) ? rf[0].files : undefined;
    const playable = inspectCandidateToPlayable(
      jobInput.item,
      cand,
      i,
      jobInput.partIndex,
      files,
    );
    if (playable) sources.push(playable);
  }

  storePreparedSources(preparedCacheKey(jobInput.item, jobInput.partIndex), sources, 1800);
  return { ok: true, prepared: sources.length };
}

export function matchKindCandidates(
  req: KindMatchRequest,
  settings: PluginSettings,
): KindMatchResponse {
  const item = req.item;
  const candidates = Array.isArray(req.candidates) ? req.candidates : [];
  if (!item || candidates.length === 0) {
    return { matches: [] };
  }

  const matches = candidates.map((cand, idx) => {
    const res = scoreFor(item, cand, settings);
    return {
      candidateRef: candidateRefOf(cand, idx),
      score: res.rejected ? 0 : res.score,
      reasons: res.reasons,
    };
  });

  matches.sort((a, b) => b.score - a.score);
  return { matches };
}
