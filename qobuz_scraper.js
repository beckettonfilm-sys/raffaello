const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");
const Bottleneck = require("bottleneck");
const { fetch } = require("undici");
const XLSX = require("xlsx");
const { formatRunTimestamp, atomicWriteFile, validateXlsx, ensureDir } = require("./output_files");
const { RunTiming } = require("./run_timing");
const { abortableSleep, throwIfAborted } = require("./abort_utils");

const DEFAULTS = {
  date_from: "01.01.2020",
  date_to: "31.12.2030",
  min_minutes: 15,
  delay_listing: 0.35,
  delay_album: 0.55,
  max_pages_per_label: 2,
  retries: 3,
  timeout_ms: 20000,
  genre_root: "Classical",
  accept_language: "en-US,en;q=0.9",
  user_agent: "ElectronQobuzScraper/1.0",
};

const OUTPUT_BASES = {
  linksTxt: "list_links",
  xlsx: "title_artist_label",
  missingDatesTxt: "album_date_missing",
  checkpoint: "qobuz_checkpoint",
  logTxt: "download_nr_log",
  reportTxt: "download_nr_report",
  reportJson: "download_nr_report"
};

function makeError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function sleep(ms, signal, session) {
  return abortableSleep(ms, signal, session);
}

function parsePlDate(text, fieldName) {
  const value = String(text || "").trim();
  const m = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) {
    throw makeError("INVALID_DATE_FORMAT", `Nieprawidłowy format daty dla ${fieldName}. Oczekiwano DD.MM.RRRR.`, {
      field: fieldName,
      value
    });
  }
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    throw makeError("INVALID_DATE_FORMAT", `Nieprawidłowa data kalendarzowa dla ${fieldName}: ${value}`, {
      field: fieldName,
      value
    });
  }
  return d;
}

function formatPlDate(dateValue) {
  const day = String(dateValue.getUTCDate()).padStart(2, "0");
  const month = String(dateValue.getUTCMonth() + 1).padStart(2, "0");
  const year = dateValue.getUTCFullYear();
  return `${day}.${month}.${year}`;
}

function normalizeMonthToken(s) {
  return s.replace(/\./g, "");
}

function parseEnglishMonthDate(text) {
  let s = String(text || "").trim().replace(/\s+/g, " ");
  if (!s) return null;
  s = s.replace(/^Sept\s/i, "Sep ");
  const idx = s.indexOf(" ");
  if (idx > -1) {
    s = `${normalizeMonthToken(s.slice(0, idx))}${s.slice(idx)}`;
  }

  const m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  const month = m[1].slice(0, 3).toLowerCase();
  const map = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };
  if (map[month] === undefined) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  const d = new Date(Date.UTC(year, map[month], day));
  if (d.getUTCMonth() !== map[month] || d.getUTCDate() !== day || d.getUTCFullYear() !== year) return null;
  return d;
}

function parseNumericUsDate(text) {
  const s = String(text || "").trim().replace(/\s+/g, " ");
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const variants = [
    { month: Number(m[1]), day: Number(m[2]), year: Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]) },
    { month: Number(m[2]), day: Number(m[1]), year: Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]) }
  ];
  for (const v of variants) {
    const d = new Date(Date.UTC(v.year, v.month - 1, v.day));
    if (d.getUTCFullYear() === v.year && d.getUTCMonth() === v.month - 1 && d.getUTCDate() === v.day) return d;
  }
  return null;
}

const RELEASE_PATTERNS_MONTH = [
  /\bReleased by .*? on ([A-Za-z.]+ \d{1,2}, \d{4})/i,
  /\bReleased on ([A-Za-z.]+ \d{1,2}, \d{4})/i,
  /\bTo be released on ([A-Za-z.]+ \d{1,2}, \d{4})/i
];

const RELEASE_PATTERNS_NUM = [
  /\bReleased by .*? on (\d{1,2}\/\d{1,2}\/\d{2,4})/i,
  /\bReleased on (\d{1,2}\/\d{1,2}\/\d{2,4})/i,
  /\bTo be released on (\d{1,2}\/\d{1,2}\/\d{2,4})/i
];

