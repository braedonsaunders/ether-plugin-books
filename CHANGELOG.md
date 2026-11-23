# Changelog

## 1.1.0

- New **Comics & Manga** library: one card per series with its volumes or issues inside. Manga, manhwa and manhua come from AniList (volume counts for ongoing series from MangaUpdates); western comics from Metron with a free account. Volumes are found through Ether's indexers in the comics category (7030) and read as CBZ, PDF or EPUB.
- Comics release matching requires the series name at the start and the wanted volume right after it, so spin-offs, other editions, multi-volume packs and chapter releases are rejected.
- New settings group "Comics & Manga"; new network hosts `graphql.anilist.co`, `api.mangaupdates.com` and `metron.cloud`; new secret `metron_password`.
