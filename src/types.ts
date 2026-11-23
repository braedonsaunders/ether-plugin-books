// Core TypeScript declarations for Ether's hosted QuickJS plugin runtime and
// the ether.books catalog/resolver domain model.

export interface EtherHttpRequest {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface EtherHttpResponse {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

export interface ReleaseFile {
  index: number;
  path: string;
  size: number;
}

export interface UsenetCheckResult {
  available: boolean;
  checked: number;
  missing: number;
  cached?: boolean;
  playbackFailed?: boolean;
  reason?: string;
  checkedAt?: number;
}

export interface SourceCandidate {
  infoHash?: string;
  magnet?: string;
  nzbUrl?: string;
  fileIndex?: number;
  title?: string;
  size?: number;
  seeders?: number;
  cached?: boolean;
  indexer?: string;
  indexerId?: string;
  score?: number;
  resolution?: number;
  source?: string;
  codec?: string;
  files?: ReleaseFile[];
  usenetCheck?: UsenetCheckResult;
}

export interface SourceQuery {
  kind: "indexer_search" | "debrid_check" | "release_files" | "usenet_check";
  query?: string;
  category?: string;
  profile?: string;
  infoHashes?: string[];
  infoHash?: string;
  magnet?: string;
  nzbUrl?: string;
  candidate?: SourceCandidate;
}

export interface EtherHost {
  log: (...args: unknown[]) => void;
  abort: (msg?: string) => never;
  runtime: {
    limits: () => Record<string, unknown>;
  };
  kv: {
    get: (key: string) => string | null;
    put: (key: string, value: string) => void;
    delete: (key: string) => void;
    list: (prefix?: string) => string[];
    usage: () => {
      bytes: number;
      keys: number;
      quotaBytes: number;
      quotaKeys: number;
    };
  };
  settings: {
    get: () => Record<string, unknown>;
  };
  secret: {
    get: (name: string) => string | null;
  };
  http: {
    fetch: (req: EtherHttpRequest) => EtherHttpResponse;
  };
  sources: {
    resolve: (q: SourceQuery) => { candidates: SourceCandidate[] };
  };
  kinds: {
    upsert: (kind: string, items: KindItem[]) => { accepted: number };
    delete: (kind: string, ids: string[]) => void;
    items: (kind: string, cursor?: string, limit?: number) => KindPage;
  };
}

declare global {
  // eslint-disable-next-line no-var
  var ether: EtherHost;
}

export interface PluginRequest {
  method: string;
  path: string;
  query?: Record<string, string[]>;
  headers?: Record<string, string>;
  body?: string;
}

export interface PluginResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

export interface KindArtRef {
  role: "poster" | "thumb" | "backdrop" | "logo" | string;
  url: string;
  width?: number;
  height?: number;
}

export interface PersonCredit {
  name: string;
  role?: string;
  thumb?: string;
}

export interface KindItemPart {
  name: string;
  mime?: string;
  size?: number;
  durationSec?: number;
}

export interface BookDirectSource {
  url: string;
  mime: string;
  format: "epub" | "pdf" | "cbz" | "m4b" | "mp3";
  label?: string;
  size?: number;
  durationSec?: number;
}

export interface ItemHints {
  kind: "books" | "audiobooks";
  source: BookSource | AudiobookSource;
  sourceId: string;
  title: string;
  authors: string[];
  narrators?: string[];
  series?: string;
  seriesNumber?: string;
  year?: number;
  isbn?: string;
  isbn13?: string;
  asin?: string;
  durationSec?: number;
  unabridged?: boolean;
  language?: string;
  preferredFormat?: string;
  directSources?: BookDirectSource[];
  parts?: KindItemPart[];
  partUrls?: string[];
}

export interface KindItem {
  id: string;
  level: "book" | "audiobook";
  parentId?: string;
  index?: number;
  title: string;
  sortTitle?: string;
  summary?: string;
  year?: number;
  released?: number;
  rating?: number;
  playable: boolean;
  art?: KindArtRef[];
  fields: Record<string, unknown>;
  hints: ItemHints;
  etag?: string;
}

export interface KindPage {
  items: KindItem[];
  nextCursor?: string;
  total?: number;
}

export interface KindBrowseRequest {
  parentId?: string;
  level?: string;
  cursor?: string;
  limit?: number;
  sort?: string;
  desc?: boolean;
  facets?: Record<string, string[]>;
  query?: string;
}

export interface KindExpandRequest {
  facet: string;
  value: string;
  valueId?: number;
  cursor?: string;
}

export interface KindExpandResponse {
  items: KindItem[];
  cursor?: string;
}

export interface KindChangePage {
  upserts?: KindItem[];
  deletes?: string[];
  nextCursor?: string;
  complete: boolean;
}

export interface ReleaseHint {
  fileIndex?: number;
  nzbUrl?: string;
  magnet?: string;
  infoHash?: string;
  candidate?: SourceCandidate;
  file?: string;
  fileHint?: string;
}

export interface PlayableSource {
  id: string;
  label?: string;
  pattern: "range" | "download" | "direct" | "release";
  mime: string;
  size?: number;
  durationSec?: number;
  url?: string;
  headers?: Record<string, string>;
  release?: ReleaseHint;
}

export interface KindResolveRequest {
  libraryKey?: string;
  item: KindItem;
  partIndex?: number;
  client?: Record<string, unknown>;
}

export interface KindResolveResponse {
  pending?: boolean;
  retryInMs?: number;
  job?: string;
  sources: PlayableSource[];
  ttlSec?: number;
}

export interface KindMatchRequest {
  item: KindItem;
  candidates: SourceCandidate[];
  settings?: Record<string, unknown>;
}

export interface KindMatchScore {
  candidateRef: string;
  score: number;
  reasons?: string[];
}

export interface KindMatchResponse {
  pending?: boolean;
  retryInMs?: number;
  job?: string;
  matches: KindMatchScore[];
}

export type BookSource = "hardcover" | "openlibrary" | "standard-ebooks" | "gutenberg";
export type AudiobookSource = "hardcover" | "audible" | "librivox" | "openlibrary";
export type LengthBucket = "Under 6 hours" | "6 to 12 hours" | "12 to 20 hours" | "Over 20 hours";

export interface NormalizedEntry {
  kind: "books" | "audiobooks";
  source: BookSource | AudiobookSource;
  sourceId: string;
  title: string;
  subtitle?: string;
  summary?: string;
  year?: number;
  released?: number;
  releaseDate?: string;
  rating?: number; // 0..10 scale
  authors: PersonCredit[];
  narrators?: PersonCredit[];
  series?: string;
  seriesIndex?: number;
  seriesNumber?: string;
  genres: string[];
  awards?: string[];
  curated: string[];
  publisher?: string;
  isbn?: string;
  isbn13?: string;
  asin?: string;
  pages?: number;
  durationSec?: number;
  unabridged?: boolean;
  format?: "epub" | "pdf" | "cbz" | "m4b" | "mp3";
  language?: string;
  coverUrl?: string;
  backdropUrl?: string;
  directSources?: BookDirectSource[];
  parts?: KindItemPart[];
  partUrls?: string[];
}

export interface PluginSettings {
  hardcoverToken: string;
  enableOpenLibrary: boolean;
  enableAudibleMetadata: boolean;
  enableStandardEbooks: boolean;
  enableLibriVox: boolean;
  enableGutenberg: boolean;
  language: "en" | "any";
  catalogSize: "compact" | "standard" | "large";
  ebookCategories: string;
  audiobookCategories: string;
  preferUnabridged: boolean;
  preferCached: boolean;
  contactEmail: string;
  // Comics & Manga (comics.ts)
  enableManga: boolean;
  mangaTitles: number;
  mangaOrder: string;
  includeAdultManga: boolean;
  enableMangaUpdates: boolean;
  volumesPerSeries: number;
  metronUser: string;
  metronPassword: string;
  comicSeries: string[];
  comicNewWeeks: number;
  comicsCategories: string;
}
