// Comprehensive offline unit + mock-host integration test suite for ether.books.
// Run via: node --experimental-strip-types --test tests/plugin.test.ts (or compiled via esbuild)

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  buildSearchQueries,
  extractTargetMeta,
  isAbridgedReleaseName,
  scoreCandidate,
  selectReleaseFiles,
} from "../src/matching.ts";
import { parseStandardEbooksAtom } from "../src/providers/standardebooks.ts";
import {
  canonicalizeGenres,
  durationLengthBucket,
  parseSeriesPosition,
  stableExternalId,
} from "../src/text.ts";
import {
  canonicalizeSeriesName,
  canonicalWorkTitle,
  isAudioOrDramatizedForBooks,
  isNonBookProduct,
  isSplitPartEdition,
} from "../src/hygiene.ts";
import { entryToKindItem, mergeEntries, reconcileStoredCatalog } from "../src/curated.ts";
import { handle } from "../src/plugin.ts";
import { comicsMatch, comicsScore } from "../src/comics.ts";
import { storePreparedSources } from "../src/cache.ts";
import type {
  EtherHttpRequest,
  EtherHttpResponse,
  KindItem,
  NormalizedEntry,
  SourceCandidate,
  SourceQuery,
} from "../src/types.ts";

interface MockHostState {
  kv: Map<string, string>;
  settings: Record<string, unknown>;
  secrets: Record<string, string>;
  httpHandler: (req: EtherHttpRequest) => EtherHttpResponse;
  sourcesHandler: (q: SourceQuery) => SourceCandidate[];
  storedItems: Record<string, KindItem[]>;
  logs: string[];
}

function installMockHost(overrides?: Partial<MockHostState>): MockHostState {
  const state: MockHostState = {
    kv: new Map<string, string>(),
    settings: {},
    secrets: {},
    httpHandler: () => ({ status: 404, body: "" }),
    sourcesHandler: () => [],
    storedItems: {},
    logs: [],
    ...overrides,
  };

  (globalThis as unknown as Record<string, unknown>).ether = {
    log: (...args: unknown[]) => state.logs.push(args.map(String).join(" ")),
    abort: (msg?: string) => {
      throw new Error(`__ETHER_FAULT__${JSON.stringify({ code: "aborted", message: msg || "aborted" })}`);
    },
    runtime: { limits: () => ({}) },
    kv: {
      get: (k: string) => state.kv.get(k) ?? null,
      put: (k: string, v: string) => {
        state.kv.set(k, v);
      },
      delete: (k: string) => {
        state.kv.delete(k);
      },
      list: (prefix = "") => Array.from(state.kv.keys()).filter((k) => k.startsWith(prefix)).sort(),
      usage: () => ({
        bytes: 1024,
        keys: state.kv.size,
        quotaBytes: 10 * 1024 * 1024,
        quotaKeys: 10000,
      }),
    },
    settings: { get: () => state.settings },
    secret: { get: (name: string) => state.secrets[name] ?? null },
    http: { fetch: (req: EtherHttpRequest) => state.httpHandler(req) },
    sources: {
      resolve: (q: SourceQuery) => ({ candidates: state.sourcesHandler(q) }),
    },
    kinds: {
      upsert: () => ({ accepted: 0 }),
      delete: () => undefined,
      items: (kind: string) => ({ items: state.storedItems[kind] || [] }),
    },
  };

  return state;
}

describe("text & metadata normalization", () => {
  it("parses integer index and display series_number cleanly", () => {
    assert.deepEqual(parseSeriesPosition("1"), { index: 1, display: "1" });
    assert.deepEqual(parseSeriesPosition("2.5"), { index: 2, display: "2.5" });
    assert.deepEqual(parseSeriesPosition("Book 4"), { index: 4, display: "4" });
    assert.deepEqual(parseSeriesPosition(3), { index: 3, display: "3" });
  });

  it("buckets audiobook durations accurately", () => {
    assert.equal(durationLengthBucket(4 * 3600), "Under 6 hours");
    assert.equal(durationLengthBucket(8 * 3600), "6 to 12 hours");
    assert.equal(durationLengthBucket(16 * 3600), "12 to 20 hours");
    assert.equal(durationLengthBucket(26 * 3600), "Over 20 hours");
  });

  it("canonicalizes noisy genres into clean curated taxonomy and keeps fiction out of non-fiction", () => {
    const fiction = canonicalizeGenres([
      "Space Opera",
      "Cyberpunk",
      "Epic Fantasy",
      "Detective fiction",
      "Memoirs",
    ]);
    assert.deepEqual(fiction, [
      "Science fiction",
      "Fantasy",
      "Mystery and thriller",
    ]);
    const nonFiction = canonicalizeGenres(["Memoirs", "Ancient history", "Essays"]);
    assert.deepEqual(nonFiction, [
      "Biography and memoir",
      "History",
      "Non-fiction",
    ]);
  });

  it("produces valid Ether external IDs with no colons or slashes", () => {
    const id = stableExternalId("ol", "works/OL893415W:edition/1");
    assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/);
  });
});