function extractReleaseDateFromText(text) {
  if (!text) return null;
  const normalized = String(text).replace(/\s+/g, " ").trim();
  for (const rx of RELEASE_PATTERNS_MONTH) {
    const match = normalized.match(rx);
    if (match) {
      const parsed = parseEnglishMonthDate(match[1]);
      if (parsed) return parsed;
    }
  }
  for (const rx of RELEASE_PATTERNS_NUM) {
    const match = normalized.match(rx);
    if (match) {
      const parsed = parseNumericUsDate(match[1]);
      if (parsed) return parsed;
    }
  }
  return null;
}

function hmsToSeconds(value) {
  const m = String(value || "").trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  if (m[3] === undefined) {
    return Number(m[1]) * 60 + Number(m[2]);
  }
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function normalizeKey(s) {
  return String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function parseInputConfig(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw makeError("INPUT_FILE_NOT_FOUND", `Brak pliku wejściowego: ${inputPath}`);
  }

  const raw = fs.readFileSync(inputPath, "utf-8");
  const parsed = {};
  raw.split(/\r?\n/).forEach((line, idx) => {
    const clean = line.split("#", 1)[0].trim();
    if (!clean) return;
    const m = clean.match(/^([^=]+?)\s*=\s*(.+)$/);
    if (!m) {
      throw makeError("INVALID_INPUT_LINE", `Niepoprawna linia w pliku wejściowym (${idx + 1}): ${line}`, { line: idx + 1 });
    }
    parsed[m[1].trim().toLowerCase()] = m[2].trim();
  });

  if (!parsed.date_from || !parsed.date_to) {
    throw makeError("MISSING_REQUIRED_KEYS", "Brak wymaganych kluczy date_from/date_to w pliku wejściowym.");
  }

  const config = {
    ...DEFAULTS,
    ...parsed,
    date_from: parsePlDate(parsed.date_from, "date_from"),
    date_to: parsePlDate(parsed.date_to, "date_to")
  };

  if (config.date_from.getTime() > config.date_to.getTime()) {
    console.warn("[Qobuz Scraper] date_from > date_to, zamieniam kolejność.");
    const tmp = config.date_from;
    config.date_from = config.date_to;
    config.date_to = tmp;
  }

  const numSpec = [
    ["min_minutes", true, 1],
    ["delay_listing", false, 0],
    ["delay_album", false, 0],
    ["max_pages_per_label", true, 1],
    ["retries", true, 0],
    ["timeout_ms", true, 1000]
  ];

  for (const [key, isInt, min] of numSpec) {
    const rawValue = config[key];
    const parsedValue = isInt ? Number.parseInt(rawValue, 10) : Number.parseFloat(String(rawValue).replace(",", "."));
    if (!Number.isFinite(parsedValue)) {
      throw makeError("INVALID_NUMERIC_VALUE", `Wartość ${key} musi być liczbą.`, { key, value: rawValue });
    }
    if (parsedValue < min) {
      throw makeError("VALUE_OUT_OF_RANGE", `Wartość ${key} musi być >= ${min}.`, { key, value: parsedValue, min });
    }
    config[key] = parsedValue;
  }

  config.genre_root = String(config.genre_root || DEFAULTS.genre_root).trim() || DEFAULTS.genre_root;
  config.accept_language = String(config.accept_language || DEFAULTS.accept_language).trim() || DEFAULTS.accept_language;
  config.user_agent = String(config.user_agent || DEFAULTS.user_agent).trim() || DEFAULTS.user_agent;
  config.labels_file = String(config.labels_file || DEFAULTS.labels_file).trim() || DEFAULTS.labels_file;

  return config;
}

function parseLabelsFile(labelsPath) {
  if (!fs.existsSync(labelsPath)) {
    throw makeError("LABELS_FILE_NOT_FOUND", `Brak pliku labeli: ${labelsPath}`);
  }
  const labels = [];
  const lines = fs.readFileSync(labelsPath, "utf-8").split(/\r?\n/);
  lines.forEach((line, index) => {
    const clean = line.split("#", 1)[0].trim();
    if (!clean) return;
    const pos = clean.indexOf(" - ");
    const name = pos >= 0 ? clean.slice(0, pos) : clean;
    const sep = pos >= 0 ? " - " : "";
    const url = pos >= 0 ? clean.slice(pos + 3) : "";
    if (!sep) {
      throw makeError("INVALID_LABELS_LINE", `Niepoprawna linia ${index + 1} w pliku labeli (brak separatora ' - ').`, { line: index + 1, value: line });
    }
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    if (!trimmedName || !/^https?:\/\//i.test(trimmedUrl)) {
      throw makeError("INVALID_LABELS_LINE", `Niepoprawna linia ${index + 1} w pliku labeli.`, { line: index + 1, value: line });
    }
    labels.push({ name: trimmedName, url: trimmedUrl });
  });
  return labels;
}

function normalizeLabelBase(url) {
  const u = new URL(url);
  u.pathname = u.pathname.replace(/\/page\/\d+\/?$/, "");
  return u.toString();
}

function buildLabelPageUrl(labelUrl, page) {
  const u = new URL(labelUrl);
  let base = u.pathname.replace(/\/page\/\d+\/?$/, "").replace(/\/$/, "");
  if (page > 1) base += `/page/${page}`;
  u.pathname = base;
  return u.toString();
}

function listingHasPage2($, labelUrl) {
  const base = normalizeLabelBase(labelUrl);
  const basePath = new URL(base).pathname.replace(/\/$/, "");
  let found = false;
  $("a[href]").each((_, el) => {
    if (found) return;
    const href = $(el).attr("href");
    const full = new URL(href, base);
    if (new RegExp(`${basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/page/2\\b`).test(full.pathname)) {
      found = true;
    } else if (href.includes("/page/2")) {
      found = true;
    }
  });
  return found;
}

function extractListingReleaseDateForLink($, linkEl, pageUrl, albumUrl, maxHops = 10) {
  let node = linkEl;
  for (let hop = 0; hop < maxHops && node; hop += 1) {
    const container = $(node);
    const albumLinks = new Set();
    container.find("a[href]").each((_, a) => {
      const href = $(a).attr("href") || "";
      if (!href.includes("/album/")) return;
      const full = new URL(href, pageUrl).toString().split("#", 1)[0];
      albumLinks.add(full);
    });
    if (albumLinks.size === 1 && albumLinks.has(albumUrl)) {
      const txt = container.text().replace(/\s+/g, " ").trim();
      const rel = extractReleaseDateFromText(txt);
      if (rel) return rel;
    }
    node = node.parent;
  }
  return null;
}

function extractAlbumCandidatesFromListing(html, pageUrl, labelName, startDate, endDate, stats) {
  const $ = cheerio.load(html);
  const candidates = [];
  const seen = new Set();
  $("a[href]").each((_, link) => {
    const href = $(link).attr("href") || "";
    if (!href.includes("/album/")) return;
    const albumUrl = new URL(href, pageUrl).toString().split("#", 1)[0];
    if (seen.has(albumUrl)) return;
    seen.add(albumUrl);

    let rel = null;
    try {
      rel = extractListingReleaseDateForLink($, link, pageUrl, albumUrl);
    } catch (error) {
      stats.parseErrors += 1;
    }
    if (!rel) return;
    if (rel.getTime() >= startDate.getTime() && rel.getTime() <= endDate.getTime()) {
      candidates.push({ album_url: albumUrl, label_name: labelName, release_date_listing: rel });
    }
  });
  return { candidates, hasPage2: listingHasPage2($, pageUrl) };
}

function parseAlbumFirstGenre($) {
  const lines = $.root().text().split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^[\s#*\-•]+/, "").trim()).filter(Boolean);
  const aboutIdx = lines.findIndex((line) => line.toLowerCase() === "about the album" || line.toLowerCase().includes("about the album"));
  if (aboutIdx === -1) return null;
  const window = lines.slice(aboutIdx, aboutIdx + 160);
  for (let i = 0; i < window.length; i += 1) {
    const line = window[i];
    const cf = line.toLowerCase();
    if (!cf.includes("genre")) continue;
    let raw = "";
    if (line.includes(":")) {
      const [left, ...rest] = line.split(":");
      if (left.trim().toLowerCase() !== "genre") continue;
      raw = rest.join(":").replace(/\s+/g, " ").trim();
    } else {
      if (!cf.startsWith("genre")) continue;
      raw = line.split(/\s+/).slice(1).join(" ").trim();
    }
    if (!raw) {
      const tags = [];
      for (const next of window.slice(i + 1, i + 10)) {
        const n = next.trim();
        if (!n) continue;
        if (/^(main artists|composer|label|total length|available in)\b/i.test(n) || n.endsWith(":")) break;
        tags.push(n);
      }
      return tags[0] || null;
    }
    if (raw.toLowerCase().startsWith("classical")) return "Classical";
    for (const delim of ["/", ",", "|", "›", ">"]) {
      if (raw.includes(delim)) return raw.split(delim, 1)[0].trim() || null;
    }
    return raw.split(" ", 1)[0].trim() || null;
  }
  return null;
}

function parseAlbumReleaseDate($) {
  const lines = $.root().text().split(/\n+/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 120)) {
    if (/\b(released|to be released)\b/i.test(line)) {
      const parsed = extractReleaseDateFromText(line);
      if (parsed) return parsed;
    }
  }
  return extractReleaseDateFromText(lines.join(" "));
}

function parseAlbumDetails(html) {
  const $ = cheerio.load(html);
  let title = "";
  const h1 = $("h1").first().text().replace(/\s+/g, " ").trim();
  if (h1) title = h1.includes(" by ") ? h1.split(" by ", 1)[0].trim() : h1;

  let mainArtists = "";
  let mainBlock = null;
  $("li, p, div").each((_, el) => {
    if (mainBlock) return;
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text.toLowerCase().startsWith("main artists:")) {
      mainBlock = el;
    }
  });
  if (mainBlock) {
    const artists = [];
    $(mainBlock).find("a").each((_, a) => {
      const val = $(a).text().replace(/\s+/g, " ").trim();
      if (val) artists.push(val);
    });
    mainArtists = artists.length ? artists.join(", ") : $(mainBlock).text().split(":").slice(1).join(":").replace(/\s+/g, " ").trim();
  }

  const pageText = $.root().text();
  const m = pageText.match(/Total length:\s*([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)/i);
  if (!m) return null;
  const totalHms = m[1].trim();
  const totalSeconds = hmsToSeconds(totalHms);
  if (totalSeconds === null) return null;

  if (!title && !mainArtists) return null;

  return {
    title,
    main_artists: mainArtists,
    total_length_hms: totalHms,
    total_seconds: totalSeconds,
    release_date_album: parseAlbumReleaseDate($),
    genre_first: parseAlbumFirstGenre($)
  };
}

function writeLinksTxt(filePath, links) {
  fs.writeFileSync(filePath, links.length ? `${links.join("\n")}\n` : "", "utf-8");
}

function writeXlsx(filePath, records) {
  const rows = records.map((r) => ({
    album_title: r.album_title,
    main_artists: r.main_artists,
    label: r.label,
    album_url: r.album_url,
    release_date: formatPlDate(r.release_date)
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows, {
    header: ["album_title", "main_artists", "label", "album_url", "release_date"]
  });
  XLSX.utils.book_append_sheet(wb, ws, "albums");
  XLSX.writeFile(wb, filePath);
}

async function fetchHtml(url, config, stats, { signal, session, emitProgress, phase = "fetch", timing } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= config.retries; attempt += 1) {
    try {
      throwIfAborted(signal, session);
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal?.reason || "ABORTED");
      signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => controller.abort("TIMEOUT"), config.timeout_ms);
      const reqStart = Date.now();
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": config.user_agent,
          "Accept-Language": config.accept_language
        }
      });
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      timing?.count(phase, Date.now() - reqStart);

      if (response.status === 429) {
        if (attempt < config.retries) {
          const backoff = 2000 * (2 ** (attempt - 1));
          stats.http429 = (stats.http429 || 0) + 1; stats.retries = (stats.retries || 0) + 1;
          emitProgress?.({ type:"log", level:"warning", code:"HTTP_429", phase, url, attempt, maxAttempts: config.retries, retryAfterMs: backoff, message:`HTTP 429 — ponowienie za ${backoff} ms [${attempt}/${config.retries}]` });
          console.warn(`[Qobuz Scraper] 429 Too Many Requests: ${url}, retry za ${backoff}ms`);
          timing?.add("retry_backoff", backoff);
          await sleep(backoff, signal, session);
          continue;
        }
      }

      if (response.status >= 500 && response.status < 600) {
        if (attempt < config.retries) {
          const backoff = 1000 * (2 ** (attempt - 1));
          stats.http5xx = (stats.http5xx || 0) + 1; stats.retries = (stats.retries || 0) + 1;
          emitProgress?.({ type:"log", level:"warning", code:"HTTP_5XX", phase, url, attempt, maxAttempts: config.retries, retryAfterMs: backoff, message:`HTTP ${response.status} — ponowienie za ${backoff} ms [${attempt}/${config.retries}]` });
          console.warn(`[Qobuz Scraper] HTTP ${response.status}: ${url}, retry za ${backoff}ms`);
          timing?.add("retry_backoff", backoff);
          await sleep(backoff, signal, session);
          continue;
        }
      }

      if (response.status !== 200) {
        console.error(`[Qobuz Scraper] HTTP ${response.status}: ${url}`);
        stats.httpErrors += 1;
        return null;
      }

      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt >= config.retries) break;
      const backoff = 1000 * (2 ** (attempt - 1));
      stats.networkErrors = (stats.networkErrors || 0) + 1; stats.retries = (stats.retries || 0) + 1;
      emitProgress?.({ type:"log", level:"warning", code: error?.name === "AbortError" ? "ABORTED" : "NETWORK_ERROR", phase, url, attempt, maxAttempts: config.retries, retryAfterMs: backoff, message:`Błąd sieci — ponowienie za ${backoff} ms [${attempt}/${config.retries}]` });
      console.warn(`[Qobuz Scraper] Błąd sieci (${attempt}/${config.retries}): ${error.message}, retry za ${backoff}ms`);
      timing?.add("retry_backoff", backoff);
      await sleep(backoff, signal, session);
    }
  }
  stats.httpErrors += 1;
  console.error(`[Qobuz Scraper] Nie udało się pobrać ${url}: ${lastError?.message || "unknown"}`);
  return null;
}

