# Books and audiobooks (`ether.books`)

Ether content plugin providing dedicated **Books** (`media: "book"`), **Audiobooks** (`media: "audiobook"`) and **Comics & Manga** (`media: "book"`) libraries.

## Features

- **Curated Home shelves**: Popular this week, New and notable, Award winners, Series to start, genre shelves, Free classics, Quick listens (<6h), Epic listens (20h+), and Top rated.
- **Rich browse tabs**: Home, Browse, Authors, Narrators (Audiobooks), Series (ordered by book index), Genres, Awards (Books), By length (Audiobooks), Free classics, History, and To read / To listen.
- **Zero-config public catalogs + optional Hardcover enrichment**:
  - Open Library for trending books, curated subjects, author portraits, and live search.
  - Audible public catalog API (metadata only) for audiobook editions, narrators, runtimes, unabridged flags, series order, and square artwork.
  - Standard Ebooks for carefully typeset, direct-download public-domain EPUBs.
  - LibriVox for free public-domain audiobooks with multi-part chapter MP3 playback (`hints.parts`).
  - Optional Hardcover API token (`hardcover_token`) for community ratings, trending reads, awards, and series catalogs.
- **Strict release matching**:
  - Prefers direct public-domain files when available.
  - Searches configured Ether indexers (`7000,7020` for books, `3030` for audiobooks), checks debrid cache, inspects `release_files` to select exact `.epub` / `.cbz` / `.pdf` or `.m4b` / ordered `.mp3` files with explicit `file` / `fileIndex` / `fileHint`, and rejects abridged releases when unabridged editions are requested.
  - Supports `/ether/job/prepare` slow resolution when deep file inspection exceeds the 5-second `/resolve` deadline.
- **Comics & Manga library** (optional, on by default for manga):
  - One card per series; its volumes (manga) or issues (comics) sit inside it, like an album's tracks. Jellyfin and Emby show a series as a Series with its books inside.
  - Manga, manhwa and manhua from AniList (no key), with volume counts for ongoing series filled in from MangaUpdates.
  - Western comics from Metron (free account: `metron_username` and the `metron_password` secret): the series you follow and the newest issues.
  - Volumes are found through Ether's indexers in the comics category (`7030` by default). A release must start with the series name and give the wanted volume right after it, so spin-offs ("Attack on Titan - Before the Fall v12"), other editions, multi-volume packs and chapter releases are rejected.
- **Incremental sync (`/changes`) & live facet expansion (`/expand`)**:
  - Keeps searched, expanded, and read/listened titles alive across syncs and hydrates full author, narrator, series, and genre catalogs on demand.

## Releasing

1. Bump `version` in `manifest.json`. Set `MIN_ETHER` to the oldest Ether release the new version needs. Optionally add a `## <version>` section to `CHANGELOG.md`.
2. Commit, then tag it: `git tag v<version> && git push origin v<version>`.
3. CI checks, tests and packs the plugin, and attaches `<id>-<version>.etherpkg` to a GitHub release.
4. The [ether-plugins](https://github.com/braedonsaunders/ether-plugins) marketplace picks up the release within the hour and opens a PR adding the version. Merge it, and Ether offers the update to every server that has the plugin installed.
