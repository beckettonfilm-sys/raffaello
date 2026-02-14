# Python → JS mapping (web-scraper_16.py → Electron)

- `read_labels_file` → `qobuzScraper/index.js::parseLabelsFile` (strict parser `Nazwa - URL`, comments/empty ignored, hard errors).
- `parse_pl_date` + prompt defaults → `parseInputConfig` (`FILES/plik_wejsciowy.txt`, defaults + validation + date swap warning).
- `extract_release_date_from_text`, month/numeric parsers → `extractReleaseDateFromText`, `parseEnglishMonthDate`, `parseNumericUsDate`.
- `extract_listing_release_date_for_link` (DOM climb, unique album link container) → `extractListingReleaseDateForLink`.
- Listing phase (`build_label_page_url`, `listing_has_page2`, strict listing date filter) → `buildLabelPageUrl`, `listingHasPage2`, `extractAlbumCandidatesFromListing`.
- Album phase (`parse_album_details`, title trimming ` by `, main artists, total length, album release date, first genre from about block) → `parseAlbumDetails`, `parseAlbumReleaseDate`, `parseAlbumFirstGenre`.
- Filter order (album page date mismatch → genre root → minimum length) → `runQobuzScraper` album loop in same order.
- Fallback date + missing report (`album_date_missing.txt`) → `missingRows` + file writer block.
- Deduplication (`norm_key` over `title+artists+label`) → `normalizeKey` + dedup set.
- Output files (`list_links.txt`, `title_artist_label.xlsx`, optional missing TSV) → `writeLinksTxt`, `writeXlsx`, missing write in `runQobuzScraper`.
- Retry/backoff (`429`, `5xx`, network issues, timeout) → `fetchHtml` with AbortController timeout + exponential backoff.
- Runtime stats/progress logs → `stats` object + console logs + Electron progress event `qobuz-scrape-progress`.