function formatElapsed(ms) { const s = Math.floor(ms / 1000); const hh = String(Math.floor(s / 3600)).padStart(2,"0"); const mm = String(Math.floor((s % 3600) / 60)).padStart(2,"0"); const ss = String(s % 60).padStart(2,"0"); const mmm = String(Math.floor(ms % 1000)).padStart(3,"0"); return `${hh}:${mm}:${ss}.${mmm}`; }
function emitProgress(emit, payload, session) {
  const event = { sessionId: session?.sessionId, runStamp: session?.runStamp, type: payload.type || "progress", level: payload.level || "info", timestamp: Date.now(), ...payload };
  if (session?.log && event.message) session.log.push(`${formatElapsed(Date.now() - session.startedAt)} | ${String(event.level).toUpperCase()} | ${event.code || "-"} | ${event.phase || "-"} | ${event.message}`);
  if (typeof emit === "function") emit(event);
}

async function runQobuzScraper({ appRootOverride, dryRun = false, qobuzSettings = {}, emitProgress: progressEmitter, session: providedSession, signal } = {}) {
  const started = Date.now();
  const appRoot = path.resolve(appRootOverride || process.cwd());
  const filesDir = path.join(appRoot, "FILES");
  const session = providedSession || { sessionId: `qobuz-scrape-${started}`, runStamp: formatRunTimestamp(new Date(started)), startedAt: started, log: [], manifest: { files: [] } };
  session.signal = signal || session.signal;
  session.sessionDir = session.sessionDir || path.join(filesDir, "download", ".sessions", session.sessionId);
  session.manifest = session.manifest || { sessionId: session.sessionId, runStamp: session.runStamp, status: "running", files: [] };
  const timing = session.timings || new RunTiming();

  const stats = {
    labelsTotal: 0,
    labelsProcessed: 0,
    candidatesTotal: 0,
    albumsFetched: 0,
    accepted: 0,
    rejectedByGenre: 0,
    rejectedByLength: 0,
    rejectedByDateMismatch: 0,
    missingAlbumDate: 0,
    duplicatesRemoved: 0,
    httpErrors: 0,
    parseErrors: 0, http429: 0, http5xx: 0, timeouts: 0, networkErrors: 0, retries: 0
  };

  emitProgress(progressEmitter, { type:"state", phase: "init", percent: 1, message: "Rozpoczęto sesję QOBUZ SCRAPE" }, session);
  timing.start("read_settings");
  const general = qobuzSettings?.general || {};
  const config = {
    ...DEFAULTS,
    ...general,
    date_from: parsePlDate(String(general.date_from || DEFAULTS.date_from || "01.01.2020"), "date_from"),
    date_to: parsePlDate(String(general.date_to || DEFAULTS.date_to || "31.12.2030"), "date_to")
  };

  const numSpec = [
    ["min_minutes", true, 1],
    ["delay_listing", false, 0],
    ["delay_album", false, 0],
    ["max_pages_per_label", true, 1],
    ["retries", true, 1],
    ["timeout_ms", true, 1000]
  ];
  for (const [key, isInt, min] of numSpec) {
    const parsedValue = isInt ? Number.parseInt(config[key], 10) : Number.parseFloat(String(config[key]).replace(",", "."));
    config[key] = Number.isFinite(parsedValue) && parsedValue >= min ? parsedValue : DEFAULTS[key];
  }
  config.genre_root = String(config.genre_root || DEFAULTS.genre_root).trim() || DEFAULTS.genre_root;
  config.accept_language = String(DEFAULTS.accept_language);
  config.user_agent = String(DEFAULTS.user_agent);

  if (config.date_from.getTime() > config.date_to.getTime()) {
    const tmp = config.date_from;
    config.date_from = config.date_to;
    config.date_to = tmp;
  }

  timing.end("read_settings");
  console.log("[Qobuz Scraper] Start konfiguracji:", {
    appRoot,
    date_from: formatPlDate(config.date_from),
    date_to: formatPlDate(config.date_to),
    min_minutes: config.min_minutes,
    delay_listing: config.delay_listing,
    delay_album: config.delay_album,
    max_pages_per_label: config.max_pages_per_label,
    retries: config.retries,
    timeout_ms: config.timeout_ms,
    genre_root: config.genre_root
  });

  emitProgress(progressEmitter, { phase: "labels", percent: 3, message: "Loading labels..." }, session);
  timing.start("prepare_labels");
  const labels = (Array.isArray(qobuzSettings?.labels) ? qobuzSettings.labels : [])
    .filter((label) => Number(label?.is_active) === 1)
    .map((label) => ({ name: String(label?.name || "").trim(), url: String(label?.url || "").trim() }))
    .filter((label) => label.name && label.url);
  stats.labelsTotal = labels.length;
  timing.end("prepare_labels");

  const listingLimiter = new Bottleneck({ maxConcurrent: 1, minTime: Math.max(0, config.delay_listing * 1000) });
  const albumLimiter = new Bottleneck({ maxConcurrent: 1, minTime: Math.max(0, config.delay_album * 1000) });

  const candidates = [];
  const seenByLabelUrl = new Set();

  try {
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i];
    stats.labelsProcessed += 1;
    throwIfAborted(session.signal, session);
    emitProgress(progressEmitter, {
      phase: "listing",
      message: `Scraping label ${i + 1}/${labels.length}: ${label.name}`,
      current: i + 1,
      total: labels.length,
      percent: Math.min(40, 5 + Math.round(((i + 1) / Math.max(1, labels.length)) * 35))
    }, session);

    let normalized = "";
    try {
      normalized = normalizeLabelBase(label.url);
    } catch (error) {
      console.warn(`[Qobuz Scraper] Pomijam label z nieprawidłowym linkiem: ${label.name} (${label.url})`);
      continue;
    }
    for (let page = 1; page <= config.max_pages_per_label; page += 1) {
      if (page > 1 && config.max_pages_per_label <= 1) break;
      const pageUrl = buildLabelPageUrl(normalized, page);
      console.log(`[Qobuz Scraper] Label=${label.name}, page=${page}/${config.max_pages_per_label}, url=${pageUrl}`);
      throwIfAborted(session.signal, session);
      emitProgress(progressEmitter, { phase:"listing_fetch", message:`Pobieram stronę listingu ${page}`, url: pageUrl }, session);
      const html = await listingLimiter.schedule(() => fetchHtml(pageUrl, config, stats, { signal: session.signal, session, emitProgress: (p)=>emitProgress(progressEmitter,p,session), phase:"listing_fetch", timing }));
      if (!html) continue;
      let extracted;
      try {
        extracted = extractAlbumCandidatesFromListing(
          html,
          pageUrl,
          label.name,
          config.date_from,
          config.date_to,
          stats
        );
      } catch (error) {
        stats.parseErrors += 1;
        console.error(`[Qobuz Scraper] Błąd parsowania listingu ${pageUrl}: ${error.message}`);
        continue;
      }

      extracted.candidates.forEach((cand) => {
        const key = `${cand.album_url}||${cand.label_name}`;
        if (seenByLabelUrl.has(key)) return;
        seenByLabelUrl.add(key);
        candidates.push(cand);
      });

      if (page === 1 && !extracted.hasPage2) {
        break;
      }
    }
  }

  } catch (error) {
    if (error?.code !== "STOP_AND_SAVE" && error?.message !== "STOP_AND_SAVE") throw error;
    session.stopRequested = true;
    emitProgress(progressEmitter, { type:"state", level:"warning", code:"STOP_AND_SAVE", phase:"listing", message:"Żądanie PRZERWIJ I ZAPISZ — przechodzę do zapisu częściowego." }, session);
  }

  stats.candidatesTotal = candidates.length;
  console.log(`[Qobuz Scraper] Kandydaci po strict listing date: ${candidates.length}`);

  const accepted = [];
  const missingRows = [];

  try {
  for (let i = 0; i < candidates.length; i += 1) {
    const cand = candidates[i];
    stats.albumsFetched += 1;
    throwIfAborted(session.signal, session);
    emitProgress(progressEmitter, {
      phase: "albums",
      message: `Fetching album ${i + 1}/${candidates.length}`,
      current: i + 1,
      total: candidates.length,
      percent: Math.min(90, 40 + Math.round(((i + 1) / Math.max(1, candidates.length)) * 50))
    }, session);

    const html = await albumLimiter.schedule(() => fetchHtml(cand.album_url, config, stats, { signal: session.signal, session, emitProgress: (p)=>emitProgress(progressEmitter,p,session), phase:"album_fetch", timing }));
    if (!html) continue;
    let det;
    try {
      det = parseAlbumDetails(html);
    } catch (error) {
      stats.parseErrors += 1;
      console.error(`[Qobuz Scraper] Błąd parsowania albumu ${cand.album_url}: ${error.message}`);
      continue;
    }
    if (!det) continue;

    let finalRelease = det.release_date_album;
    if (!finalRelease) {
      finalRelease = cand.release_date_listing;
      stats.missingAlbumDate += 1;
      emitProgress(progressEmitter, { type:"log", level:"warning", code:"MISSING_DATE", phase:"album_parse", message:"Brak daty albumu — użyto daty z listingu", url:cand.album_url }, session);
      missingRows.push(`${cand.label_name}\t${cand.album_url}\t${formatPlDate(cand.release_date_listing)}\t${det.title}\t${det.main_artists}`);
    } else if (finalRelease.getTime() < config.date_from.getTime() || finalRelease.getTime() > config.date_to.getTime()) {
      stats.rejectedByDateMismatch += 1;
      continue;
    }

    const genre = String(det.genre_first || "").trim().toLowerCase();
    if (!genre.startsWith(config.genre_root.toLowerCase())) {
      stats.rejectedByGenre += 1;
      continue;
    }

    if (det.total_seconds < config.min_minutes * 60) {
      stats.rejectedByLength += 1;
      continue;
    }

    accepted.push({
      album_title: det.title,
      main_artists: det.main_artists,
      label: cand.label_name,
      album_url: cand.album_url,
      release_date: finalRelease
    });
  }

  } catch (error) {
    if (error?.code !== "STOP_AND_SAVE" && error?.message !== "STOP_AND_SAVE") throw error;
    session.stopRequested = true;
    emitProgress(progressEmitter, { type:"state", level:"warning", code:"STOP_AND_SAVE", phase:"albums", message:"Żądanie PRZERWIJ I ZAPISZ — zapisuję ukończone albumy." }, session);
  }

  const dedup = [];
  const seen = new Set();
  accepted.forEach((record) => {
    const key = `${normalizeKey(record.album_title)}||${normalizeKey(record.main_artists)}||${normalizeKey(record.label)}`;
    if (seen.has(key)) {
      stats.duplicatesRemoved += 1;
      return;
    }
    seen.add(key);
    dedup.push(record);
  });
  stats.accepted = dedup.length;

  const outputDir = path.join(filesDir, "download");
  let linksTxt = null;
  let xlsxPath = null;
  let missingPath = null;

  const partial = session.stopRequested === true;
  const statusText = partial ? "partial" : "completed";
  const namePart = partial ? `PARTIAL_${session.runStamp}` : session.runStamp;
  emitProgress(progressEmitter, { phase: "writing", percent: 92, message: partial ? "Zatrzymano — zapisuję wynik częściowy..." : "Writing outputs..." }, session);
  let logTxt = null, reportTxt = null, reportJson = null, checkpointJson = null;
  if (!dryRun && !session.cancelRequested) {
    await ensureDir(outputDir);
    await ensureDir(session.sessionDir);
    const linksContent = dedup.length ? `${dedup.map((row) => row.album_url).join("\n")}\n` : "";
    linksTxt = await atomicWriteFile({ sessionDir: session.sessionDir, outputDir, baseName: `${OUTPUT_BASES.linksTxt}_${namePart}`, extension: ".txt", content: linksContent, type:"links", manifest: session.manifest, partial });
    emitProgress(progressEmitter, { type:"log", level:"success", phase:"writing", code:"FILE_SAVED", message:`Zapisano listę linków: ${linksTxt}`, path: linksTxt }, session);
    emitProgress(progressEmitter, { phase: "writing", percent: 96, message: "Writing XLSX..." }, session);
    xlsxPath = await atomicWriteFile({ sessionDir: session.sessionDir, outputDir, baseName: `${OUTPUT_BASES.xlsx}_${namePart}`, extension: ".xlsx", type:"xlsx", manifest: session.manifest, partial, validate: validateXlsx(["album_title","main_artists","label","album_url","release_date"]), content: (tmp)=>writeXlsx(tmp, dedup) });
    emitProgress(progressEmitter, { type:"log", level:"success", phase:"writing", code:"FILE_SAVED", message:`Zapisano XLSX: ${xlsxPath}`, path: xlsxPath }, session);
    if (missingRows.length) {
      missingPath = await atomicWriteFile({ sessionDir: session.sessionDir, outputDir, baseName: `${OUTPUT_BASES.missingDatesTxt}_${namePart}`, extension: ".txt", content: `label\talbum_url\tlisting_release_date\talbum_title\tmain_artists\n${missingRows.join("\n")}\n`, type:"missingDates", manifest: session.manifest, partial });
    }
    const report = { sessionId: session.sessionId, runStamp: session.runStamp, status: statusText, startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), stats, timings: timing.snapshot(), files: session.manifest.files };
    if (partial) checkpointJson = await atomicWriteFile({ sessionDir: session.sessionDir, outputDir, baseName: `${OUTPUT_BASES.checkpoint}_${namePart}`, extension: ".json", content: JSON.stringify({ ...report, config, candidatesTotal: candidates.length, completedRecords: dedup.length, incompleteRecords: Math.max(0, candidates.length - stats.albumsFetched), lastCompletedIndex: stats.albumsFetched - 1, warnings: session.log.filter(l=>l.includes("WARNING")), errors: session.log.filter(l=>l.includes("ERROR")) }, null, 2), type:"checkpoint", manifest: session.manifest, partial });
    logTxt = await atomicWriteFile({ sessionDir: session.sessionDir, outputDir, baseName: `${OUTPUT_BASES.logTxt}_${namePart}`, extension: ".txt", content: `${session.log.join("\n")}\n`, type:"log", manifest: session.manifest, partial });
    reportTxt = await atomicWriteFile({ sessionDir: session.sessionDir, outputDir, baseName: `${OUTPUT_BASES.reportTxt}_${namePart}`, extension: ".txt", content: [`STATUS: ${partial ? "WYNIK CZĘŚCIOWY" : "PEŁNY SUKCES"}`, `sessionId: ${session.sessionId}`, `runStamp: ${session.runStamp}`, `accepted: ${stats.accepted}`, `candidates: ${stats.candidatesTotal}`].join("\n") + "\n", type:"reportTxt", manifest: session.manifest, partial });
    reportJson = await atomicWriteFile({ sessionDir: session.sessionDir, outputDir, baseName: `${OUTPUT_BASES.reportJson}_${namePart}`, extension: ".json", content: JSON.stringify({ ...report, manifest: session.manifest }, null, 2), type:"reportJson", manifest: session.manifest, partial });
  }

  const finished = Date.now();
  session.manifest.status = statusText;
  emitProgress(progressEmitter, { type:"summary", level: partial ? "warning" : "success", phase: "done", percent: 100, message: partial ? "STATUS: WYNIK CZĘŚCIOWY" : "PEŁNY SUKCES" }, session);
  console.log("[Qobuz Scraper] Podsumowanie:", stats);

  return {
    ok: true,
    status: statusText,
    sessionId: session.sessionId,
    runStamp: session.runStamp,
    outputDir,
    files: {
      linksTxt,
      xlsx: xlsxPath,
      missingDatesTxt: missingRows.length ? missingPath : null,
      checkpointJson,
      logTxt,
      reportTxt,
      reportJson
    },
    manifest: session.manifest,
    stats,
    timing: {
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started
    }
  };
}

module.exports = {
  runQobuzScraper,
  makeError
};