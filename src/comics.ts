// Comics and manga for ether.books: a third library, "Comics & Manga".
//
// One card per series at the top level; its volumes (manga) or issues
// (comics) sit inside it, like an album's tracks, each read like a book
// (CBZ, PDF, EPUB) and found through the owner's indexers in the comics
// category (7030 by default).
//
//   Manga, manhwa and manhua: AniList lists the titles (free, no key);
//   MangaUpdates fills in volume counts AniList leaves empty for ongoing series.
//   Western comics: Metron (free account), the owner's followed series and
//   the newest issues.

import { cacheGet, cachePut, fetchJson, nowSec } from "./cache.ts";
import { clampSummary, fnv1aHex, parseIsoDateToUnix, safeHttpsUrl, stripHtml } from "./text.ts";

const COMICS_ANILIST = "https://graphql.anilist.co";
const COMICS_MU = "https://api.mangaupdates.com/v1";
const COMICS_METRON = "https://metron.cloud/api";
// Sync calls run on the owner-granted deadline (hours by default); MangaUpdates
// answers a search in several seconds, so one sync does many lookups, once.
const COMICS_MU_LOOKUPS_PER_CALL = 60;
const COMICS_METRON_CALLS_PER_CALL = 40;
export function comicsEnabled(settings: any): any {
  return Boolean(
    settings.enableManga ||
    (settings.metronUser &&
      settings.metronPassword &&
      (settings.comicSeries.length > 0 || settings.comicNewWeeks > 0)),
  );
}
function comicsWords(s: any): any {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function comicsSig(settings: any): any {
  return fnv1aHex(
    [
      settings.enableManga,
      settings.mangaTitles,
      settings.mangaOrder,
      settings.includeAdultManga,
      settings.volumesPerSeries,
      settings.comicSeries.join("|"),
      settings.comicNewWeeks,
      Boolean(settings.metronUser),
    ].join("~"),
  );
}
function comicsAniList(query: any, variables: any, settings: any, cacheKey: any, ttl: any): any {
  return fetchJson<any>(COMICS_ANILIST, {
    provider: "anilist",
    settings,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    cacheKey,
    cacheTtlSec: ttl,
  });
}
const COMICS_MANGA_FIELDS =
  "id title{romaji english} synonyms countryOfOrigin status volumes chapters startDate{year} genres coverImage{extraLarge large} description(asHtml:false) averageScore isAdult staff(perPage:4,sort:RELEVANCE){edges{role node{name{full}}}}";
function comicsTypeOf(country: any): any {
  return country === "KR" ? "Manhwa" : country === "CN" || country === "TW" ? "Manhua" : "Manga";
}
function comicsMangaSeries(m: any): any {
  const title = String(m?.title?.romaji || m?.title?.english || "").trim();
  if (!m?.id || !title) return null;
  const english = String(m?.title?.english || "").trim();
  const aliases: any[] = [];
  for (const a of [english, ...(Array.isArray(m.synonyms) ? m.synonyms : [])]) {
    const s = String(a || "").trim();
    if (
      s &&
      /[a-z]{3}/i.test(s) &&
      s.toLowerCase() !== title.toLowerCase() &&
      !aliases.some((x: any) => x.toLowerCase() === s.toLowerCase()) &&
      aliases.length < 6
    )
      aliases.push(s);
  }
  const authors: any[] = [];
  for (const e of Array.isArray(m?.staff?.edges) ? m.staff.edges : []) {
    const role = String(e?.role || "");
    const name = String(e?.node?.name?.full || "").trim();
    if (
      name &&
      /story|art|original/i.test(role) &&
      !/assist/i.test(role) &&
      !authors.includes(name)
    )
      authors.push(name);
  }
  return {
    k: "manga",
    id: Number(m.id),
    // English readers search official English releases by their English title.
    t: english || title,
    aliases:
      english && english !== title
        ? [title, ...aliases.filter((a: any) => a !== english)].slice(0, 6)
        : aliases,
    cover: safeHttpsUrl(m?.coverImage?.extraLarge || m?.coverImage?.large) || "",
    genres: (Array.isArray(m.genres) ? m.genres : []).slice(0, 8),
    authors: authors.slice(0, 4),
    type: comicsTypeOf(m.countryOfOrigin),
    vols: Number(m.volumes) || 0,
    done: m.status === "FINISHED",
    year: Number(m?.startDate?.year) || 0,
    rating: Number(m.averageScore) || 0,
    sum: clampSummary(stripHtml(m.description || ""), 900),
    adult: Boolean(m.isAdult),
  };
}
// comicsMangaList reads the configured number of AniList titles, 50 a page.
function comicsMangaList(settings: any): any {
  const sort =
    settings.mangaOrder === "trending"
      ? "TRENDING_DESC"
      : settings.mangaOrder === "newest"
        ? "START_DATE_DESC"
        : "POPULARITY_DESC";
  const adultArg = settings.includeAdultManga ? "" : ",isAdult:false";
  const out: any[] = [];
  const pages = Math.max(1, Math.ceil(settings.mangaTitles / 50));
  for (let page = 1; page <= pages; page++) {
    const doc = comicsAniList(
      `query($page:Int,$sort:[MediaSort]){Page(page:$page,perPage:50){pageInfo{hasNextPage} media(type:MANGA${adultArg},sort:$sort,format_in:[MANGA,ONE_SHOT]){${COMICS_MANGA_FIELDS}}}}`,
      { page, sort: [sort] },
      settings,
      `comics:al:${sort}:${settings.includeAdultManga ? 1 : 0}:${page}`,
      12 * 3600,
    );
    const media = Array.isArray(doc?.data?.Page?.media) ? doc.data.Page.media : [];
    for (const m of media) {
      const s = comicsMangaSeries(m);
      if (s && out.length < settings.mangaTitles) out.push(s);
    }
    if (!doc?.data?.Page?.pageInfo?.hasNextPage || media.length === 0) break;
  }
  return out;
}
// comicsMuVolumes asks MangaUpdates how many volumes a series has ("30 Volumes (Complete)").
function comicsMuVolumes(series: any, settings: any): any {
  const key = `comics:muvol:${series.id}`;
  const hit = cacheGet<any>(key);
  if (hit !== null) return Number(hit) || 0;
  let vols = 0;
  for (const q of [series.t, ...series.aliases].slice(0, 2)) {
    const found = fetchJson<any>(`${COMICS_MU}/series/search`, {
      provider: "mangaupdates",
      settings,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ search: q, perpage: 5 }),
    });
    const results = Array.isArray(found?.results) ? found.results : [];
    const want = comicsWords(q);
    const hitRec = results
      .map((r: any) => r?.record)
      .find((r: any) => r && comicsWords(r.title) === want);
    if (!hitRec?.series_id) continue;
    const detail = fetchJson<any>(`${COMICS_MU}/series/${hitRec.series_id}`, {
      provider: "mangaupdates",
      settings,
    });
    const m = /(\d+)\s+volumes?/i.exec(String(detail?.status || ""));
    if (m) vols = Number(m[1]) || 0;
    break;
  }
  cachePut(key, vols, vols > 0 ? 7 * 86400 : 86400);
  return vols;
}
function comicsMetron(path: any, settings: any): any {
  if (!settings.metronUser || !settings.metronPassword) return null;
  const auth = "Basic " + btoaSafe(`${settings.metronUser}:${settings.metronPassword}`);
  return fetchJson<any>(`${COMICS_METRON}${path}`, {
    provider: "metron",
    settings,
    headers: { Authorization: auth, Accept: "application/json" },
  });
}
function btoaSafe(s: any): any {
  try {
    return btoa(unescape(encodeURIComponent(s)));
  } catch {
    return btoa(s);
  }
}
function comicsIssueRow(r: any): any {
  if (!r?.id) return null;
  return {
    id: Number(r.id),
    num: String(r.number || "").trim(),
    name: Array.isArray(r.name) ? String(r.name[0] || "") : "",
    date: String(r.store_date || r.cover_date || ""),
    img: safeHttpsUrl(r.image) || "",
    series: String(r?.series?.name || "").trim(),
    vol: Number(r?.series?.volume) || 0,
    began: Number(r?.series?.year_began) || 0,
    sid: Number(r?.series?.id) || 0,
  };
}
// comicsMetronList reads the followed series' newest issues and the newest
// issues overall. Each series lookup and issue list is cached, so a budget
// of requests per call fills the list over a few syncs without waiting.
function comicsMetronList(settings: any): any {
  if (!settings.metronUser || !settings.metronPassword) return [];
  let calls = 0;
  const out: any[] = [];
  for (const want of settings.comicSeries) {
    const m = /^(.*?)\s*\((\d{4})\)\s*$/.exec(want);
    const name = (m ? m[1] : want).trim();
    const year = m ? Number(m[2]) : 0;
    const sKey = `comics:mtseries:${comicsWords(want)}`;
    let series = cacheGet<any>(sKey);
    if (series === null) {
      if (calls >= COMICS_METRON_CALLS_PER_CALL) continue;
      calls++;
      const doc = comicsMetron(`/series/?name=${encodeURIComponent(name)}`, settings);
      const rows = Array.isArray(doc?.results) ? doc.results : [];
      const exact = rows.filter(
        (r: any) =>
          comicsWords(
            String(r?.series || r?.display_name || r?.name || "").replace(/\(\d{4}\)/, ""),
          ) === comicsWords(name),
      );
      const pool = exact.length ? exact : rows;
      const pick = year
        ? pool.find((r: any) => Number(r?.year_began) === year) || pool[0]
        : pool.sort(
            (a: any, b: any) => (Number(b?.year_began) || 0) - (Number(a?.year_began) || 0),
          )[0];
      series = pick?.id
        ? {
            id: Number(pick.id),
            name: String(pick.series || pick.display_name || pick.name || name).replace(
              /\s*\(\d{4}\)\s*$/,
              "",
            ),
            began: Number(pick.year_began) || 0,
          }
        : { none: true };
      cachePut(sKey, series, 7 * 86400);
    }
    if (!series || series.none) continue;
    const iKey = `comics:mtissues:${series.id}`;
    let issues = cacheGet<any>(iKey);
    if (issues === null) {
      if (calls >= COMICS_METRON_CALLS_PER_CALL) continue;
      calls++;
      // A long series spans several pages; follow them within the request budget.
      issues = [];
      let path = `/issue/?series_id=${series.id}`;
      for (let pg = 0; path && pg < 6 && calls <= COMICS_METRON_CALLS_PER_CALL; pg++) {
        if (pg > 0) calls++;
        const doc = comicsMetron(path, settings);
        issues.push(
          ...(Array.isArray(doc?.results) ? doc.results : []).map(comicsIssueRow).filter(Boolean),
        );
        const next = typeof doc?.next === "string" ? doc.next : "";
        path = next.startsWith(COMICS_METRON) ? next.slice(COMICS_METRON.length) : "";
      }
      cachePut(iKey, issues, 12 * 3600);
    }
    const newest = issues
      .slice()
      .sort((a: any, b: any) => (b.date || "").localeCompare(a.date || ""))
      .slice(0, settings.volumesPerSeries);
    for (const i of newest)
      out.push({ ...i, series: i.series || series.name, began: i.began || series.began });
  }
  if (settings.comicNewWeeks > 0) {
    const after = new Date(Date.now() - settings.comicNewWeeks * 7 * 86400 * 1e3)
      .toISOString()
      .slice(0, 10);
    const nKey = `comics:mtnew:${after}`;
    let fresh = cacheGet<any>(nKey);
    if (fresh === null && calls < COMICS_METRON_CALLS_PER_CALL) {
      calls++;
      const doc = comicsMetron(`/issue/?store_date_range_after=${after}`, settings);
      fresh = (Array.isArray(doc?.results) ? doc.results : []).map(comicsIssueRow).filter(Boolean);
      cachePut(nKey, fresh, 6 * 3600);
    }
    for (const i of fresh || []) if (!out.some((x: any) => x.id === i.id)) out.push(i);
  }
  return out;
}
// comicsCatalog is the compact list behind the library, rebuilt at most every few hours.
// quick (an item detail call, which has a short deadline) never waits on
// MangaUpdates or Metron and does not store what it built.
function comicsCatalog(settings: any, quick: any): any {
  const key = `comics:catalog:${comicsSig(settings)}`;
  const hit = cacheGet<any>(key);
  if (hit !== null && Array.isArray(hit.manga)) return hit;
  const started = Date.now();
  const manga = settings.enableManga ? comicsMangaList(settings) : [];
  let lookups = 0;
  let missing = 0;
  for (const s of manga) {
    if (s.vols > 0) continue;
    if (
      !quick &&
      settings.enableMangaUpdates &&
      lookups < COMICS_MU_LOOKUPS_PER_CALL &&
      Date.now() - started < 6 * 60e3
    ) {
      const cachedVols = cacheGet<any>(`comics:muvol:${s.id}`);
      if (cachedVols === null) lookups++;
      s.vols = comicsMuVolumes(s, settings);
    }
    if (!s.vols) missing++;
  }
  const comics = quick ? [] : comicsMetronList(settings);
  const catalog = { manga, comics, at: nowSec() };
  if (quick) return catalog;
  // A list still waiting on volume counts is kept briefly so the next sync completes it.
  cachePut(key, catalog, missing > 0 && settings.enableMangaUpdates ? 600 : 4 * 3600);
  return catalog;
}
export function comicsMangaItems(s: any, settings: any): any {
  const total = Math.max(1, s.vols || 1);
  const count = Math.min(total, settings.volumesPerSeries);
  const items: any[] = [];
  for (let n = 1; n <= count; n++) {
    const title = s.vols ? `${s.t} Vol. ${n}` : s.t;
    const fields: any = {
      series: s.t,
      series_number: String(n),
      authors: s.authors.map((name: any) => ({ name })),
      type: s.type,
      source: s.vols && !s.done ? "MangaUpdates" : "AniList",
      format: "CBZ",
      language: "English",
    };
    if (s.genres.length) fields.genres = s.genres;
    const item: any = {
      id: `al${s.id}-v${n}`,
      level: "volume",
      parentId: `al${s.id}`,
      playable: true,
      title,
      index: n,
      etag: fnv1aHex(`${s.id}|${n}|${s.vols}|${s.t}|${s.cover}`),
      fields,
      hints: {
        kind: "comics",
        ctype: "manga",
        title,
        series: s.t,
        aliases: s.aliases,
        volume: n,
        volumes: s.vols,
        year: s.year,
        authors: s.authors,
      },
    };
    if (s.year) item.year = s.year;
    if (s.sum) item.summary = s.sum;
    if (s.rating) item.rating = Math.round(s.rating) / 10;
    if (s.cover)
      item.art = [
        { role: "poster", url: s.cover },
        { role: "thumb", url: s.cover },
      ];
    items.push(item);
  }
  return items;
}
function comicsIssueItem(i: any): any {
  if (!i.series || !i.num) return null;
  const seriesLabel = i.began ? `${i.series} (${i.began})` : i.series;
  const title = `${i.series} #${i.num}`;
  const fields: any = {
    series: seriesLabel,
    series_number: i.num,
    type: "Comic",
    source: "Metron",
    format: "CBZ",
    language: "English",
  };
  if (i.date) fields.release_date = i.date;
  const item: any = {
    id: `mt${i.id}`,
    level: "volume",
    parentId: comicsIssueSeriesId(i),
    playable: true,
    title,
    index: Number.parseFloat(i.num) || 0,
    etag: fnv1aHex(`${i.id}|${i.num}|${i.date}|${i.img}`),
    fields,
    hints: {
      kind: "comics",
      ctype: "comic",
      title,
      series: i.series,
      aliases: [],
      issue: i.num,
      year: i.began,
    },
  };
  if (i.name) item.summary = i.name;
  const y = Number((i.date || "").slice(0, 4));
  if (y) item.year = y;
  const ts = parseIsoDateToUnix(i.date);
  if (ts) item.released = ts;
  if (i.img)
    item.art = [
      { role: "poster", url: i.img },
      { role: "thumb", url: i.img },
    ];
  return item;
}
// ---- series: the top level, one card per manga or comic series ----
function comicsIssueSeriesId(i: any): any {
  return i.sid ? `mts${i.sid}` : `mts-${fnv1aHex(`${i.series}|${i.began}`)}`;
}
export function comicsMangaSeriesItem(s: any, settings: any): any {
  const count = s.vols ? Math.min(s.vols, settings.volumesPerSeries) : 1;
  const fields: any = {
    series: s.t,
    authors: s.authors.map((name: any) => ({ name })),
    type: s.type,
    source: s.vols && !s.done ? "MangaUpdates" : "AniList",
    format: "CBZ",
    language: "English",
  };
  if (s.genres.length) fields.genres = s.genres;
  const item: any = {
    id: `al${s.id}`,
    level: "series",
    title: s.t,
    childCount: count,
    leafCount: count,
    etag: fnv1aHex(`${s.id}|${s.vols}|${s.t}|${s.cover}|${count}`),
    fields,
    hints: {
      kind: "comics",
      ctype: "manga",
      series: s.t,
      aliases: s.aliases,
      volumes: s.vols,
      year: s.year,
      authors: s.authors,
    },
  };
  if (s.year) item.year = s.year;
  if (s.sum) item.summary = s.sum;
  if (s.rating) item.rating = Math.round(s.rating) / 10;
  if (s.cover)
    item.art = [
      { role: "poster", url: s.cover },
      { role: "thumb", url: s.cover },
    ];
  return item;
}
export function comicsIssueSeriesItems(issues: any): any {
  const groups = new Map<string, any>();
  for (const i of issues) {
    if (!i.series || !i.num) continue;
    const id = comicsIssueSeriesId(i);
    const g = groups.get(id) || { id, list: [] };
    g.list.push(i);
    groups.set(id, g);
  }
  const out: any[] = [];
  for (const g of groups.values()) {
    g.list.sort(
      (a: any, b: any) => (Number.parseFloat(b.num) || 0) - (Number.parseFloat(a.num) || 0),
    );
    const newest = g.list[0];
    const label = newest.began ? `${newest.series} (${newest.began})` : newest.series;
    const item: any = {
      id: g.id,
      level: "series",
      title: label,
      childCount: g.list.length,
      leafCount: g.list.length,
      etag: fnv1aHex(`${g.id}|${g.list.map((i: any) => i.id).join(",")}|${newest.img}`),
      fields: {
        series: label,
        type: "Comic",
        source: "Metron",
        format: "CBZ",
        language: "English",
      },
      hints: {
        kind: "comics",
        ctype: "comic",
        series: newest.series,
        aliases: [],
        year: newest.began,
      },
    };
    if (newest.began) item.year = newest.began;
    const ts = parseIsoDateToUnix(newest.date);
    if (ts) item.released = ts;
    if (newest.img)
      item.art = [
        { role: "poster", url: newest.img },
        { role: "thumb", url: newest.img },
      ];
    out.push(item);
  }
  return out;
}
export function comicsSeriesItems(settings: any, quick: any = false): any {
  const cat = comicsCatalog(settings, quick);
  return [
    ...cat.manga.map((s: any) => comicsMangaSeriesItem(s, settings)),
    ...comicsIssueSeriesItems(cat.comics),
  ];
}
export function comicsChildren(parentId: any, settings: any): any {
  return comicsAllItems(settings, true)
    .filter((x: any) => x.parentId === parentId)
    .sort((a: any, b: any) => a.index - b.index);
}
export function comicsAllItems(settings: any, quick: any = false): any {
  const cat = comicsCatalog(settings, quick);
  const out: any[] = [];
  for (const s of cat.manga) out.push(...comicsMangaItems(s, settings));
  for (const i of cat.comics) {
    const item = comicsIssueItem(i);
    if (item) out.push(item);
  }
  return out;
}
export function comicsItemDetail(id: any, settings: any): any {
  if (!/-v\d+$/.test(id) && !/^mt\d+$/.test(id)) {
    const series = comicsSeriesItems(settings, true).find((x: any) => x.id === id);
    if (series) return series;
  }
  return comicsAllItems(settings, true).find((x: any) => x.id === id) || null;
}
// ---- release matching ----
export function isComicsItem(item: any): any {
  return item?.hints?.kind === "comics";
}
export function comicsQueries(item: any): any {
  const h = item.hints || {};
  const out: any[] = [];
  const add = (q: any) => {
    const s = String(q || "")
      .replace(/[:"'?!()#]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (s && !out.some((x: any) => x.toLowerCase() === s.toLowerCase()) && out.length < 4)
      out.push(s);
  };
  if (h.ctype === "comic") {
    add(`${h.series} ${String(h.issue).padStart(3, "0")}`);
    add(`${h.series} ${h.issue}`);
    return out;
  }
  if (h.volumes > 0) {
    add(`${h.series} v${String(h.volume).padStart(2, "0")}`);
    // Publisher releases are named "Kodansha - Series 13 (2021)".
    add(`${h.series} ${h.volume}`);
    // VIZ and other official releases are named "Series Vol.05".
    add(`${h.series} Vol ${String(h.volume).padStart(2, "0")}`);
  }
  add(h.series);
  for (const a of h.aliases || []) {
    if (h.volumes > 0) add(`${a} v${String(h.volume).padStart(2, "0")}`);
  }
  return out;
}
// comicsMatch returns "" when releaseName is this volume or issue, otherwise why not.
// Publishers that lead official digital release names ("Kodansha - ...").
const COMICS_PUBLISHER_PREFIX =
  /^ (kodansha( comics| usa)?|yen press|viz( media)?|seven seas( entertainment)?|dark horse( comics| manga)?|square enix( manga)?|vertical( comics)?|tokyopop|j novel club|ghost ship|udon( entertainment)?|denpa|one peace( books)?|titan( comics| manga)?|marvel( comics)?|dc( comics)?|image( comics)?|boom( studios)?|idw( publishing)?|webtoon|tappytoon|manta|tapas|ize press|azuki|inky pen|kodansha comics) /;

export function comicsMatch(item: any, releaseName: any): any {
  const h = item.hints || {};
  let name =
    " " +
    comicsWords(
      String(releaseName || "")
        .replace(/\[[^\]]*\]/g, " ")
        .replace(/\([^)]*\)/g, " "),
    ) +
    " ";
  if (!name.trim()) return "empty release title";
  // Official digital releases often lead with the publisher:
  // "Kodansha - Attack on Titan 13 (2021)". Only known publishers are skipped,
  // so another series in front still fails the series-first rule below.
  name = name.replace(COMICS_PUBLISHER_PREFIX, " ");
  let rest = "";
  let found = false;
  for (const t of [h.series, ...(h.aliases || [])]) {
    const w = comicsWords(t);
    if (!w) continue;
    // The series starts the release name: "Attack on Titan v12", never
    // "Attack on Titan - Before the Fall v12" (another series).
    const at = name.indexOf(" " + w + " ");
    if (at === 0) {
      rest = name.slice(at + w.length + 2);
      found = true;
      break;
    }
  }
  if (!found) return "series title does not match";
  const toks = rest.split(" ").filter(Boolean);
  if (h.ctype === "comic") {
    let i = 0;
    if (toks[i] && /^v\d{1,2}$/.test(toks[i])) i++;
    if (toks[i] && /^(annual|special|tpb|hc|omnibus)$/.test(toks[i])) return "not a single issue";
    const n = toks[i] && /^\d{1,4}$/.test(toks[i]) ? Number(toks[i]) : NaN;
    if (Number.isNaN(n)) return "issue number missing";
    if (n !== Number.parseFloat(String(h.issue))) return `different issue (${n})`;
    if (toks[i + 1] && /^\d{1,4}$/.test(toks[i + 1])) return "several issues";
    return "";
  }
  if (toks.some((t: any) => /^c\d{2,4}$/.test(t) || t === "chapter" || t === "ch"))
    return "chapter release, not a volume";
  if (!(h.volumes > 0))
    return toks.length === 0 || !/^v?\d/.test(toks[0])
      ? ""
      : "volume of a series listed as one book";
  let n = NaN;
  let next = "";
  // The volume follows the series directly ("v12", "vol 12", "012"):
  // words in between name a different series or a spin-off.
  for (let i = 0; i < toks.length && i < 1; i++) {
    const t = toks[i];
    let m = /^v(?:ol)?(\d{1,3})$/.exec(t);
    if (m) {
      n = Number(m[1]);
      next = toks[i + 1] || "";
      break;
    }
    if ((t === "vol" || t === "volume" || t === "v") && /^\d{1,3}$/.test(toks[i + 1] || "")) {
      n = Number(toks[i + 1]);
      next = toks[i + 2] || "";
      break;
    }
    if (/^\d{1,3}$/.test(t) && i === 0) {
      n = Number(t);
      next = toks[i + 1] || "";
      break;
    }
  }
  if (Number.isNaN(n)) return "volume number missing";
  if (/^v?\d{1,3}$/.test(next)) return "several volumes";
  if (n !== Number(h.volume)) return `different volume (${n})`;
  return "";
}
export function comicsScore(item: any, cand: any): any {
  const title = String(cand.title || "");
  const why = comicsMatch(item, title);
  if (why) return { score: 0.05, rejected: true, reasons: [why] };
  let score = 0.78;
  const reasons = [
    item.hints.ctype === "comic" ? "series and issue match" : "series and volume match",
  ];
  if (/\bcbz\b/i.test(title)) {
    score += 0.06;
    reasons.push("CBZ");
  } else if (/\bcbr\b/i.test(title)) {
    score -= 0.1;
    reasons.push("CBR cannot be read in Ether, a CBZ is needed");
  }
  if (/\bdigital\b/i.test(title)) {
    score += 0.04;
    reasons.push("digital release");
  }
  if (cand.cached) {
    score += 0.06;
    reasons.push("debrid cached");
  } else if (cand.nzbUrl) {
    score += 0.04;
    reasons.push("usenet nzb");
  }
  const clamped = Math.max(0, Math.min(1, Math.round(score * 1e3) / 1e3));
  return { score: clamped, rejected: clamped < 0.45, reasons };
}