describe("Standard Ebooks Atom parser", () => {
  it("extracts EPUB enclosure, cover artwork, authors, and genres", () => {
    const sampleXml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <entry>
    <id>https://standardebooks.org/ebooks/mary-shelley/frankenstein</id>
    <title>Frankenstein</title>
    <author><name>Mary Shelley</name></author>
    <published>2025-05-01T00:00:00Z</published>
    <dc:language>en-GB</dc:language>
    <summary>A gothic science fiction classic.</summary>
    <category term="science-fiction" label="Science Fiction"/>
    <category term="horror" label="Horror"/>
    <link rel="http://opds-spec.org/image" href="https://standardebooks.org/images/covers/mary-shelley_frankenstein.jpg" type="image/jpeg"/>
    <link rel="http://opds-spec.org/acquisition" href="https://standardebooks.org/ebooks/mary-shelley/frankenstein/downloads/mary-shelley_frankenstein.epub" type="application/epub+zip"/>
  </entry>
</feed>`;
    const entries = parseStandardEbooksAtom(sampleXml);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].title, "Frankenstein");
    assert.equal(entries[0].authors[0].name, "Mary Shelley");
    assert.equal(entries[0].directSources?.[0].format, "epub");
    assert.equal(entries[0].directSources?.[0].mime, "application/epub+zip");
    assert.ok(entries[0].genres.includes("Science fiction"));
    assert.ok(entries[0].genres.includes("Horror"));
    assert.ok(entries[0].curated.includes("Free classics"));
  });
});

describe("matching & release file selection", () => {
  const duneBook: KindItem = entryToKindItem({
    kind: "books",
    source: "openlibrary",
    sourceId: "ol-OL893415W",
    title: "Dune",
    year: 1965,
    authors: [{ name: "Frank Herbert", role: "Author" }],
    series: "Dune",
    seriesIndex: 1,
    seriesNumber: "1",
    genres: ["Science fiction"],
    curated: ["Series to start"],
    isbn: "9780441172719",
    isbn13: "9780441172719",
    format: "epub",
  });

  const hailMaryAudio: KindItem = entryToKindItem({
    kind: "audiobooks",
    source: "audible",
    sourceId: "aud-B08G9PRS1K",
    title: "Project Hail Mary",
    year: 2021,
    authors: [{ name: "Andy Weir", role: "Author" }],
    narrators: [{ name: "Ray Porter", role: "Narrator" }],
    genres: ["Science fiction"],
    curated: ["Popular this week"],
    asin: "B08G9PRS1K",
    durationSec: 58200, // 16h 10m
    unabridged: true,
    format: "m4b",
  });

  it("detects abridged vs unabridged accurately", () => {
    assert.equal(isAbridgedReleaseName("Dune (Abridged) MP3"), true);
    assert.equal(isAbridgedReleaseName("Dune [Unabridged] M4B"), false);
    assert.equal(isAbridgedReleaseName("Dune.Abridged.Edition.MP3"), true);
  });

  it("hard-rejects abridged releases when unabridged is requested", () => {
    const res = scoreCandidate(hailMaryAudio, {
      title: "Andy Weir - Project Hail Mary (Abridged) MP3",
      size: 200_000_000,
    });
    assert.equal(res.rejected, true);
    assert.ok(res.reasons.some((r) => r.includes("abridged")));
  });

  it("rejects study guides and summaries", () => {
    const res = scoreCandidate(duneBook, {
      title: "Study Guide and Summary of Dune by Frank Herbert EPUB",
      size: 250_000,
    });
    assert.equal(res.rejected, true);
  });

  it("penalizes wrong sequel titles like Dune Messiah for Dune", () => {
    const exact = scoreCandidate(duneBook, {
      title: "Frank Herbert - Dune (1965) Retail EPUB",
      size: 2_500_000,
      cached: true,
    });
    const sequel = scoreCandidate(duneBook, {
      title: "Frank Herbert - Dune Messiah (1969) Retail EPUB",
      size: 2_400_000,
      cached: true,
    });
    assert.ok(exact.score > sequel.score + 0.25, `expected exact (${exact.score}) >> sequel (${sequel.score})`);
  });

  it("rewards narrator match + M4B + runtime-consistent size on audiobooks", () => {
    const good = scoreCandidate(hailMaryAudio, {
      title: "Andy Weir - Project Hail Mary (Unabridged) [Ray Porter] M4B",
      size: 480_000_000,
      cached: true,
    });
    const tiny = scoreCandidate(hailMaryAudio, {
      title: "Andy Weir - Project Hail Mary MP3",
      size: 12_000_000, // ~1.6 kbps -> bogus sample/corrupt
    });
    assert.equal(good.rejected, false);
    assert.ok(good.score >= 0.85, `expected high score, got ${good.score}`);
    assert.ok(good.score > tiny.score + 0.3);
  });

  it("selects matching EPUB inside an author anthology pack with exact file & fileIndex", () => {
    const sel = selectReleaseFiles(duneBook, [
      { index: 0, path: "Frank Herbert Pack/cover.jpg", size: 80_000 },
      { index: 1, path: "Frank Herbert Pack/Dune Messiah.epub", size: 1_900_000 },
      { index: 2, path: "Frank Herbert Pack/Dune.pdf", size: 8_000_000 },
      { index: 3, path: "Frank Herbert Pack/Dune.epub", size: 2_200_000 },
    ]);
    assert.ok(sel);
    assert.equal(sel.file?.index, 3);
    assert.equal(sel.file?.path, "Frank Herbert Pack/Dune.epub");
    assert.equal(sel.mime, "application/epub+zip");
  });

  it("selects ordered MP3 chapters by natural numeric order and honors partIndex", () => {
    const files = [
      { index: 0, path: "Book/Chapter 10.mp3", size: 15_000_000 },
      { index: 1, path: "Book/Chapter 2.mp3", size: 14_000_000 },
      { index: 2, path: "Book/Chapter 1.mp3", size: 13_000_000 },
      { index: 3, path: "Book/cover.jpg", size: 90_000 },
    ];
    const p0 = selectReleaseFiles(hailMaryAudio, files, 0);
    const p1 = selectReleaseFiles(hailMaryAudio, files, 1);
    const p2 = selectReleaseFiles(hailMaryAudio, files, 2);
    assert.equal(p0?.file?.path, "Book/Chapter 1.mp3");
    assert.equal(p0?.file?.index, 2);
    assert.equal(p1?.file?.path, "Book/Chapter 2.mp3");
    assert.equal(p1?.file?.index, 1);
    assert.equal(p2?.file?.path, "Book/Chapter 10.mp3");
    assert.equal(p2?.file?.index, 0);
  });

  it("omits guessed fileHint and sets accurate mime for archive-wrapped Usenet releases (W186 #659)", () => {
    const sel = selectReleaseFiles(duneBook, [
      { index: 0, path: "Frank.Herbert.Dune.part1.rar", size: 1_500_000 },
      { index: 1, path: "Frank.Herbert.Dune.par2", size: 50_000 },
    ]);
    assert.ok(sel);
    assert.equal(sel.isArchive, true);
    assert.equal(sel.fileHint, undefined);
    assert.equal(sel.mime, "application/epub+zip");

    const audioSel = selectReleaseFiles(hailMaryAudio, [
      { index: 0, path: "Andy.Weir.Project.Hail.Mary.MP3.part1.rar", size: 50_000_000 },
    ]);
    assert.ok(audioSel);
    assert.equal(audioSel.isArchive, true);
    assert.equal(audioSel.fileHint, undefined);
    assert.equal(audioSel.mime, "audio/mpeg");
  });

  it("builds concise prioritized search queries including ISBN/ASIN", () => {
    const qBook = buildSearchQueries(duneBook);
    assert.deepEqual(qBook, ["Dune herbert", "9780441172719", "Dune"]);
    const qAudio = buildSearchQueries(hailMaryAudio);
    assert.deepEqual(qAudio, ["Project Hail Mary weir", "B08G9PRS1K", "Project Hail Mary"]);
  });
});

describe("mergeEntries deduplication", () => {
  it("keeps direct public-domain source while preserving awards & curated shelves", () => {
    const ol: NormalizedEntry = {
      kind: "books",
      source: "openlibrary",
      sourceId: "ol-OL1W",
      title: "Frankenstein",
      authors: [{ name: "Mary Shelley", role: "Author", thumb: "https://covers.openlibrary.org/a/olid/OL1A-M.jpg" }],
      genres: ["Science fiction"],
      awards: ["Classic Hall of Fame"],
      curated: ["Popular this week"],
      coverUrl: "https://covers.openlibrary.org/b/id/1-L.jpg",
    };
    const se: NormalizedEntry = {
      kind: "books",
      source: "standard-ebooks",
      sourceId: "se-mary-shelley-frankenstein",
      title: "Frankenstein",
      authors: [{ name: "Mary Shelley", role: "Author" }],
      genres: ["Classics", "Horror"],
      curated: ["Free classics"],
      directSources: [
        { url: "https://standardebooks.org/frankenstein.epub", mime: "application/epub+zip", format: "epub" },
      ],
    };
    const merged = mergeEntries([ol, se]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].source, "standard-ebooks");
    assert.equal(merged[0].directSources?.length, 1);
    assert.ok(merged[0].curated.includes("Popular this week"));
    assert.ok(merged[0].curated.includes("Free classics"));
    assert.ok(merged[0].awards?.includes("Classic Hall of Fame"));
    assert.equal(merged[0].authors[0].thumb, "https://covers.openlibrary.org/a/olid/OL1A-M.jpg");
  });
});

describe("end-to-end plugin routes with mock host", () => {
  beforeEach(() => {
    installMockHost();
  });

  it("resolves indexer + debrid_check + release_files with explicit file & fileIndex", () => {
    const queriesSeen: string[] = [];
    installMockHost({
      sourcesHandler: (q) => {
        queriesSeen.push(q.kind);
        if (q.kind === "indexer_search") {
          return [
            {
              infoHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
              title: "Frank Herbert - Dune (1965) EPUB",
              size: 2_400_000,
              indexer: "MockIndex",
            },
          ];
        }
        if (q.kind === "debrid_check") {
          return [{ infoHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", cached: true }];
        }
        if (q.kind === "release_files") {
          return [
            {
              infoHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
              cached: true,
              files: [
                { index: 0, path: "Dune/cover.jpg", size: 100_000 },
                { index: 1, path: "Dune/Frank Herbert - Dune.epub", size: 2_300_000 },
              ],
            },
          ];
        }
        return [];
      },
    });

    const resp = handle({
      method: "POST",
      path: "/ether/v1/kinds/books/resolve",
      body: JSON.stringify({
        item: {
          id: "ol-OL893415W",
          level: "book",
          title: "Dune",
          year: 1965,
          playable: true,
          fields: { authors: [{ name: "Frank Herbert", role: "Author" }] },
          hints: {
            kind: "books",
            source: "openlibrary",
            sourceId: "ol-OL893415W",
            title: "Dune",
            authors: ["Frank Herbert"],
          },
        },
      }),
    });

    assert.equal(resp.status, 200);
    const parsed = (typeof resp.body === "string" ? JSON.parse(resp.body) : resp.body) as {
      sources: Array<{ pattern: string; mime: string; release: { file: string; fileIndex: number } }>;
    };
    assert.equal(parsed.sources.length, 1);
    assert.equal(parsed.sources[0].pattern, "release");
    assert.equal(parsed.sources[0].mime, "application/epub+zip");
    assert.equal(parsed.sources[0].release.file, "Dune/Frank Herbert - Dune.epub");
    assert.equal(parsed.sources[0].release.fileIndex, 1);
    assert.ok(queriesSeen.includes("indexer_search"));
    assert.ok(queriesSeen.includes("debrid_check"));
    assert.ok(queriesSeen.includes("release_files"));
  });

  it("propagates __ETHER_FAULT__ check_dependency errors without swallowing them", () => {
    installMockHost({
      httpHandler: () => {
        const err = new Error('__ETHER_FAULT__{"code":"check_dependency","message":"needs live test"}') as Error & {
          code?: string;
        };
        err.code = "check_dependency";
        throw err;
      },
    });

    assert.throws(
      () =>
        handle({
          method: "POST",
          path: "/ether/v1/kinds/books/browse",
          body: JSON.stringify({ limit: 10 }),
        }),
      /check_dependency/,
    );
  });

  it("keeps hints strictly under 16 KiB for 180-chapter audiobooks and resolves partIndex via KV", () => {
    installMockHost();
    const parts = Array.from({ length: 180 }, (_, i) => ({
      name: `Chapter ${i + 1}: A Very Long Chapter Subtitle About The Count of Monte Cristo`,
      mime: "audio/mpeg",
      durationSec: 600 + i,
    }));
    const partUrls = Array.from(
      { length: 180 },
      (_, i) => `https://archive.org/download/count_monte_cristo_librivox/ch_${String(i + 1).padStart(3, "0")}.mp3`,
    );
    const item = entryToKindItem({
      kind: "audiobooks",
      source: "librivox",
      sourceId: "lv-47",
      title: "The Count of Monte Cristo",
      authors: [{ name: "Alexandre Dumas", role: "Author" }],
      narrators: [{ name: "David Clarke", role: "Narrator" }],
      genres: ["Classics"],
      curated: ["Free classics"],
      durationSec: 180 * 650,
      unabridged: true,
      format: "mp3",
      parts,
      partUrls,
    });
    const hintsBytes = JSON.stringify(item.hints).length;
    assert.ok(hintsBytes < 16_384, `expected hints < 16384 bytes, got ${hintsBytes}`);

    const resp = handle({
      method: "POST",
      path: "/ether/v1/kinds/audiobooks/resolve",
      body: JSON.stringify({ item, partIndex: 120 }),
    });
    assert.equal(resp.status, 200);
    const body = resp.body as { sources: Array<{ url: string; pattern: string; mime: string }> };
    assert.equal(body.sources.length, 1);
    assert.equal(
      body.sources[0].url,
      "https://archive.org/download/count_monte_cristo_librivox/ch_121.mp3",
    );
    assert.equal(body.sources[0].pattern, "range");
    assert.equal(body.sources[0].mime, "audio/mpeg");
  });

  it("supports /changes without deleting live-searched or expanded items", () => {
    const r1 = handle({
      method: "POST",
      path: "/ether/v1/kinds/books/changes",
      body: JSON.stringify({ cursor: "", limit: 100 }),
    });
    const b1 = (typeof r1.body === "string" ? JSON.parse(r1.body) : r1.body) as {
      complete: boolean;
      deletes: string[];
      nextCursor: string;
    };
    assert.equal(b1.complete, true);
    assert.deepEqual(b1.deletes, []);
    assert.match(b1.nextCursor, /^v\d+:\d+$/);

    // Steady-state call with fresh cursor returns empty upserts & deletes
    const r2 = handle({
      method: "POST",
      path: "/ether/v1/kinds/books/changes",
      body: JSON.stringify({ cursor: b1.nextCursor, limit: 100 }),
    });
    const b2 = (typeof r2.body === "string" ? JSON.parse(r2.body) : r2.body) as {
      complete: boolean;
      upserts: unknown[];
      deletes: string[];
    };
    assert.equal(b2.complete, true);
    assert.deepEqual(b2.upserts, []);
    assert.deepEqual(b2.deletes, []);
  });

  it("drops dead and playbackFailed Usenet posts via usenet_check (#665) before release_files", () => {
    const inspected: string[] = [];
    const checked: string[] = [];
    installMockHost({
      sourcesHandler: (q) => {
        if (q.kind === "indexer_search") {
          return [
            {
              nzbUrl: "https://nzb.example/dead-scene.nzb",
              title: "Andy Weir - Project Hail Mary - Ray Porter Unabridged M4B",
              size: 460_000_000,
              indexer: "NZBGeek",
            },
            {
              nzbUrl: "https://nzb.example/playback-failed.nzb",
              title: "Andy Weir - Project Hail Mary - Ray Porter Unabridged M4B REPACK",
              size: 465_000_000,
              indexer: "NZBPlanet",
            },
            {
              nzbUrl: "https://nzb.example/live-usenet.nzb",
              title: "Andy Weir - Project Hail Mary - Ray Porter Unabridged MP3",
              size: 450_000_000,
              indexer: "DrunkenSlug",
            },
          ];
        }
        if (q.kind === "usenet_check") {
          const url = q.nzbUrl || q.candidate?.nzbUrl || "";
          checked.push(url);
          if (url.includes("dead-scene")) {
            return [{ nzbUrl: url, usenetCheck: { available: false, checked: 16, missing: 16, reason: "articles_missing" } }];
          }
          if (url.includes("playback-failed")) {
            return [{ nzbUrl: url, usenetCheck: { available: false, checked: 0, missing: 0, cached: true, playbackFailed: true, reason: "playback_article_missing" } }];
          }
          return [{ nzbUrl: url, usenetCheck: { available: true, checked: 16, missing: 0 } }];
        }
        if (q.kind === "release_files") {
          const url = q.candidate?.nzbUrl || "";
          inspected.push(url);
          return [
            {
              nzbUrl: url,
              files: [{ index: 0, path: "Project Hail Mary.mp3", size: 450_000_000 }],
            },
          ];
        }
        return [];
      },
    });

    const resp = handle({
      method: "POST",
      path: "/ether/v1/kinds/audiobooks/resolve",
      body: JSON.stringify({
        item: {
          id: "aud-B08G9PRS1K",
          level: "audiobook",
          title: "Project Hail Mary",
          year: 2021,
          playable: true,
          fields: {
            authors: [{ name: "Andy Weir", role: "Author" }],
            narrators: [{ name: "Ray Porter", role: "Narrator" }],
          },
          hints: {
            kind: "audiobooks",
            source: "audible",
            sourceId: "aud-B08G9PRS1K",
            title: "Project Hail Mary",
            authors: ["Andy Weir"],
            narrators: ["Ray Porter"],
            durationSec: 58_200,
            unabridged: true,
          },
        },
      }),
    });

    assert.equal(resp.status, 200);
    const body = resp.body as { sources: Array<{ release: { nzbUrl?: string; file?: string } }> };
    assert.equal(body.sources.length, 1);
    assert.equal(body.sources[0].release.nzbUrl, "https://nzb.example/live-usenet.nzb");
    assert.equal(body.sources[0].release.file, "Project Hail Mary.mp3");
    assert.equal(checked.length, 3);
    assert.deepEqual(inspected, ["https://nzb.example/live-usenet.nzb"]);
  });

  it("evicts a previously cached Usenet source when a later usenet_check reports playbackFailed", () => {
    let failFirst = false;
    installMockHost({
      sourcesHandler: (q) => {
        if (q.kind === "indexer_search") {
          return [
            {
              nzbUrl: "https://nzb.example/flaky.nzb",
              title: "Frank Herbert - Dune (1965) EPUB",
              size: 2_100_000,
              indexer: "NZBGeek",
            },
            {
              infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              title: "Frank Herbert - Dune (1965) EPUB Retail",
              size: 2_000_000,
              indexer: "MockTorrent",
            },
          ];
        }
        if (q.kind === "debrid_check") {
          return [{ infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", cached: false }];
        }
        if (q.kind === "usenet_check") {
          return [
            {
              nzbUrl: "https://nzb.example/flaky.nzb",
              usenetCheck: failFirst
                ? { available: false, checked: 0, missing: 0, cached: true, playbackFailed: true, reason: "playback_article_corrupt" }
                : { available: true, checked: 8, missing: 0 },
            },
          ];
        }
        if (q.kind === "release_files") {
          if (q.candidate?.nzbUrl) {
            return [{ nzbUrl: q.candidate.nzbUrl, files: [{ index: 0, path: "Dune.epub", size: 2_100_000 }] }];
          }
          return [{ infoHash: q.infoHash, files: [{ index: 0, path: "Dune-Retail.epub", size: 2_000_000 }] }];
        }
        return [];
      },
    });

    const item = {
      id: "ol-OL893415W",
      level: "book",
      title: "Dune",
      year: 1965,
      playable: true,
      fields: { authors: [{ name: "Frank Herbert", role: "Author" }] },
      hints: {
        kind: "books",
        source: "openlibrary",
        sourceId: "ol-OL893415W",
        title: "Dune",
        authors: ["Frank Herbert"],
      },
    };

    const r1 = handle({ method: "POST", path: "/ether/v1/kinds/books/resolve", body: JSON.stringify({ item }) });
    const b1 = r1.body as { sources: Array<{ release: { nzbUrl?: string; infoHash?: string } }> };
    assert.equal(b1.sources.length, 2);
    assert.equal(b1.sources[0].release.nzbUrl, "https://nzb.example/flaky.nzb");

    // Simulate Ether recording playbackFailed on the NZB; next /resolve hits KV cache
    // and immediately filters out the failed NZB via usenet_check.
    failFirst = true;
    const r2 = handle({ method: "POST", path: "/ether/v1/kinds/books/resolve", body: JSON.stringify({ item }) });
    const b2 = r2.body as { sources: Array<{ release: { nzbUrl?: string; infoHash?: string } }> };
    assert.equal(b2.sources.length, 1);
    assert.equal(b2.sources[0].release.infoHash, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("gracefully degrades when usenet_check is rate_limited or unsupported on older hosts", () => {
    let usenetCalls = 0;
    installMockHost({
      sourcesHandler: (q) => {
        if (q.kind === "indexer_search") {
          return [
            {
              nzbUrl: "https://nzb.example/one.nzb",
              title: "Frank Herbert - Dune (1965) EPUB",
              size: 2_100_000,
              indexer: "NZBGeek",
            },
            {
              nzbUrl: "https://nzb.example/two.nzb",
              title: "Frank Herbert - Dune (1965) EPUB v2",
              size: 2_200_000,
              indexer: "NZBPlanet",
            },
          ];
        }
        if (q.kind === "usenet_check") {
          usenetCalls++;
          throw new Error("rate_limited: usenet_check is limited to 20 per minute");
        }
        if (q.kind === "release_files") {
          return [{ nzbUrl: q.candidate?.nzbUrl, files: [{ index: 0, path: "Dune.epub", size: 2_100_000 }] }];
        }
        return [];
      },
    });

    const resp = handle({
      method: "POST",
      path: "/ether/v1/kinds/books/resolve",
      body: JSON.stringify({
        item: {
          id: "ol-OL893415W",
          level: "book",
          title: "Dune",
          year: 1965,
          playable: true,
          fields: { authors: [{ name: "Frank Herbert", role: "Author" }] },
          hints: {
            kind: "books",
            source: "openlibrary",
            sourceId: "ol-OL893415W",
            title: "Dune",
            authors: ["Frank Herbert"],
          },
        },
      }),
    });

    assert.equal(resp.status, 200);
    const body = resp.body as { sources: Array<{ release: { nzbUrl?: string } }> };
    assert.equal(body.sources.length, 2);
    // Stops retrying usenet_check after rate_limited on the first candidate
    assert.equal(usenetCalls, 1);
  });
});

describe("catalogue hygiene, biography categorization, and series edition filtering", () => {
  it("filters non-book merchandise, sheet music, albums, and RPG handbooks while keeping biographies", () => {
    assert.equal(
      isNonBookProduct({
        kind: "books",
        title: "AC/DC - Back in Black - Wall Poster",
        authors: ["Ac/DC"],
        publishers: ["Aquarius Entertainment Merchandising, Incorporated"],
      }),
      true,
    );
    assert.equal(
      isNonBookProduct({
        kind: "books",
        title: "AC/DC",
        authors: ["AC/DC"],
        publishers: ["Leonard Corporation, Hal"],
        subjects: ["Guitar music", "Rock music"],
      }),
      true,
    );
    assert.equal(
      isNonBookProduct({
        kind: "books",
        title: "Back in black",
        authors: ["AC/DC (Musical group)"],
        publishers: ["Atco"],
      }),
      true,
    );
    assert.equal(
      isNonBookProduct({
        kind: "books",
        title: "Cosmere RPG Stormlight Handbook",
        authors: ["Johnny O'Neal"],
        publishers: ["Brotherwise Games, LLC"],
      }),
      true,
    );
    // Legitimate biographies MUST be kept!
    assert.equal(
      isNonBookProduct({
        kind: "books",
        title: "AC/DC",
        authors: ["Mick Wall"],
        publishers: ["Orion Publishing Group, Limited"],
        subjects: ["AC/DC (Musical group)", "Rock musicians", "Biography"],
      }),
      false,
    );
    assert.equal(
      isNonBookProduct({
        kind: "books",
        title: "AC/DC: hard rock band",
        authors: ["Heather Miller"],
        publishers: ["Enslow"],
      }),
      false,
    );
  });

  it("excludes GraphicAudio dramatised editions and split-part editions from books", () => {
    assert.equal(
      isAudioOrDramatizedForBooks({
        kind: "books",
        title: "The Stormlight Archive 1",
        subtitle: "The Way of Kings (1 of 5)",
        publishers: ["Graphic Audio LLC"],
      }),
      true,
    );
    assert.equal(
      isSplitPartEdition("The Way of Kings, Part One", undefined, "books", true),
      true,
    );
    assert.equal(
      isSplitPartEdition("The Stormlight Archive 1", "The Way of Kings (1 of 5)", "books", true),
      true,
    );
    // A real print book with both audio/GraphicAudio and print publishers in OL is kept!
    assert.equal(
      isAudioOrDramatizedForBooks({
        kind: "books",
        title: "The Way of Kings",
        publishers: ["Orion Publishing Group, Limited", "Tor", "Graphic Audio, LLC.", "Tor Books"],
      }),
      false,
    );
    assert.equal(
      isAudioOrDramatizedForBooks({
        kind: "books",
        title: "Wind and Truth",
        publishers: ["Macmillan Audio", "Doherty Associates, LLC, Tom", "Nova"],
      }),
      false,
    );
  });

  it("categorizes AC/DC biographies under Biography and memoir and filters posters in live search", () => {
    installMockHost({
      settings: { enable_standard_ebooks: false, enable_gutenberg: false },
      httpHandler: (req) => {
        if (req.url.includes("openlibrary.org/search.json")) {
          return {
            status: 200,
            body: JSON.stringify({
              docs: [
                {
                  key: "/works/OL26801003W",
                  title: "AC/DC - Back in Black - Wall Poster",
                  author_name: ["Ac/DC"],
                  publisher: ["Aquarius Entertainment Merchandising, Incorporated"],
                },
                {
                  key: "/works/OL8352310W",
                  title: "AC/DC",
                  author_name: ["AC/DC"],
                  publisher: ["Leonard Corporation, Hal"],
                  subject: ["Guitar music", "Rock music"],
                },
                {
                  key: "/works/OL19707203W",
                  title: "AC/DC",
                  author_name: ["Mick Wall"],
                  publisher: ["Orion Publishing Group, Limited"],
                  subject: ["AC/DC (Musical group)", "Rock musicians", "Biography"],
                  first_publish_year: 2012,
                  number_of_pages_median: 437,
                },
                {
                  key: "/works/OL9770299W",
                  title: "AC/DC",
                  author_name: ["Ethan Schlesinger"],
                  publisher: ["Mason Crest"],
                  subject: ["AC/DC (Musical group)", "Rock musicians", "Juvenile literature"],
                  first_publish_year: 2008,
                },
                {
                  key: "/works/OL5822028W",
                  title: "AC/DC: hard rock band",
                  author_name: ["Heather Miller"],
                  publisher: ["Enslow"],
                  first_publish_year: 2009,
                },
              ],
            }),
          };
        }
        return { status: 404, body: "" };
      },
    });

    const resp = handle({
      method: "POST",
      path: "/ether/v1/kinds/books/search",
      body: JSON.stringify({ query: "AC/DC", limit: 20 }),
    });
    assert.equal(resp.status, 200);
    const items = (resp.body as { items: KindItem[] }).items;
    assert.equal(items.length, 3);
    assert.ok(!items.some((i) => /poster/i.test(i.title)));
    assert.ok(!items.some((i) => i.id === "ol-OL8352310W"));
    for (const bio of items) {
      const genres = bio.fields.genres as string[];
      assert.ok(genres.includes("Biography and memoir"), `expected biography genre on ${bio.id}: ${genres}`);
      assert.ok(!genres.includes("Literary fiction"), `should not be literary fiction on ${bio.id}`);
      assert.ok(!/literary fiction/i.test(bio.summary || ""), `bad summary on ${bio.id}: ${bio.summary}`);
    }
  });

  it("enforces one canonical edition per work and per series slot across books and audiobooks", () => {
    assert.equal(canonicalizeSeriesName("Stormlight Archive"), "The Stormlight Archive");
    assert.equal(canonicalizeSeriesName("Red Rising Saga"), "Red Rising");
    assert.equal(canonicalWorkTitle("Red Rising (Part 1 of 2) (Dramatized Adaptation)"), "red rising");

    const bookEntries: NormalizedEntry[] = [
      {
        kind: "books",
        source: "openlibrary",
        sourceId: "ol-OL15358691W",
        title: "The Way of Kings",
        authors: [{ name: "Brandon Sanderson", role: "Author" }],
        series: "Stormlight Archive",
        seriesIndex: 1,
        seriesNumber: "1",
        genres: ["Fantasy"],
        curated: ["Popular this week"],
        publisher: "Tor",
        pages: 1008,
        coverUrl: "https://covers.openlibrary.org/b/id/1-L.jpg",
      },
      {
        kind: "books",
        source: "openlibrary",
        sourceId: "ol-OL37894320W",
        title: "The Stormlight Archive 1",
        subtitle: "The Way of Kings (1 of 5)",
        authors: [{ name: "Brandon Sanderson", role: "Author" }],
        series: "The Stormlight Archive",
        genres: ["Fantasy"],
        curated: [],
        publisher: "Graphic Audio LLC",
      },
      {
        kind: "books",
        source: "openlibrary",
        sourceId: "ol-OL22983697W",
        title: "The Way of Kings, Part One",
        authors: [{ name: "Brandon Sanderson", role: "Author" }],
        series: "The Stormlight Archive",
        genres: ["Fantasy"],
        curated: [],
        publisher: "Gollancz",
      },
      {
        kind: "books",
        source: "openlibrary",
        sourceId: "ol-OL16813053W",
        title: "Words of Radiance",
        authors: [{ name: "Brandon Sanderson", role: "Author" }],
        series: "The Stormlight Archive",
        seriesIndex: 2,
        seriesNumber: "2",
        genres: ["Fantasy"],
        curated: [],
        publisher: "Tor",
        pages: 1088,
        coverUrl: "https://covers.openlibrary.org/b/id/2-L.jpg",
      },
    ];

    const mergedBooks = mergeEntries(bookEntries);
    assert.deepEqual(
      mergedBooks.map((e) => [e.sourceId, e.series, e.seriesIndex]),
      [
        ["ol-OL15358691W", "The Stormlight Archive", 1],
        ["ol-OL16813053W", "The Stormlight Archive", 2],
      ],
    );

    const audioEntries: NormalizedEntry[] = [
      {
        kind: "audiobooks",
        source: "audible",
        sourceId: "aud-B00I2VWW5U",
        title: "Red Rising",
        authors: [{ name: "Pierce Brown", role: "Author" }],
        narrators: [{ name: "Tim Gerard Reynolds", role: "Narrator" }],
        series: "Red Rising Saga",
        seriesIndex: 1,
        seriesNumber: "1",
        genres: ["Science fiction"],
        curated: [],
        unabridged: true,
        durationSec: 58200,
        coverUrl: "https://m.media-amazon.com/images/I/rr.jpg",
      },
      {
        kind: "audiobooks",
        source: "audible",
        sourceId: "aud-B0BVGTFDWN",
        title: "Red Rising (Part 1 of 2) (Dramatized Adaptation)",
        authors: [{ name: "Pierce Brown", role: "Author" }],
        series: "Red Rising",
        seriesIndex: 1,
        seriesNumber: "1",
        genres: ["Science fiction"],
        curated: [],
        publisher: "Graphic Audio LLC",
      },
      {
        kind: "audiobooks",
        source: "audible",
        sourceId: "aud-B00DRAMATZ",
        title: "Red Rising (Dramatized Adaptation)",
        authors: [{ name: "Pierce Brown", role: "Author" }],
        series: "Red Rising",
        seriesIndex: 1,
        seriesNumber: "1",
        genres: ["Science fiction"],
        curated: [],
        publisher: "Graphic Audio LLC",
      },
    ];

    const mergedAudio = mergeEntries(audioEntries);
    assert.equal(mergedAudio.length, 1);
    assert.equal(mergedAudio[0].sourceId, "aud-B00I2VWW5U");
    assert.equal(mergedAudio[0].series, "Red Rising");
  });

  it("reconciles stored junk and misclassified biographies on /changes revision upgrade", () => {
    const mkItem = (id: string, title: string, extra: Partial<KindItem> = {}): KindItem => ({
      id,
      level: "book",
      title,
      playable: true,
      fields: {
        authors: [{ name: "Test Author", role: "Author" }],
        genres: ["Literary fiction"],
        ...(extra.fields || {}),
      },
      hints: {
        kind: "books",
        source: "openlibrary",
        sourceId: id,
        title,
        authors: ["Test Author"],
        ...(extra.hints || {}),
      },
      ...extra,
    });

    installMockHost({
      settings: { enable_openlibrary: false, enable_standard_ebooks: false, enable_gutenberg: false },
      storedItems: {
        books: [
          mkItem("ol-OL26801003W", "AC/DC - Back in Black - Wall Poster", {
            fields: {
              authors: [{ name: "Ac/DC", role: "Author" }],
              publisher: "Aquarius Entertainment Merchandising, Incorporated",
              genres: ["Literary fiction"],
            },
          }),
          mkItem("ol-OL37894320W", "The Stormlight Archive 1: The Way of Kings (1 of 5)", {
            fields: {
              authors: [{ name: "Brandon Sanderson", role: "Author" }],
              publisher: "Graphic Audio LLC",
              series: "The Stormlight Archive",
              genres: ["Literary fiction"],
            },
          }),
          mkItem("ol-OL5822028W", "AC/DC: hard rock band", {
            summary: "A literary fiction book by Heather Miller (2009).",
            fields: {
              authors: [{ name: "Heather Miller", role: "Author" }],
              publisher: "Enslow",
              genres: ["Literary fiction"],
            },
          }),
          mkItem("ol-KEEP1", "Dune"),
          mkItem("ol-KEEP2", "Foundation"),
          mkItem("ol-KEEP3", "Hyperion"),
          mkItem("ol-KEEP4", "Neuromancer"),
          mkItem("ol-KEEP5", "Snow Crash"),
        ],
      },
    });

    const resp = handle({
      method: "POST",
      path: "/ether/v1/kinds/books/changes",
      body: JSON.stringify({ cursor: "v2:1700000000", limit: 100 }),
    });
    assert.equal(resp.status, 200);
    const page = resp.body as { upserts: KindItem[]; deletes: string[]; nextCursor: string; complete: boolean };
    assert.ok(page.nextCursor.startsWith("v6:"));
    assert.ok(page.deletes.includes("ol-OL26801003W"));
    assert.ok(page.deletes.includes("ol-OL37894320W"));
    assert.ok(!page.deletes.includes("ol-OL5822028W"));
    const repaired = page.upserts.find((u) => u.id === "ol-OL5822028W");
    assert.ok(repaired, "expected AC/DC biography to be repaired in upserts");
    assert.deepEqual(repaired.fields.genres, ["Biography and memoir", "Non-fiction"]);
    assert.equal(repaired.summary, "A biography by Heather Miller (2009).");
  });

  it("emits W196 hints.parts {name, mime, durationSec, size} on LibriVox audiobooks and resolves per part", () => {
    installMockHost({
      settings: {
        enable_librivox: true,
        enable_audible_metadata: false,
        catalog_size: "compact",
      },
      httpHandler: (req) => {
        const url = req.url;
        if (url.startsWith("https://librivox.org/api/feed/audiobooks/")) {
          return {
            status: 200,
            body: JSON.stringify({
              books: [
                {
                  id: "314",
                  title: "Adventures of Sherlock Holmes",
                  description: "Twelve classic detective stories.",
                  url_iarchive: "https://archive.org/details/adventures_holmes",
                  language: "English",
                  copyright_year: "1892",
                  totaltimesecs: 5106,
                  authors: [{ first_name: "Arthur Conan", last_name: "Doyle" }],
                  genres: [{ name: "Detective Fiction" }],
                  sections: [
                    {
                      section_number: "1",
                      title: "A Scandal in Bohemia",
                      listen_url:
                        "https://www.archive.org/download/adventures_holmes/adventureholmes_01_doyle_64kb.mp3",
                      playtime: "3906",
                      readers: [{ display_name: "Kara Shallenberg" }],
                    },
                    {
                      section_number: "2",
                      title: "The Red-Headed League",
                      listen_url:
                        "https://www.archive.org/download/adventures_holmes/adventureholmes_02_doyle_64kb.mp3",
                      playtime: "1200",
                      readers: [{ display_name: "Robin Cotter" }],
                    },
                  ],
                },
              ],
            }),
          };
        }
        if (url === "https://archive.org/metadata/adventures_holmes/files") {
          return {
            status: 200,
            body: JSON.stringify({
              result: [
                { name: "adventureholmes_01_doyle_64kb.mp3", size: "31254215" },
                { name: "adventureholmes_02_doyle_64kb.mp3", size: "9601234" },
                { name: "adventures_holmes_files.xml", size: "4096" },
              ],
            }),
          };
        }
        return { status: 404, body: "{}" };
      },
    });

    const browseResp = handle({
      method: "POST",
      path: "/ether/v1/kinds/audiobooks/browse",
      body: JSON.stringify({ limit: 20 }),
    });
    assert.equal(browseResp.status, 200);
    const items = (browseResp.body as { items: KindItem[] }).items;
    const sherlock = items.find((i) => i.id === "lv-314");
    assert.ok(sherlock, "expected lv-314 in audiobooks browse");
    assert.deepEqual(sherlock.hints.parts, [
      {
        name: "A Scandal in Bohemia",
        mime: "audio/mpeg",
        durationSec: 3906,
        size: 31254215,
      },
      {
        name: "The Red-Headed League",
        mime: "audio/mpeg",
        durationSec: 1200,
        size: 9601234,
      },
    ]);

    // Resolving part 1 returns the exact part URL, MIME, durationSec, and byte size.
    const resolvePart1 = handle({
      method: "POST",
      path: "/ether/v1/kinds/audiobooks/resolve",
      body: JSON.stringify({ item: sherlock, partIndex: 1 }),
    });
    assert.equal(resolvePart1.status, 200);
    const sources = (resolvePart1.body as { sources: Array<Record<string, unknown>> }).sources;
    assert.equal(sources.length, 1);
    assert.equal(sources[0].label, "The Red-Headed League");
    assert.equal(sources[0].mime, "audio/mpeg");
    assert.equal(sources[0].durationSec, 1200);
    assert.equal(sources[0].size, 9601234);
    assert.equal(
      sources[0].url,
      "https://www.archive.org/download/adventures_holmes/adventureholmes_02_doyle_64kb.mp3",
    );

    // Hints compaction for ultra-long audiobooks preserves size and durationSec under 16 KiB.
    const hugeParts = Array.from({ length: 220 }, (_, i) => ({
      name: `Chapter ${i + 1}: A Very Long Classical Chapter Heading About Maritime Adventures`,
      mime: "audio/mpeg",
      durationSec: 600 + i,
      size: 4_800_000 + i * 1000,
    }));
    const hugeItem = entryToKindItem({
      kind: "audiobooks",
      source: "librivox",
      sourceId: "lv-99999",
      title: "The Count of Monte Cristo",
      authors: [{ name: "Alexandre Dumas", role: "Author" }],
      genres: ["Classics"],
      curated: ["Free classics"],
      parts: hugeParts,
    });
    assert.ok(JSON.stringify(hugeItem.hints).length <= 16_384, "hints must stay under 16 KiB");
    assert.equal(hugeItem.hints.parts?.length, 220);
    assert.equal(hugeItem.hints.parts?.[0]?.size, 4_800_000);
    assert.equal(hugeItem.hints.parts?.[0]?.durationSec, 600);
  });

  it("prefers English print edition cover, publisher, and year over Spanish/audio work defaults on Open Library", () => {
    installMockHost({
      settings: {
        enable_openlibrary: true,
        enable_standard_ebooks: false,
        enable_gutenberg: false,
        language: "en",
        catalog_size: "standard",
      },
      httpHandler: (req) => {
        const url = req.url;
        if (url.includes("openlibrary.org/search.json") && /Wind(%20|\+)and(%20|\+)Truth/i.test(url)) {
          return {
            status: 200,
            body: JSON.stringify({
              docs: [
                {
                  key: "/works/OL37577930W",
                  title: "Wind and Truth",
                  author_name: ["Brandon Sanderson"],
                  first_publish_year: 2024,
                  cover_i: 14838986, // Spanish Nova cover ("Viento y verdad")
                  language: ["spa", "eng"],
                  publisher: ["Nova", "Doherty Associates, LLC, Tom"],
                  edition_count: 6,
                  editions: {
                    docs: [
                      {
                        key: "/books/OL57480993M",
                        title: "Wind and Truth",
                        language: ["eng"],
                        cover_i: 14836765,
                        publisher: ["Macmillan Audio"],
                        format: ["eAudiobook"],
                        publish_year: [2024],
                      },
                    ],
                  },
                },
              ],
            }),
          };
        }
        if (url === "https://openlibrary.org/works/OL37577930W/editions.json?limit=35") {
          return {
            status: 200,
            body: JSON.stringify({
              size: 6,
              entries: [
                {
                  key: "/books/OL57480993M",
                  title: "Wind and Truth",
                  publishers: ["Macmillan Audio"],
                  physical_format: "eAudiobook",
                  publish_date: "2024-12-06",
                  covers: [14836765],
                  languages: [{ key: "/languages/eng" }],
                },
                {
                  key: "/books/OL50999999M",
                  title: "Viento y verdad",
                  publishers: ["Nova"],
                  physical_format: "Hardcover",
                  publish_date: "2024-12-09",
                  covers: [14838986],
                  languages: [{ key: "/languages/spa" }],
                },
                {
                  key: "/books/OL50789375M",
                  title: "Wind and Truth",
                  publishers: ["Doherty Associates, LLC, Tom"],
                  physical_format: "Hardcover",
                  publish_date: "2024",
                  number_of_pages: 1344,
                  covers: [14826186],
                  isbn_13: ["9781250319180"],
                  languages: [{ key: "/languages/eng" }],
                },
              ],
            }),
          };
        }
        if (url.includes("openlibrary.org/search.json") && /Rhythm(%20|\+)of(%20|\+)War/i.test(url)) {
          return {
            status: 200,
            body: JSON.stringify({
              docs: [
                {
                  key: "/works/OL20842226W",
                  title: "Rhythm of War",
                  author_name: ["Brandon Sanderson"],
                  first_publish_year: 2011, // bogus work year in OL
                  cover_i: 14658361,
                  language: ["por", "spa", "eng"],
                  publisher: ["Trama", "Tor Fantasy"],
                  edition_count: 15,
                },
              ],
            }),
          };
        }
        if (url === "https://openlibrary.org/works/OL20842226W/editions.json?limit=35") {
          return {
            status: 200,
            body: JSON.stringify({
              size: 15,
              entries: [
                {
                  key: "/books/OL30000000M",
                  title: "Rhythm of War",
                  publishers: ["Tor Fantasy"],
                  physical_format: "Hardcover",
                  publish_date: "2020",
                  number_of_pages: 1232,
                  covers: [14658361],
                  isbn_13: ["9780765326386"],
                  languages: [{ key: "/languages/eng" }],
                },
              ],
            }),
          };
        }
        return { status: 200, body: JSON.stringify({ works: [], docs: [] }) };
      },
    });

    const resp = handle({
      method: "POST",
      path: "/ether/v1/kinds/books/browse",
      body: JSON.stringify({ limit: 50 }),
    });
    assert.equal(resp.status, 200);
    const items = (resp.body as { items: KindItem[] }).items;

    const wat = items.find((i) => i.id === "ol-OL37577930W");
    assert.ok(wat, "expected Wind and Truth in catalog");
    assert.equal(wat.art?.[0]?.url, "https://covers.openlibrary.org/b/id/14826186-L.jpg");
    assert.equal(wat.fields.publisher, "Doherty Associates, LLC, Tom");
    assert.equal(wat.fields.isbn, "9781250319180");
    assert.equal(wat.fields.series, "The Stormlight Archive");
    assert.equal(wat.index, 5);

    const row = items.find((i) => i.id === "ol-OL20842226W");
    assert.ok(row, "expected Rhythm of War in catalog");
    assert.equal(row.year, 2020);
    assert.equal(row.fields.publisher, "Tor Fantasy");
    assert.equal(row.fields.isbn, "9780765326386");
    assert.equal(row.index, 4);
  });
});

describe("1.0.6 ported matching rules (1.0.10 fixes)", () => {
  const tanaFrenchBook: KindItem = entryToKindItem({
    kind: "books",
    source: "openlibrary",
    sourceId: "ol-OL8193506W",
    title: "In the Woods",
    year: 2007,
    authors: [{ name: "Tana French", role: "Author" }],
    series: "Dublin Murder Squad",
    seriesIndex: 1,
    seriesNumber: "1",
    genres: ["Mystery and thriller"],
    curated: [],
    language: "English",
    format: "epub",
  });

  const duneBook: KindItem = entryToKindItem({
    kind: "books",
    source: "openlibrary",
    sourceId: "ol-OL893415W",
    title: "Dune",
    year: 1965,
    authors: [{ name: "Frank Herbert", role: "Author" }],
    series: "Dune",
    seriesIndex: 1,
    seriesNumber: "1",
    genres: ["Science fiction"],
    curated: [],
    language: "English",
    format: "epub",
  });

  const prideBook: KindItem = entryToKindItem({
    kind: "books",
    source: "openlibrary",
    sourceId: "ol-OL66554W",
    title: "Pride and Prejudice",
    year: 1813,
    authors: [{ name: "Jane Austen", role: "Author" }],
    genres: ["Classics", "Romance"],
    curated: [],
    language: "English",
    format: "epub",
  });

  const lotrBook: KindItem = entryToKindItem({
    kind: "books",
    source: "openlibrary",
    sourceId: "ol-OL27448W",
    title: "The Lord of the Rings",
    year: 1954,
    authors: [{ name: "J.R.R. Tolkien", role: "Author" }],
    genres: ["Fantasy"],
    curated: [],
    language: "English",
    format: "epub",
  });

  const wayOfKingsBook: KindItem = entryToKindItem({
    kind: "books",
    source: "openlibrary",
    sourceId: "ol-OL15358691W",
    title: "The Way of Kings",
    year: 2010,
    authors: [{ name: "Brandon Sanderson", role: "Author" }],
    series: "The Stormlight Archive",
    seriesIndex: 1,
    seriesNumber: "1",
    genres: ["Fantasy"],
    curated: [],
    language: "English",
    format: "epub",
  });

  it("extracts series from hints and fields in extractTargetMeta", () => {
    assert.equal(extractTargetMeta(wayOfKingsBook).series, "The Stormlight Archive");
    const fieldsOnly: KindItem = {
      ...wayOfKingsBook,
      hints: { ...wayOfKingsBook.hints, series: undefined },
      fields: { ...wayOfKingsBook.fields, series: "The Stormlight Archive" },
    };
    assert.equal(extractTargetMeta(fieldsOnly).series, "The Stormlight Archive");
  });

  it("does not reject authors or narrators whose names match FOREIGN_RE (e.g. Tana French, Dawn French)", () => {
    const ok1 = scoreCandidate(tanaFrenchBook, {
      title: "Tana French - In the Woods (2007) Retail EPUB",
      size: 1_800_000,
    });
    assert.equal(ok1.rejected, false, `unexpected reject: ${ok1.reasons.join("; ")}`);
    assert.ok(ok1.score >= 0.75, `expected high score, got ${ok1.score}`);

    const ok2 = scoreCandidate(tanaFrenchBook, {
      title: "French, Tana - In the Woods (2007) EPUB",
      size: 1_800_000,
    });
    assert.equal(ok2.rejected, false, `unexpected reject: ${ok2.reasons.join("; ")}`);

    const ok3 = scoreCandidate(tanaFrenchBook, {
      title: "Tana.French.In.the.Woods.2007.EPUB",
      size: 1_800_000,
    });
    assert.equal(ok3.rejected, false, `unexpected reject: ${ok3.reasons.join("; ")}`);

    const ok4 = scoreCandidate(tanaFrenchBook, {
      title: "In the Woods - French.epub",
      size: 1_800_000,
    });
    assert.equal(ok4.rejected, false, `unexpected reject: ${ok4.reasons.join("; ")}`);

    // Foreign edition of a Tana French book is STILL rejected.
    const german = scoreCandidate(tanaFrenchBook, {
      title: "Tana French - In the Woods (German) EPUB",
      size: 1_800_000,
    });
    assert.equal(german.rejected, true);
    assert.ok(german.reasons.some((r) => r.includes("other language (german)")));

    const frenchEd = scoreCandidate(tanaFrenchBook, {
      title: "Tana French - In the Woods (French Edition) EPUB",
      size: 1_800_000,
    });
    assert.equal(frenchEd.rejected, true);
    assert.ok(frenchEd.reasons.some((r) => r.includes("other language (french)")));

    const francaisEd = scoreCandidate(tanaFrenchBook, {
      title: "Tana French - In the Woods [Français] EPUB",
      size: 1_800_000,
    });
    assert.equal(francaisEd.rejected, true);
    assert.ok(francaisEd.reasons.some((r) => r.includes("other language (francais)")));

    // Narrator with surname matching FOREIGN_RE is also preserved.
    const narratedAudio = entryToKindItem({
      kind: "audiobooks",
      source: "audible",
      sourceId: "aud-B00TEST999",
      title: "In the Woods",
      year: 2007,
      authors: [{ name: "Test Author", role: "Author" }],
      narrators: [{ name: "Dawn French", role: "Narrator" }],
      genres: ["Mystery and thriller"],
      curated: [],
      durationSec: 36_000,
      unabridged: true,
      language: "English",
      format: "m4b",
    });
    const okNarr = scoreCandidate(narratedAudio, {
      title: "Test Author - In the Woods [Dawn French] Unabridged M4B",
      size: 280_000_000,
    });
    assert.equal(okNarr.rejected, false, `unexpected reject: ${okNarr.reasons.join("; ")}`);
  });

  it("folds diacritics when rejecting foreign language releases and allows language words in target title", () => {
    for (const [label, expectedLang] of [
      ["Frank Herbert - Dune (Español) EPUB", "espanol"],
      ["Frank Herbert - Dune [Français] EPUB", "francais"],
      ["Frank Herbert - Dune (Português) EPUB", "portugues"],
      ["Frank Herbert - Dune (Deutsch) EPUB", "deutsch"],
    ]) {
      const res = scoreCandidate(duneBook, { title: label, size: 2_000_000 });
      assert.equal(res.rejected, true, `expected ${label} to be rejected`);
      assert.ok(
        res.reasons.some((r) => r.includes(`other language (${expectedLang})`)),
        `expected reason other language (${expectedLang}), got ${res.reasons.join("; ")}`,
      );
    }

    // Target title itself containing a language word is allowed, but another language is still rejected.
    const frenchTitleBook = entryToKindItem({
      kind: "books",
      source: "openlibrary",
      sourceId: "ol-OLFLW1W",
      title: "The French Lieutenant's Woman",
      year: 1969,
      authors: [{ name: "John Fowles", role: "Author" }],
      genres: ["Literary fiction"],
      curated: [],
      language: "English",
      format: "epub",
    });
    const okTitle = scoreCandidate(frenchTitleBook, {
      title: "John Fowles - The French Lieutenant's Woman (1969) EPUB",
      size: 1_500_000,
    });
    assert.equal(okTitle.rejected, false);

    const spanishCopy = scoreCandidate(frenchTitleBook, {
      title: "John Fowles - The French Lieutenant's Woman (Español) EPUB",
      size: 1_500_000,
    });
    assert.equal(spanishCopy.rejected, true);
    assert.ok(spanishCopy.reasons.some((r) => r.includes("other language (espanol)")));

    // Non-English target item does not reject matching-language releases.
    const spanishTarget: KindItem = {
      ...duneBook,
      fields: { ...duneBook.fields, language: "Spanish" },
      hints: { ...duneBook.hints, language: "Spanish" },
    };
    const okSpanish = scoreCandidate(spanishTarget, {
      title: "Frank Herbert - Dune (Español) EPUB",
      size: 2_000_000,
    });
    assert.equal(okSpanish.rejected, false);
  });

  it("recognizes subtitles for titles containing stopwords while still penalizing spin-offs and extra words", () => {
    // Pride and Prejudice (contains stopword "and"): subtitle must NOT be penalized.
    const prideSub = scoreCandidate(prideBook, {
      title: "Jane Austen - Pride and Prejudice: A Romantic Classic (EPUB)",
      size: 1_400_000,
    });
    assert.equal(prideSub.rejected, false);
    assert.ok(
      !prideSub.reasons.some((r) => r.startsWith("different title")),
      `unexpected different-title penalty: ${prideSub.reasons.join("; ")}`,
    );
    assert.ok(prideSub.score >= 0.75, `expected >= 0.75, got ${prideSub.score}`);

    // Pride and Prejudice and Zombies: NOT a subtitle -> must be penalized below 0.65.
    const zombies = scoreCandidate(prideBook, {
      title: "Jane Austen - Pride and Prejudice and Zombies (2009) EPUB",
      size: 1_400_000,
    });
    assert.ok(
      zombies.reasons.some((r) => r.includes("different title (extra: zombies)")),
      `expected zombies penalty, got ${zombies.reasons.join("; ")}`,
    );
    assert.ok(zombies.score < 0.65, `expected zombies score < 0.65, got ${zombies.score}`);

    // The Lord of the Rings (contains stopwords "the", "of", "the"): subtitle recognized with or without leading "The".
    const lotrSub = scoreCandidate(lotrBook, {
      title: "J.R.R. Tolkien - The Lord of the Rings: One Volume Illustrated (EPUB)",
      size: 4_500_000,
    });
    assert.ok(!lotrSub.reasons.some((r) => r.startsWith("different title")));
    assert.ok(lotrSub.score >= 0.75);

    const lotrNoThe = scoreCandidate(lotrBook, {
      title: "J.R.R. Tolkien - Lord of the Rings: Deluxe Edition (EPUB)",
      size: 4_500_000,
    });
    assert.ok(!lotrNoThe.reasons.some((r) => r.startsWith("different title")));
    assert.ok(lotrNoThe.score >= 0.75);

    const lotrHistory = scoreCandidate(lotrBook, {
      title: "J.R.R. Tolkien - The History of the Lord of the Rings (EPUB)",
      size: 4_500_000,
    });
    assert.ok(lotrHistory.reasons.some((r) => r.includes("different title (extra: history)")));
    assert.ok(lotrHistory.score < 0.65);

    // Princess of Dune for Dune: penalized even when surname matches (Brian Herbert).
    const princess = scoreCandidate(duneBook, {
      title: "Brian Herbert - Princess of Dune (2023) EPUB",
      size: 2_200_000,
    });
    assert.ok(princess.reasons.some((r) => r.includes("different title (extra: princess)")));
    assert.ok(princess.score < 0.65, `expected Princess of Dune < 0.65, got ${princess.score}`);

    // Series words in release title are allowed via target.series (extractTargetMeta bug fix).
    const withSeries = scoreCandidate(wayOfKingsBook, {
      title: "Brandon Sanderson - The Stormlight Archive 01 The Way of Kings (2010) EPUB",
      size: 3_500_000,
    });
    assert.ok(
      !withSeries.reasons.some((r) => r.startsWith("different title")),
      `series words should be allowed: ${withSeries.reasons.join("; ")}`,
    );
    assert.ok(withSeries.score >= 0.75);

    // Authorless segmented release is penalized by -0.2 and rejected.
    const authorless = scoreCandidate(duneBook, {
      title: "Unknown Uploader - Dune (1965) EPUB",
      size: 2_200_000,
    });
    assert.ok(authorless.reasons.includes("author not in release name"));
    assert.equal(authorless.rejected, true);
  });
});

describe("1.0.6 audiobook duplicate collapse & canonicalWorkTitle (1.0.8 fixes)", () => {
  const defaultSettings = {
    hardcoverToken: "",
    enableOpenLibrary: false,
    enableAudibleMetadata: false,
    enableStandardEbooks: false,
    enableLibriVox: false,
    enableGutenberg: false,
    language: "en" as const,
    catalogSize: "standard" as const,
    ebookCategories: "7000,7020",
    audiobookCategories: "3030",
    preferUnabridged: true,
    preferCached: true,
    contactEmail: "",
  };

  const mkAudio = (
    id: string,
    title: string,
    opts: {
      author?: string;
      narrators?: string[];
      hasParts?: boolean;
      rating?: number;
      series?: string;
      index?: number;
    } = {},
  ): KindItem => ({
    id,
    level: "audiobook",
    title,
    rating: opts.rating ?? 8.2,
    index: opts.index,
    playable: true,
    etag: `etag-${id}`,
    fields: {
      authors: [{ name: opts.author ?? "Jane Austen", role: "Author" }],
      narrators: (opts.narrators || []).map((name) => ({ name, role: "Narrator" })),
      ...(opts.series ? { series: opts.series } : {}),
    },
    hints: {
      kind: "audiobooks",
      source: id.startsWith("lv-") ? "librivox" : "audible",
      sourceId: id,
      title,
      authors: [opts.author ?? "Jane Austen"],
      narrators: opts.narrators,
      ...(opts.series ? { series: opts.series } : {}),
      ...(opts.hasParts
        ? { parts: [{ name: "Chapter 1", mime: "audio/mpeg", durationSec: 900, size: 7_200_000 }] }
        : {}),
    },
  });

  it("strips recording variant suffixes in canonicalWorkTitle", () => {
    assert.equal(canonicalWorkTitle("Pride and Prejudice (Version 2)"), "pride and prejudice");
    assert.equal(canonicalWorkTitle("Frankenstein (Dramatic Reading)"), "frankenstein");
    assert.equal(canonicalWorkTitle("Dune (Full Cast)"), "dune");
    assert.equal(canonicalWorkTitle("Dracula (Multi-Cast)"), "dracula");
    assert.equal(canonicalWorkTitle("Dracula (Multicast)"), "dracula");
    assert.equal(canonicalWorkTitle("The Hobbit (Solo Reading)"), "hobbit");
  });

  it("keeps a stored audiobook with playable parts over a fresh metadata-only duplicate and merges narrators", () => {
    const storedWithParts = mkAudio("lv-100", "Pride and Prejudice", {
      narrators: ["Karen Savage"],
      hasParts: true,
      rating: 8.0,
      series: "Austen Classics",
      index: 1,
    });
    const freshMetadataOnly = mkAudio("aud-100", "Pride and Prejudice", {
      narrators: ["Rosamund Pike"],
      hasParts: false,
      rating: 9.6,
      series: "Austen Classics",
      index: 1,
    });

    installMockHost({
      storedItems: {
        audiobooks: [
          storedWithParts,
          freshMetadataOnly,
          mkAudio("lv-k1", "Emma", { hasParts: true }),
          mkAudio("lv-k2", "Persuasion", { hasParts: true }),
          mkAudio("lv-k3", "Sense and Sensibility", { hasParts: true }),
          mkAudio("lv-k4", "Mansfield Park", { hasParts: true }),
        ],
      },
    });

    const res = reconcileStoredCatalog("audiobooks", [freshMetadataOnly], defaultSettings);
    assert.ok(!res.deletes.includes("lv-100"), "stored copy with parts must not be deleted");
    assert.ok(res.suppressedFreshIds.includes("aud-100"), "metadata-only fresh copy must be suppressed");
    assert.ok(res.deletes.includes("aud-100"), "already-stored metadata-only copy should be deleted");

    const updated = res.extraUpserts.find((u) => u.id === "lv-100");
    assert.ok(updated, "stored keeper should be upserted with merged narrators");
    assert.deepEqual(
      (updated.fields.narrators as Array<{ name: string }>).map((n) => n.name),
      ["Karen Savage", "Rosamund Pike"],
    );
    assert.deepEqual(updated.hints.narrators, ["Karen Savage", "Rosamund Pike"]);
    assert.notEqual(updated.etag, "etag-lv-100");
  });

  it("preserves merged narrators when the winning keeper is fresh and caps narrators at 8", () => {
    const freshKeeper = mkAudio("lv-200", "Frankenstein", {
      author: "Mary Shelley",
      narrators: ["Cori Samuel"],
      hasParts: true,
    });
    const storedDup1 = mkAudio("lv-201", "Frankenstein (Version 2)", {
      author: "Mary Shelley",
      narrators: ["Thomas Copeland", "Narrator 3", "Narrator 4", "Narrator 5"],
      hasParts: true,
    });
    const storedDup2 = mkAudio("lv-202", "Frankenstein (Dramatic Reading)", {
      author: "Mary Shelley",
      narrators: ["Narrator 6", "Narrator 7", "Narrator 8", "Narrator 9", "Narrator 10"],
      hasParts: true,
    });

    installMockHost({
      storedItems: {
        audiobooks: [
          storedDup1,
          storedDup2,
          mkAudio("lv-a", "Dracula", { author: "Bram Stoker", hasParts: true }),
          mkAudio("lv-b", "Moby Dick", { author: "Herman Melville", hasParts: true }),
          mkAudio("lv-c", "Treasure Island", { author: "Robert Louis Stevenson", hasParts: true }),
          mkAudio("lv-d", "Jane Eyre", { author: "Charlotte Bronte", hasParts: true }),
          mkAudio("lv-e", "Wuthering Heights", { author: "Emily Bronte", hasParts: true }),
        ],
      },
    });

    const res = reconcileStoredCatalog("audiobooks", [freshKeeper], defaultSettings);
    assert.ok(res.deletes.includes("lv-201"));
    assert.ok(res.deletes.includes("lv-202"));
    assert.ok(!res.deletes.includes("lv-200"));

    const updatedFresh = res.extraUpserts.find((u) => u.id === "lv-200");
    assert.ok(updatedFresh, "fresh keeper with merged narrators must be included in extraUpserts");
    const narratorNames = (updatedFresh.fields.narrators as Array<{ name: string }>).map(
      (n) => n.name,
    );
    assert.equal(narratorNames.length, 8);
    assert.equal(narratorNames[0], "Cori Samuel");
    assert.equal(narratorNames[1], "Thomas Copeland");
    assert.deepEqual(updatedFresh.hints.narrators, narratorNames);
    assert.notEqual(updatedFresh.etag, "etag-lv-200");
  });

  it("does not collapse multi-part split titles (Vol. 1 / Vol. 2, Part 1 / Part 2)", () => {
    const vol1 = mkAudio("lv-301", "Short Stories Vol. 1", {
      author: "Anton Chekhov",
      narrators: ["Reader A"],
      hasParts: true,
    });
    const vol2 = mkAudio("lv-302", "Short Stories Vol. 2", {
      author: "Anton Chekhov",
      narrators: ["Reader B"],
      hasParts: true,
    });
    const part1 = mkAudio("lv-303", "Don Quixote, Part 1", {
      author: "Miguel de Cervantes",
      narrators: ["Reader C"],
      hasParts: true,
    });
    const part2 = mkAudio("lv-304", "Don Quixote, Part 2", {
      author: "Miguel de Cervantes",
      narrators: ["Reader D"],
      hasParts: true,
    });

    installMockHost({
      storedItems: {
        audiobooks: [vol1, vol2, part1, part2],
      },
    });

    const res = reconcileStoredCatalog("audiobooks", [], defaultSettings);
    assert.deepEqual(res.deletes, []);
  });

  it("applies fresh keeper merged narrators and suppresses defeated fresh duplicates across /changes pagination", () => {
    const freshKeeper = mkAudio("lv-500", "Frankenstein", {
      author: "Mary Shelley",
      narrators: ["Cori Samuel"],
      hasParts: true,
    });
    const freshDefeated = mkAudio("aud-600", "Pride and Prejudice", {
      author: "Jane Austen",
      narrators: ["Rosamund Pike"],
      hasParts: false,
      rating: 9.5,
    });
    const storedDup = mkAudio("lv-501", "Frankenstein (Version 2)", {
      author: "Mary Shelley",
      narrators: ["Thomas Copeland"],
      hasParts: true,
    });
    const storedWithParts = mkAudio("lv-600", "Pride and Prejudice", {
      author: "Jane Austen",
      narrators: ["Karen Savage"],
      hasParts: true,
    });

    const state = installMockHost({
      settings: {
        enable_audible_metadata: false,
        enable_librivox: false,
        catalog_size: "standard",
        language: "en",
      },
      storedItems: {
        audiobooks: [
          storedDup,
          storedWithParts,
          mkAudio("lv-x1", "Emma", { author: "Jane Austen", hasParts: true }),
          mkAudio("lv-x2", "Dracula", { author: "Bram Stoker", hasParts: true }),
          mkAudio("lv-x3", "Moby Dick", { author: "Herman Melville", hasParts: true }),
        ],
      },
    });

    // Seed catalog cache so buildCatalogItems returns our controlled fresh items on every page.
    // Use an expired v6 cursor (>3h old) so /changes runs reconciliation + multi-page pagination
    // without clearing the seeded cache.
    const cacheKey = "cat3:audiobooks:en:standard:hc0:10100";
    state.kv.set(
      `c:${cacheKey}`,
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, v: [freshKeeper, freshDefeated] }),
    );

    // Page with limit=1 to force multi-page sync:<ts>:<offset> pagination.
    const p1 = handle({
      method: "POST",
      path: "/ether/v1/kinds/audiobooks/changes",
      body: JSON.stringify({ cursor: "v6:1700000000", limit: 1 }),
    });
    assert.equal(p1.status, 200);
    const b1 = p1.body as {
      upserts: KindItem[];
      deletes: string[];
      nextCursor: string;
      complete: boolean;
    };
    assert.equal(b1.complete, false);
    assert.ok(b1.nextCursor.startsWith("sync:"));
    assert.ok(b1.deletes.includes("lv-501"));

    const p2 = handle({
      method: "POST",
      path: "/ether/v1/kinds/audiobooks/changes",
      body: JSON.stringify({ cursor: b1.nextCursor, limit: 1 }),
    });
    assert.equal(p2.status, 200);
    const b2 = p2.body as { upserts: KindItem[]; nextCursor: string; complete: boolean };
    assert.equal(b2.complete, true);
    assert.ok(b2.nextCursor.startsWith("v6:"));

    const allUpserted = [...b1.upserts, ...b2.upserts];
    const ids = allUpserted.map((u) => u.id);
    assert.deepEqual(ids, ["lv-500", "lv-600"]);
    assert.deepEqual(
      (allUpserted[0].fields.narrators as Array<{ name: string }>).map((n) => n.name),
      ["Cori Samuel", "Thomas Copeland"],
    );
    assert.deepEqual(
      (allUpserted[1].fields.narrators as Array<{ name: string }>).map((n) => n.name),
      ["Karen Savage", "Rosamund Pike"],
    );
  });
});

describe("Comics & Manga: series cards with volumes inside, strict volume matching", () => {
  // Two AniList titles: a 3-volume manga and a one-shot with no volume count.
  const anilistPage = {
    data: {
      Page: {
        pageInfo: { hasNextPage: false },
        media: [
          {
            id: 53390,
            title: { romaji: "Shingeki no Kyojin", english: "Attack on Titan" },
            synonyms: [],
            countryOfOrigin: "JP",
            status: "FINISHED",
            volumes: 3,
            startDate: { year: 2009 },
            genres: ["Action"],
            coverImage: { extraLarge: "https://s4.anilist.co/file/aot.jpg" },
            description: "Walls.",
            averageScore: 84,
            isAdult: false,
            staff: { edges: [{ role: "Story & Art", node: { name: { full: "Hajime Isayama" } } }] },
          },
          {
            id: 1,
            title: { romaji: "Hitori", english: null },
            synonyms: [],
            countryOfOrigin: "KR",
            status: "FINISHED",
            volumes: null,
            startDate: { year: 2020 },
            genres: [],
            coverImage: {},
            description: "",
            averageScore: 0,
            isAdult: false,
            staff: { edges: [] },
          },
        ],
      },
    },
  };

  const call = (path: string, body: unknown) => {
    const resp = handle({ method: "POST", path, headers: {}, body: JSON.stringify(body) });
    const raw = resp.body as unknown;
    return { status: resp.status, body: (typeof raw === "string" ? JSON.parse(raw) : raw) as any };
  };

  beforeEach(() => {
    installMockHost({
      settings: { enable_manga: true, enable_mangaupdates: false, manga_titles: 20 },
      httpHandler: (req) =>
        req.url.includes("graphql.anilist.co")
          ? { status: 200, body: JSON.stringify(anilistPage) }
          : { status: 404, body: "" },
    });
  });

  it("lists one series card per title at the top level and its volumes inside", () => {
    const top = call("/ether/v1/kinds/comics/browse", { limit: 50 });
    assert.equal(top.status, 200);
    const series = top.body.items as KindItem[];
    assert.deepEqual(
      series.map((s) => [s.id, s.level, s.title, s.childCount]),
      [
        ["al53390", "series", "Attack on Titan", 3],
        ["al1", "series", "Hitori", 1],
      ],
    );
    assert.ok(series.every((s) => !s.playable));

    const vols = call("/ether/v1/kinds/comics/browse", { parentId: "al53390", limit: 50 }).body
      .items as KindItem[];
    assert.deepEqual(
      vols.map((v) => [v.id, v.level, v.parentId, v.title, v.playable]),
      [
        ["al53390-v1", "volume", "al53390", "Attack on Titan Vol. 1", true],
        ["al53390-v2", "volume", "al53390", "Attack on Titan Vol. 2", true],
        ["al53390-v3", "volume", "al53390", "Attack on Titan Vol. 3", true],
      ],
    );

    // A title without a volume count is one book inside its series card.
    const one = call("/ether/v1/kinds/comics/browse", { parentId: "al1", limit: 50 }).body
      .items as KindItem[];
    assert.deepEqual(one.map((v) => [v.id, v.title]), [["al1-v1", "Hitori"]]);

    assert.equal(call("/ether/v1/kinds/comics/items/al53390", {}).body.title, "Attack on Titan");
    assert.equal(
      call("/ether/v1/kinds/comics/items/al53390-v2", {}).body.title,
      "Attack on Titan Vol. 2",
    );
  });

  it("accepts only the wanted volume of the wanted series", () => {
    const vols = call("/ether/v1/kinds/comics/browse", { parentId: "al53390", limit: 50 }).body
      .items as KindItem[];
    const v2 = vols[1];
    const cases: Array<[string, string]> = [
      ["Attack on Titan v02 (2012) (Digital) (danke-Empire).cbz", ""],
      ["Attack on Titan Vol. 2 (Digital)", ""],
      ["Attack on Titan 002 (Digital).cbz", ""],
      ["Attack on Titan - Before the Fall v02 (2017) (Digital).cbz", "volume number missing"],
      ["Attack on Titan Colossal Edition v02 (Digital)", "volume number missing"],
      ["Attack on Titan v02-v05 (Digital)", "several volumes"],
      ["Attack on Titan v03 (Digital).cbz", "different volume (3)"],
      ["Attack on Titan c008 (Digital)", "chapter release, not a volume"],
      ["Spoof Attack on Titan v02 (Digital)", "series title does not match"],
      ["Kodansha.-.Attack.On.Titan.02.2021.Hybrid.Comic.eBook-BitBook", ""],
      ["Kodansha.-.Attack.On.Titan.Before.The.Fall.02.2021.Hybrid.Comic.eBook-BitBook", "volume number missing"],
      ["Kodansha.-.Attack.On.Titan.03.2021.Hybrid.Comic.eBook-BitBook", "different volume (3)"],
    ];
    for (const [name, why] of cases) {
      assert.equal(comicsMatch(v2, name), why, name);
    }
    const best = comicsScore(v2, { title: cases[0][0], nzbUrl: "https://ix.test/1" });
    assert.equal(best.rejected, false);
    assert.ok(best.score > 0.9);
    assert.equal(comicsScore(v2, { title: cases[3][0] }).rejected, true);
  });

  it("searches the comics category and ranks the right volume first", () => {
    const queries: Array<{ query: string; category?: string }> = [];
    installMockHost({
      settings: { enable_manga: true, enable_mangaupdates: false, manga_titles: 20 },
      httpHandler: (req) =>
        req.url.includes("graphql.anilist.co")
          ? { status: 200, body: JSON.stringify(anilistPage) }
          : { status: 404, body: "" },
      sourcesHandler: (q) => {
        if (q.kind === "indexer_search") {
          queries.push({ query: String(q.query), category: q.category as string | undefined });
          return [
            { title: "Attack on Titan - Before the Fall v02 (2017) (Digital).cbz", nzbUrl: "https://ix.test/a", size: 9e7 },
            { title: "Attack on Titan v02 (2012) (Digital) (danke-Empire).cbz", nzbUrl: "https://ix.test/b", size: 2e8 },
          ];
        }
        return [];
      },
    });
    const vols = call("/ether/v1/kinds/comics/browse", { parentId: "al53390", limit: 50 }).body
      .items as KindItem[];
    const m = call("/ether/v1/kinds/comics/match", {
      item: vols[1],
      candidates: [
        { title: "Attack on Titan - Before the Fall v02 (2017) (Digital).cbz", nzbUrl: "https://ix.test/a" },
        { title: "Attack on Titan v02 (2012) (Digital) (danke-Empire).cbz", nzbUrl: "https://ix.test/b" },
      ],
    }).body.matches as Array<{ candidateRef: string; score: number }>;
    assert.ok(m[0].score > 0.9);
    assert.equal(m[1].score, 0);
    call("/ether/v1/kinds/comics/resolve", { item: vols[1] });
    assert.ok(queries.length > 0);
    assert.ok(queries.every((q) => q.category === "7030"), JSON.stringify(queries));
  });

  it("keeps searching when the first query finds only rejected releases", () => {
    const asked: string[] = [];
    installMockHost({
      settings: { enable_manga: true, enable_mangaupdates: false, manga_titles: 20 },
      httpHandler: (req) =>
        req.url.includes("graphql.anilist.co")
          ? { status: 200, body: JSON.stringify(anilistPage) }
          : { status: 404, body: "" },
      sourcesHandler: (q) => {
        if (q.kind !== "indexer_search") return [];
        asked.push(String(q.query));
        // "v02" finds only the spin-off; the publisher release answers "Series 2".
        if (String(q.query).endsWith("v02")) {
          return [1, 2, 3].map((n) => ({
            title: `Attack on Titan - Before the Fall v02 (2017) (Digital) (r${n}).cbz`,
            infoHash: String(n).repeat(40),
          }));
        }
        if (String(q.query).endsWith(" 2")) {
          return [
            { title: "Kodansha.-.Attack.On.Titan.02.2021.Hybrid.Comic.eBook-BitBook", infoHash: "c".repeat(40) },
          ];
        }
        return [];
      },
    });
    const vols = call("/ether/v1/kinds/comics/browse", { parentId: "al53390", limit: 50 }).body
      .items as KindItem[];
    call("/ether/v1/kinds/comics/resolve", { item: vols[1] });
    assert.ok(asked.length >= 2, `only searched ${JSON.stringify(asked)}`);
    assert.ok(asked.includes("Attack on Titan 2"), JSON.stringify(asked));
  });

  it("drops a cached pick the current matcher rejects and searches again", () => {
    let searched = 0;
    installMockHost({
      settings: { enable_manga: true, enable_mangaupdates: false, manga_titles: 20 },
      httpHandler: (req) =>
        req.url.includes("graphql.anilist.co")
          ? { status: 200, body: JSON.stringify(anilistPage) }
          : { status: 404, body: "" },
      sourcesHandler: (q) => {
        if (q.kind === "indexer_search") {
          searched++;
          return [
            { title: "Attack on Titan v02 (2012) (Digital) (danke-Empire).cbz", infoHash: "b".repeat(40), size: 2e8 },
          ];
        }
        return [];
      },
    });
    const vols = call("/ether/v1/kinds/comics/browse", { parentId: "al53390", limit: 50 }).body
      .items as KindItem[];
    // A pick an older matcher made and cached: the spin-off series.
    storePreparedSources(
      `src:volume:${vols[1].id}`,
      [
        {
          id: "old",
          label: "CBZ",
          pattern: "release",
          mime: "application/vnd.comicbook+zip",
          release: {
            infoHash: "a".repeat(40),
            candidate: { title: "Attack on Titan - Before the Fall v02 (2017) (Digital).cbz", infoHash: "a".repeat(40) },
          },
        },
      ],
      1800,
    );
    const res = call("/ether/v1/kinds/comics/resolve", { item: vols[1] }).body as {
      sources: Array<{ release?: { candidate?: { title?: string } } }>;
    };
    assert.ok(searched > 0, "the stale pick was reused instead of searching again");
    assert.ok(
      res.sources.every((x) => !/Before the Fall/.test(x.release?.candidate?.title || "")),
      JSON.stringify(res.sources),
    );
  });
});

