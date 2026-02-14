const DEFAULT_LABEL_HIERARCHY = [
  "01A - ECM New Series","02A - Deutsche Grammophon (DG)","03A - Chandos","04A - Sony Classical",
  "05A - Decca Music Group Ltd.","06A - Harmonia mundi","07A - Alpha Classics","08A - PENTATONE",
  "09A - Channel Classics","10B - Hyperion","11B - BIS","12B - Warner Classics / Erato",
  "13B - Delphian Records","14B - Lawo Classics","15B - Naxos","16B - Signum Records",
  "17B - LSO Live","18B - Berlin Classics","19C - Aparté","20C - Orchid Classics",
  "21C - Fuga Libera","22C - Ondine","23C - Evidence Classics","24C - Navona","25C - Ricercar",
  "26C - Arcana","27C - Nonesuch","28C - Linn Records","29C - AVIE Records","30C - Naive",
  "31C - Rubicon","32C - Mirare","33C - CPO","34C - Brilliant Classics","35C - Capriccio",
  "36C - BR-Klassik","37C - Resonus Classics","38C - Onyx Classics","39C - First Hand Records",
  "40C - Piano Classics","41C - Hänssler CLASSIC","42C - Grand Piano","43C - Bright Shiny Things",
  "44C - RCA Red Seal","99Z - unknown"
];

const buildLabelMap = (list) =>
  list.reduce((map, item) => {
    const parts = String(item || "").split(" - ");
    const code = parts.shift()?.trim();
    const name = parts.join(" - ").trim();
    if (name) {
      map.set(name, code || "99Z");
    }
    return map;
  }, new Map());

let LABEL_HIERARCHY = [...DEFAULT_LABEL_HIERARCHY];
let LABEL_MAP = buildLabelMap(LABEL_HIERARCHY);

function setLabelHierarchy(next = []) {
  const normalized = Array.isArray(next) ? next.map((entry) => String(entry || "").trim()).filter(Boolean) : [];
  LABEL_HIERARCHY = normalized.length ? normalized : [...DEFAULT_LABEL_HIERARCHY];
  LABEL_MAP = buildLabelMap(LABEL_HIERARCHY);
}

const DEFAULT_SELECTORS = ["N", "X", "F", "K", "O"];
const SELECTOR_SET = new Set(DEFAULT_SELECTORS);

const DEFAULT_FOLDER_COLOR = "#2e7d32";
const DEFAULT_CONTAINER_COLOR = "#1976d2";
const DEFAULT_EMPTY_COLOR = "#9e9e9e";
const ALBUMS_PER_PAGE = 12;
const HEARD_MIN = 0;
const HEARD_MAX = 999;
const RATING_MIN = 0;
const RATING_MAX = 5;

const CATEGORY_CLASSES = {
  DB: "cat-C",
  NR: "cat-A",
  FD: "cat-B"
};

function formatStatusDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function getAlbumData(entry) {
  return entry?.album || entry;
}

function parseReleaseDateValue(value) {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number") {
    if (value > 1000000000000) return Math.floor(value / 1000);
    if (value >= 100000000) return Math.floor(value);
    if (window.XLSX?.SSF?.parse_date_code) {
      const decoded = window.XLSX.SSF.parse_date_code(value);
      if (decoded) {
        const dt = new Date(
          decoded.y,
          (decoded.m || 1) - 1,
          decoded.d || 1,
          decoded.H || 0,
          decoded.M || 0,
          Math.floor(decoded.S || 0)
        );
        if (!Number.isNaN(dt.getTime())) {
          return Math.floor(dt.getTime() / 1000);
        }
      }
    }
    if (value > 0) return Math.floor(value);
    return 0;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    if (/^-?\d+$/.test(trimmed)) {
      const num = parseInt(trimmed, 10);
      if (num > 1000000000000) return Math.floor(num / 1000);
      return num;
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return Math.floor(parsed.getTime() / 1000);
    }
  }
  return 0;
}

function clampHeard(value) {
  if (Number.isNaN(value)) return HEARD_MIN;
  return Math.min(Math.max(value, HEARD_MIN), HEARD_MAX);
}

function clampRating(value) {
  if (!Number.isFinite(value)) return RATING_MIN;
  const rounded = Math.round(value);
  if (rounded < RATING_MIN) return RATING_MIN;
  if (rounded > RATING_MAX) return RATING_MAX;
  return rounded;
}

function sanitizeName(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function buildRoonId(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 999999) return "";
  return String(Math.floor(numeric)).padStart(6, "0");
}

function normalizeLinkForSearch(value) {
  if (!value) return "";
  const raw = String(value || "").trim().toLowerCase();
  const stripTrailingParts = (input) => input.replace(/\/+$/, "").replace(/\/u$/, "");
  try {
    const url = new URL(raw);
    const normalizedPath = stripTrailingParts(url.pathname);
    return `${url.origin}${normalizedPath}`;
  } catch (error) {
    return stripTrailingParts(raw);
  }
}

function extractAlbumId(value) {
  if (!value) return "";
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return raw;
  const match = raw.match(/\/album\/(\d+)/);
  return match ? match[1] : "";
}

function isUrlSearchKey(value) {
  return /^https?:\/\//.test(value);
}

function matchesSearchKey(album, searchKey) {
  if (!searchKey) return true;
  const haystack = `${album.title || ""} ${album.artist || ""}`.toLowerCase();
  if (haystack.includes(searchKey)) return true;
  const albumId = extractAlbumId(album.link);
  const searchId = extractAlbumId(searchKey);
  if (albumId && searchId && albumId === searchId) return true;
  if (isUrlSearchKey(searchKey)) {
    const normalizedSearch = normalizeLinkForSearch(searchKey);
    const normalizedLink = normalizeLinkForSearch(album.link);
    if (!normalizedLink) return false;
    return (
      normalizedSearch.startsWith(normalizedLink) ||
      normalizedLink.startsWith(normalizedSearch)
    );
  }
  return false;
}

function compareByReleaseDesc(a, b) {
  const albumA = getAlbumData(a);
  const albumB = getAlbumData(b);
  const diff = (albumB.release_date || 0) - (albumA.release_date || 0);
  if (diff !== 0) return diff;
  const labelDiff = getLabelOrderCode(albumA.label) - getLabelOrderCode(albumB.label);
  if (labelDiff !== 0) return labelDiff;
  return (albumA.title || "").localeCompare(albumB.title || "", "pl", { sensitivity: "base" });
}

function compareByReleaseAsc(a, b) {
  const albumA = getAlbumData(a);
  const albumB = getAlbumData(b);
  const diff = (albumA.release_date || 0) - (albumB.release_date || 0);
  if (diff !== 0) return diff;
  const labelDiff = getLabelOrderCode(albumA.label) - getLabelOrderCode(albumB.label);
  if (labelDiff !== 0) return labelDiff;
  return (albumA.title || "").localeCompare(albumB.title || "", "pl", { sensitivity: "base" });
}

function compareByAddedDesc(a, b) {
  const diff = (b.added_ts || 0) - (a.added_ts || 0);
  if (diff !== 0) return diff;
  return compareByReleaseDesc(a, b);
}

function getLabelOrderCode(label) {
  const code = LABEL_MAP.get(label);
  return code ? parseInt(code, 10) : 999;
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return "brak";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function truncateName(name, n) {
  if (!name) return "";
  if (name.length <= n) return name;
  return `${name.slice(0, n)}…`;
}

class DataStore {
  constructor() {
    this.records = [];
    this.recordsById = new Map();
    this.categorized = { DB: [], NR: [], FD: [] };
    this.newReleaseSet = new Set();
    this.albumAssignments = new Map();
    this.folderEntries = [];
    this.collectionsData = [];
    this.collectionsList = new Set(["brak"]);
    this.collectionMeta = new Map([["brak", { containers: new Set() }]]);
    this.foldersList = new Set(["brak"]);
    this.containersList = new Set(["brak"]);
    this.folderMeta = new Map([["brak", { container: "brak" }]]);
    this.albumAssignments = new Map();
    this.folderEntries = [];
    this.containerMeta = new Map([["brak", { folders: new Set(), collection: "brak" }]]);
    this.selectedLabels = new Set(Array.from(LABEL_MAP.keys()));
    this.selectedSelectors = new Set(DEFAULT_SELECTORS);
    this.currentSheetName = "Sheet1";
    this.currentFileName = "";
    this.currentFileTimestamp = "";
    this.sortedByRelease = [];
    this.sortedByAdded = [];
    this.releaseYears = [];
    this.filteredFolderBuckets = new Map();
    this.filteredContainerBuckets = new Map();
    this.cachedCounts = {
      folders: new Map([["brak", 0]]),
      containers: new Map([["brak", 0]]),
      foldersByContainer: new Map([["brak", new Map([["brak", 0]])]])
    };
    this.indexesDirty = true;
    this.sortMode = "release_desc";
    this.sortedCategoryCache = new Map();
    this.activeFilters = {
      releaseStartTs: null,
      releaseEndTs: null,
      labelsKey: "",
      labelsSet: new Set(this.selectedLabels),
      selectorsKey: "",
      selectorsSet: new Set(this.selectedSelectors),
      searchKey: "",
      heardMin: null,
      heardMax: null,
      durationMin: null,
      durationMax: null,
      showFavorites: true
    };
  }

  setFileMeta({ name, timestamp } = {}) {
    if (name) {
      this.currentFileName = name;
    }
    if (timestamp) {
      const dt = timestamp instanceof Date ? timestamp : new Date(timestamp);
      if (!Number.isNaN(dt.getTime())) {
        this.currentFileTimestamp = formatStatusDate(dt);
      }
    }
  }

  convertRowToRecord(row = {}) {
    const selectorRaw = row.SELECTOR ?? row.SETECTOR ?? "N";
    const selectorValue = String(selectorRaw || "N").trim().toUpperCase() || "N";
    const selector = SELECTOR_SET.has(selectorValue) ? selectorValue : "N";
    const idValue = row.ID_ALBUMU ?? row.ID ?? row.id_albumu ?? row.id ?? "";
    const parsedId = Number(idValue);
    const id_albumu = Number.isFinite(parsedId) && parsedId > 0 ? parsedId : null;
    const heard = clampHeard(Number(row.HEARD) || 0);
    const releaseDate = parseReleaseDateValue(row.RELEASE_DATE);
    const favoriteRaw = row.FAVORITE ?? row.favorite ?? 0;
    const favoriteNumber =
      favoriteRaw === true ? 1 : favoriteRaw === false ? 0 : Number.parseInt(favoriteRaw, 10);
    const favorite = Number.isFinite(favoriteNumber) && favoriteNumber > 0 ? 1 : 0;
    const ratingRaw = row.RATING ?? row.rating ?? 0;
    const rating = clampRating(Number(ratingRaw) || 0);
    const updateTs = Number(row.UPDATE_TS ?? row.update_ts ?? row.updateTs ?? 0);
    const bookletRaw = row.BOOKLET ?? row.booklet ?? 0;
    const bookletValue =
      bookletRaw === true ? 1 : bookletRaw === false ? 0 : Number.parseInt(bookletRaw, 10);
    const booklet = Number.isFinite(bookletValue) && bookletValue > 0 ? 1 : 0;
    const artistTidal = String(row.ARTIST_TIDAL ?? row.ARTIST ?? "");
    const titleTidal = String(row.TITLE_TIDAL ?? row.TITLE ?? "");
    const artistRaffaello = String(row.ARTIST_RAFFAELLO ?? row.ARTIST ?? artistTidal ?? "");
    const titleRaffaello = String(row.TITLE_RAFFAELLO ?? row.TITLE ?? titleTidal ?? "");
    const linkValue = String(row.TIDAL_LINK ?? row.LINK ?? "");
    const roonValue = String(row.ROON_ID ?? row.roon_id ?? "").trim();
    const roonId = roonValue || buildRoonId(id_albumu);
    return {
      id_albumu,
      selector,
      origSelector: selector,
      heard,
      favorite,
      rating,
      label: String(row.LABEL ?? ""),
      link: linkValue,
      format: String(row.FORMAT ?? row.format ?? ""),
      roon_id: roonId,
      spotify_link: String(row.SPOTIFY_LINK ?? row.spotify_link ?? ""),
      apple_music_link: String(row.APPLE_MUSIC_LINK ?? row.apple_music_link ?? ""),
      catalog_number: String(row.CATALOG_NUMBER ?? row.catalog_number ?? ""),
      picture: String(row.PICTURE ?? ""),
      artist: artistRaffaello,
      title: titleRaffaello,
      artist_raffaello: artistRaffaello,
      artist_tidal: artistTidal,
      title_raffaello: titleRaffaello,
      title_tidal: titleTidal,
      duration: Number(row.DURATION) || 0,
      release_date: releaseDate,
      update_ts: Number.isFinite(updateTs) && updateTs > 0 ? updateTs : null,
      booklet,
      release_original: row.RELEASE_DATE
    };
  }

  loadFromPayload(
    { records = [], collections = [], containers = [], folders = [], albumFolders = [], labelsHierarchy = [] } = {},
    { sheetName } = {}
  ) {
    if (Array.isArray(labelsHierarchy) && labelsHierarchy.length) {
      this.setLabelHierarchy(labelsHierarchy);
    }
    this.records = records.map((row) => this.convertRowToRecord(row));
    this.collectionsData = Array.isArray(collections) ? collections : [];
    this.containersData = Array.isArray(containers) ? containers : [];
    this.foldersData = Array.isArray(folders) ? folders : [];
    this.albumFoldersData = Array.isArray(albumFolders) ? albumFolders : [];
    this.currentSheetName = sheetName || this.currentSheetName || "Sheet1";
    this.indexesDirty = true;
    this.rebuildAll();
  }
  rebuildAll() {
    this.rebuildMetaStructures();
    this.buildSortedCaches();
    this.rebuildCategories();
  }

  rebuildMetaStructures() {
    this.collectionsList = new Set(["brak"]);
    this.collectionMeta = new Map([["brak", { containers: new Set() }]]);
    this.foldersList = new Set(["brak"]);
    this.containersList = new Set(["brak"]);
    this.folderMeta = new Map([["brak", { container: "brak" }]]);
    this.containerMeta = new Map([["brak", { folders: new Set(), collection: "brak" }]]);

    this.collectionsData.forEach((collection) => {
      const name = sanitizeName(collection?.name || collection);
      if (!name || name === "brak") return;
      this.collectionsList.add(name);
      if (!this.collectionMeta.has(name)) {
        this.collectionMeta.set(name, { containers: new Set() });
      }
    });

    this.containersData.forEach((container) => {
      const name = sanitizeName(container?.name || container);
      if (!name || name === "brak") return;
      const collectionName = sanitizeName(container?.collection) || "brak";
      if (!this.collectionsList.has(collectionName)) {
        this.collectionsList.add(collectionName);
      }
      if (!this.collectionMeta.has(collectionName)) {
        this.collectionMeta.set(collectionName, { containers: new Set() });
      }
      this.containersList.add(name);
      if (!this.containerMeta.has(name)) {
        this.containerMeta.set(name, { folders: new Set(), collection: collectionName });
      } else {
        this.containerMeta.get(name).collection = collectionName;
      }
      this.collectionMeta.get(collectionName).containers.add(name);
    });

    this.foldersData.forEach((folder) => {
      const folderName = sanitizeName(folder?.name || folder);
      if (!folderName || folderName === "brak") return;
      const containerName = sanitizeName(folder?.container) || "brak";
      this.foldersList.add(folderName);
      if (!this.containersList.has(containerName)) {
        this.containersList.add(containerName);
      }

      if (!this.containerMeta.has(containerName)) {
        this.containerMeta.set(containerName, { folders: new Set(), collection: "brak" });
        if (!this.collectionMeta.has("brak")) {
          this.collectionMeta.set("brak", { containers: new Set() });
        }
        this.collectionMeta.get("brak").containers.add(containerName);
      }
      const containerInfo = this.containerMeta.get(containerName);
      if (!containerInfo.folders) containerInfo.folders = new Set();
      containerInfo.folders.add(folderName);
      this.folderMeta.set(folderName, { container: containerName });
    });

    this.albumAssignments = new Map();
    this.recordsById = new Map();
    this.records.forEach((rec) => {
      if (rec.id_albumu) {
        this.albumAssignments.set(rec.id_albumu, []);
        this.recordsById.set(rec.id_albumu, rec);
      }
    });

      this.albumFoldersData.forEach((assignment) => {
      const albumId = Number(assignment.album_id || assignment.albumId || assignment.ID_ALBUMU);
      const folderName = sanitizeName(assignment.folder);
      if (!albumId || !folderName) return;
      if (!this.albumAssignments.has(albumId)) {
        this.albumAssignments.set(albumId, []);
      }
      const containerName = this.folderMeta.get(folderName)?.container || "brak";
      this.albumAssignments.get(albumId).push({
        folder: folderName,
        container: containerName,
        added_ts: Number(assignment.added_ts) || 0,
        row_order: Number(assignment.row_order) || 0
      });
    });

    this.records.forEach((rec) => {
      const assignments = this.albumAssignments.get(rec.id_albumu) || [];
      rec.folder_names = assignments.map((entry) => entry.folder);
    });
  }

  buildSortedCaches() {
    if (!this.indexesDirty) return;
    this.sortedByRelease = [...this.records].sort(compareByReleaseDesc);
    this.folderEntries = this.buildFolderEntries();
    this.sortedByAdded = [...this.folderEntries].sort(compareByAddedDesc);
    const years = new Set();
    this.records.forEach((record) => {
      if (record.release_date) {
        const year = new Date(record.release_date * 1000).getFullYear();
        if (!Number.isNaN(year)) years.add(year);
      }
    });
    this.releaseYears = Array.from(years).sort((a, b) => b - a);
    this.indexesDirty = false;
  }

  buildFolderEntries() {
    const entries = [];
    this.records.forEach((album) => {
      const assignments = this.albumAssignments.get(album.id_albumu) || [];
      if (!assignments.length) {
        entries.push({
          album,
          folder: "brak",
          container: "brak",
          added_ts: 0,
          row_order: 0
        });
        return;
      }
      assignments.forEach((assignment) => {
        entries.push({
          album,
          folder: assignment.folder,
          container: assignment.container || "brak",
          added_ts: assignment.added_ts || 0,
          row_order: assignment.row_order || 0
        });
      });
    });
    return entries;
  }

  getReleaseYears() {
    return this.releaseYears;
  }

  insertIntoSorted(list, album, comparator) {
    if (!album) return;
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (comparator(album, list[mid]) < 0) low = mid + 1;
      else high = mid;
    }
    list.splice(low, 0, album);
  }

  removeFromList(list, album) {
    const idx = list.indexOf(album);
    if (idx !== -1) list.splice(idx, 1);
  }

  applyFilters({
    releaseStartTs = null,
    releaseEndTs = null,
    labels = null,
    selectors = null,
    searchTerm = "",
    heardMin = null,
    heardMax = null,
    durationMin = null,
    durationMax = null,
    showFavorites = true
  } = {}) {
    const normalizedStart = Number.isFinite(releaseStartTs) ? releaseStartTs : null;
    const normalizedEnd = Number.isFinite(releaseEndTs) ? releaseEndTs : null;
    const [rangeStart, rangeEnd] =
      normalizedStart !== null && normalizedEnd !== null && normalizedStart > normalizedEnd
        ? [normalizedEnd, normalizedStart]
        : [normalizedStart, normalizedEnd];
    const labelsSet = labels ? new Set(labels) : new Set(this.selectedLabels);
    const labelsKey = Array.from(labelsSet).sort().join("|");
    const selectorsSet = selectors ? new Set(selectors) : new Set(this.selectedSelectors);
    const selectorsKey = Array.from(selectorsSet).sort().join("|");
    const searchKey = (searchTerm || "").trim().toLowerCase();
    const normalizedHeardMin = Number.isInteger(heardMin) ? clampHeard(heardMin) : null;
    const normalizedHeardMax = Number.isInteger(heardMax) ? clampHeard(heardMax) : null;
    const finalHeardMin =
      normalizedHeardMin !== null && normalizedHeardMax !== null && normalizedHeardMin > normalizedHeardMax
        ? normalizedHeardMax
        : normalizedHeardMin;
    const finalHeardMax =
      normalizedHeardMin !== null && normalizedHeardMax !== null && normalizedHeardMin > normalizedHeardMax
        ? normalizedHeardMin
        : normalizedHeardMax;
    const normalizedDurationMin = Number.isFinite(durationMin) && durationMin >= 0 ? durationMin * 60 : null;
    const normalizedDurationMax = Number.isFinite(durationMax) && durationMax >= 0 ? durationMax * 60 : null;
    const finalDurationMin =
      normalizedDurationMin !== null && normalizedDurationMax !== null && normalizedDurationMin > normalizedDurationMax
        ? normalizedDurationMax
        : normalizedDurationMin;
    const finalDurationMax =
      normalizedDurationMin !== null && normalizedDurationMax !== null && normalizedDurationMin > normalizedDurationMax
        ? normalizedDurationMin
        : normalizedDurationMax;
    const normalizedShowFavorites = showFavorites !== false;
    const changed =
      this.activeFilters.releaseStartTs !== rangeStart ||
      this.activeFilters.releaseEndTs !== rangeEnd ||
      this.activeFilters.labelsKey !== labelsKey ||
      this.activeFilters.selectorsKey !== selectorsKey ||
      this.activeFilters.searchKey !== searchKey ||
      this.activeFilters.heardMin !== finalHeardMin ||
      this.activeFilters.heardMax !== finalHeardMax ||
      this.activeFilters.durationMin !== finalDurationMin ||
      this.activeFilters.durationMax !== finalDurationMax ||
      this.activeFilters.showFavorites !== normalizedShowFavorites;

    if (changed) {
      this.activeFilters = {
        releaseStartTs: rangeStart,
        releaseEndTs: rangeEnd,
        labelsKey,
        labelsSet,
        selectorsKey,
        selectorsSet,
        searchKey,
        heardMin: finalHeardMin,
        heardMax: finalHeardMax,
        durationMin: finalDurationMin,
        durationMax: finalDurationMax,
        showFavorites: normalizedShowFavorites
      };
      this.sortedCategoryCache.clear();
    }
    this.selectedLabels = new Set(labelsSet);
    this.selectedSelectors = new Set(selectorsSet);
    return changed;
  }

  rebuildCategories(filters = null) {
    if (filters) {
      this.applyFilters(filters);
    }
    const hadDirtyIndexes = this.indexesDirty;
    if (hadDirtyIndexes) {
      this.rebuildMetaStructures();
      this.buildSortedCaches();
      this.sortedCategoryCache.clear();
    }

    const {
      releaseStartTs,
      releaseEndTs,
      labelsSet,
      selectorsSet,
      searchKey,
      heardMin,
      heardMax,
      durationMin,
      durationMax,
      showFavorites
    } = this.activeFilters;
    const allowedLabels = labelsSet || this.selectedLabels;
    const allowedSelectors = selectorsSet || this.selectedSelectors;
    const todayStart = new Date(new Date().toDateString()).getTime() / 1000;

    const categorized = { DB: [], NR: [], FD: [] };
    const folderBuckets = new Map();
    const containerBuckets = new Map();
    const folderCounts = new Map();
    const containerCounts = new Map();
    const foldersByContainer = new Map();

    const passesFilters = (entry) => {
      const album = getAlbumData(entry);
      if (!allowedLabels.has(album.label)) return false;
      if (!showFavorites && album.favorite) return false;
      if (!allowedSelectors.has(album.selector) && !(showFavorites && album.favorite)) return false;
      if (releaseStartTs && album.release_date && album.release_date < releaseStartTs) return false;
      if (releaseEndTs && album.release_date && album.release_date > releaseEndTs) return false;
      if (heardMin !== null || heardMax !== null) {
        const heardValue = clampHeard(album.heard || 0);
        if (heardMin !== null && heardValue < heardMin) return false;
        if (heardMax !== null && heardValue > heardMax) return false;
      }
      if (durationMin !== null && (Number(album.duration) || 0) < durationMin) return false;
      if (durationMax !== null && (Number(album.duration) || 0) > durationMax) return false;
      if (!matchesSearchKey(album, searchKey)) return false;
      return true;
    };

    this.sortedByRelease.forEach((album) => {
      if (!passesFilters(album)) return;
      categorized.DB.push(album);
      const diffDays = album.release_date ? Math.floor((todayStart - album.release_date) / 86400) : 9999;
      if (album.release_date && diffDays >= 0 && diffDays <= 6) {
        categorized.NR.push(album);
      }
    });
    this.sortedByAdded.forEach((entry) => {
      if (!passesFilters(entry)) return;
      categorized.FD.push(entry);
      const folderName = entry.folder || "brak";
      const containerName = entry.container || "brak";
      if (!folderBuckets.has(folderName)) folderBuckets.set(folderName, []);
      folderBuckets.get(folderName).push(entry);

      if (!containerBuckets.has(containerName)) containerBuckets.set(containerName, []);
      containerBuckets.get(containerName).push(entry);

      folderCounts.set(folderName, (folderCounts.get(folderName) || 0) + 1);
      containerCounts.set(containerName, (containerCounts.get(containerName) || 0) + 1);

      if (!foldersByContainer.has(containerName)) foldersByContainer.set(containerName, new Map());
      const map = foldersByContainer.get(containerName);
      map.set(folderName, (map.get(folderName) || 0) + 1);
    });

    this.categorized = categorized;
    this.newReleaseSet = new Set(categorized.NR);
     this.filteredFolderBuckets = folderBuckets;
    this.filteredContainerBuckets = containerBuckets;
    this.cachedCounts = { folders: folderCounts, containers: containerCounts, foldersByContainer };
    this.sortedCategoryCache.clear();
    return categorized;
  }

  rebuildFolderView({ ignoreFilters = false } = {}) {
    const {
      releaseStartTs,
      releaseEndTs,
      labelsSet,
      selectorsSet,
      searchKey,
      heardMin,
      heardMax,
      durationMin,
      durationMax,
      showFavorites
    } = this.activeFilters;
    const allowedLabels = labelsSet || this.selectedLabels;
    const allowedSelectors = selectorsSet || this.selectedSelectors;

    const folderBuckets = new Map();
    const containerBuckets = new Map();
    const folderCounts = new Map();
    const containerCounts = new Map();
    const foldersByContainer = new Map();
    const nextList = [];

    const passesFilters = (entry) => {
      const album = getAlbumData(entry);
      if (!allowedLabels.has(album.label)) return false;
      if (!showFavorites && album.favorite) return false;
      if (!allowedSelectors.has(album.selector) && !(showFavorites && album.favorite)) return false;
      if (releaseStartTs && album.release_date && album.release_date < releaseStartTs) return false;
      if (releaseEndTs && album.release_date && album.release_date > releaseEndTs) return false;
      if (heardMin !== null || heardMax !== null) {
        const heardValue = clampHeard(album.heard || 0);
        if (heardMin !== null && heardValue < heardMin) return false;
        if (heardMax !== null && heardValue > heardMax) return false;
      }
      if (durationMin !== null && (Number(album.duration) || 0) < durationMin) return false;
      if (durationMax !== null && (Number(album.duration) || 0) > durationMax) return false;
      if (!matchesSearchKey(album, searchKey)) return false;
      return true;
    };

    this.sortedByAdded.forEach((entry) => {
      if (!ignoreFilters && !passesFilters(entry)) return;
      nextList.push(entry);
      const folderName = entry.folder || "brak";
      const containerName = entry.container || "brak";
      if (!folderBuckets.has(folderName)) folderBuckets.set(folderName, []);
      folderBuckets.get(folderName).push(entry);

      if (!containerBuckets.has(containerName)) containerBuckets.set(containerName, []);
      containerBuckets.get(containerName).push(entry);

      folderCounts.set(folderName, (folderCounts.get(folderName) || 0) + 1);
      containerCounts.set(containerName, (containerCounts.get(containerName) || 0) + 1);

      if (!foldersByContainer.has(containerName)) foldersByContainer.set(containerName, new Map());
      const map = foldersByContainer.get(containerName);
      map.set(folderName, (map.get(folderName) || 0) + 1);
    });

    this.categorized.FD = nextList;
    this.filteredFolderBuckets = folderBuckets;
    this.filteredContainerBuckets = containerBuckets;
    this.cachedCounts = { folders: folderCounts, containers: containerCounts, foldersByContainer };
    this.sortedCategoryCache.clear();
    return nextList;
  }

  passesActiveFilters(albumLike) {
    if (!albumLike) return false;
    const album = getAlbumData(albumLike);
    const {
      releaseStartTs,
      releaseEndTs,
      labelsSet,
      selectorsSet,
      searchKey,
      durationMin,
      durationMax,
      showFavorites
    } = this.activeFilters;
    const allowedLabels = labelsSet || this.selectedLabels;
    const allowedSelectors = selectorsSet || this.selectedSelectors;
    if (!allowedLabels.has(album.label)) return false;
    if (!showFavorites && album.favorite) return false;
    if (!allowedSelectors.has(album.selector) && !(showFavorites && album.favorite)) return false;
    if (releaseStartTs && album.release_date && album.release_date < releaseStartTs) return false;
    if (releaseEndTs && album.release_date && album.release_date > releaseEndTs) return false;
    if (durationMin !== null && (Number(album.duration) || 0) < durationMin) return false;
    if (durationMax !== null && (Number(album.duration) || 0) > durationMax) return false;
    if (!matchesSearchKey(album, searchKey)) return false;
    return true;
  }

  getCategoryList(category) {
    return this.categorized[category] || [];
  }

  isNewRelease(entry) {
    const album = getAlbumData(entry);
    return this.newReleaseSet.has(album);
  }

  getAssignmentCounts() {
    let assigned = 0;
    this.records.forEach((album) => {
      const assignments = this.albumAssignments.get(album.id_albumu) || [];
      if (assignments.length) assigned += 1;
    });
    return { assigned, unassigned: this.records.length - assigned };
  }

  getFilteredCategoryList(category, { folderFilter, containerFilter } = {}) {
    return this.getSortedCategoryList(category, { folderFilter, containerFilter });
  }

  sortAlbums(list, { category } = {}) {
    if (this.sortMode === "release_desc" && (category === "DB" || category === "NR")) {
      return list;
    }
    const sorted = [...list];
    if (this.sortMode === "duration_asc" || this.sortMode === "duration_desc") {
      const factor = this.sortMode === "duration_asc" ? 1 : -1;
      sorted.sort((a, b) => {
        const albumA = getAlbumData(a);
        const albumB = getAlbumData(b);
        const left = Number(albumA.duration) || 0;
        const right = Number(albumB.duration) || 0;
        if (left === right) return (albumA.title || "").localeCompare(albumB.title || "", "pl");
        return (left - right) * factor;
      });
      return sorted;
    }
    if (this.sortMode === "release_asc") {
      sorted.sort(compareByReleaseAsc);
      return sorted;
    }
    if (this.sortMode === "release_desc") {
      sorted.sort(compareByReleaseDesc);
      return sorted;
    }
    return sorted;
  }

  setSortMode(mode) {
    const allowed = new Set(["release_desc", "release_asc", "duration_asc", "duration_desc"]);
    const normalized = allowed.has(mode) ? mode : "release_desc";
    if (this.sortMode === normalized) return false;
    this.sortMode = normalized;
    this.sortedCategoryCache.clear();
    return true;
  }

  getActiveFilterKey() {
    const {
      releaseStartTs,
      releaseEndTs,
      labelsKey,
      selectorsKey,
      searchKey,
      heardMin,
      heardMax,
      durationMin,
      durationMax,
      showFavorites
    } = this.activeFilters;
    return [
      releaseStartTs ?? "",
      releaseEndTs ?? "",
      labelsKey ?? "",
      selectorsKey ?? "",
      searchKey ?? "",
      heardMin ?? "",
      heardMax ?? "",
      durationMin ?? "",
      durationMax ?? "",
      showFavorites ? "1" : "0"
    ].join("|");
  }

  getSortedCategoryList(category, { folderFilter, containerFilter } = {}) {
    const normalizedFolder = folderFilter && folderFilter !== "__all__" ? folderFilter : "__all__";
    const normalizedContainer = containerFilter && containerFilter !== "__all__" ? containerFilter : "__all__";
    const filterKey = this.getActiveFilterKey();
    const cacheKey = [
      category,
      this.sortMode,
      filterKey,
      normalizedFolder,
      normalizedContainer
    ].join("::");
    if (this.sortedCategoryCache.has(cacheKey)) {
      return this.sortedCategoryCache.get(cacheKey);
    }
    let list = this.getCategoryList(category);
    if (category === "FD") {
      if (normalizedFolder !== "__all__") {
        list = this.filteredFolderBuckets.get(normalizedFolder) || [];
      } else if (normalizedContainer !== "__all__") {
        list = this.filteredContainerBuckets.get(normalizedContainer) || [];
      }
    }

    const sortedList = this.sortAlbums(list, { category });
    this.sortedCategoryCache.set(cacheKey, sortedList);
    return sortedList;
  }

  getPagedCategory(category, page, { folderFilter, containerFilter } = {}) {
    const sortableList = this.getSortedCategoryList(category, { folderFilter, containerFilter });

    const total = sortableList.length;
    const totalPages = total ? Math.ceil(total / ALBUMS_PER_PAGE) : 0;
    const safePage = totalPages === 0 ? 0 : Math.min(Math.max(page, 0), totalPages - 1);
    const start = safePage * ALBUMS_PER_PAGE;
    const end = start + ALBUMS_PER_PAGE;
    return {
      pageItems: sortableList.slice(start, end),
      total,
      totalPages,
      currentPage: safePage
    };
  }

  adjustHeard(album, delta) {
    if (!album || typeof delta !== "number") return { changed: false, value: album?.heard ?? 0 };
    const current = clampHeard(Number(album.heard) || 0);
    const next = clampHeard(current + delta);
    if (next === current) return { changed: false, value: current };
    this.syncRecord(album, { heard: next });
    this.indexesDirty = true;
    return { changed: true, value: next };
  }

  addAlbumToFolder(album, targetFolder) {
    if (!album || !targetFolder || targetFolder === "__all__") return null;
    const normalizedTarget = sanitizeName(targetFolder) || "brak";
    if (normalizedTarget === "brak") return null;
    if (!this.folderMeta.has(normalizedTarget)) {
      throw new Error("Wybrany folder nie istnieje w aktualnej liście.");
    }

    const albumId = album.id_albumu;
    if (!albumId) return null;
    const assignments = this.albumAssignments.get(albumId) || [];
    if (assignments.some((entry) => entry.folder === normalizedTarget)) return null;
    const containerName = this.folderMeta.get(normalizedTarget)?.container || "brak";
    const now = Date.now();
    let maxOrder = 0;
    this.albumAssignments.forEach((entries) => {
      entries.forEach((entry) => {
        if (entry.folder === normalizedTarget) {
          maxOrder = Math.max(maxOrder, entry.row_order || 0);
        }
      });
    });
    assignments.push({
      folder: normalizedTarget,
      container: containerName,
      added_ts: now,
      row_order: maxOrder + 1
    });
    this.albumAssignments.set(albumId, assignments);
    album.folder_names = assignments.map((entry) => entry.folder);
    this.albumFoldersData = this.getSerializableAlbumFolders();
    this.indexesDirty = true;
    this.rebuildAll();
    return { folder: normalizedTarget, container: containerName };
  }

  removeAlbumFromFolder(album, targetFolder) {
    if (!album || !targetFolder || targetFolder === "__all__") return null;
    const normalizedTarget = sanitizeName(targetFolder) || "brak";
    if (normalizedTarget === "brak") return null;
    const albumId = album.id_albumu;
    if (!albumId) return null;
    const assignments = this.albumAssignments.get(albumId) || [];
    const nextAssignments = assignments.filter((entry) => entry.folder !== normalizedTarget);
    if (nextAssignments.length === assignments.length) return null;
    this.albumAssignments.set(albumId, nextAssignments);
    album.folder_names = nextAssignments.map((entry) => entry.folder);
    this.albumFoldersData = this.getSerializableAlbumFolders();
    this.indexesDirty = true;
    this.rebuildAll();
    return { folder: normalizedTarget };
  }

    renameFolderRecords(oldName, newName, container = "brak") {
    const source = sanitizeName(oldName) || "brak";
    const target = sanitizeName(newName) || "brak";
    const targetContainer = sanitizeName(container) || "brak";
    if (source === target) return { changed: false };

    let changed = true;
    this.albumAssignments.forEach((assignments, albumId) => {
      assignments.forEach((entry) => {
        if (entry.folder === source) {
          entry.folder = target;
          entry.container = targetContainer;
          changed = true;
        }
      });
      if (changed) {
        const album = this.records.find((rec) => rec.id_albumu === albumId);
        if (album) {
          album.folder_names = assignments.map((entry) => entry.folder);
        }
      }
    });

    if (this.folderMeta.has(source)) {
      this.folderMeta.delete(source);
    }
    if (this.foldersList.has(source)) {
      this.foldersList.delete(source);
    }
    this.containerMeta.forEach((info) => info.folders?.delete(source));
    if (target !== "brak") {
      const targetContainerEntry = this.ensureContainerEntry(targetContainer);
      targetContainerEntry.folders.add(target);
      this.ensureFolderEntry(target, targetContainer);
      changed = true;
    }

    if (changed) {
      this.albumFoldersData = this.getSerializableAlbumFolders();
      this.syncFolderData();
      this.indexesDirty = true;
      this.rebuildAll();
    }
    return { changed };
  }

  renameContainerRecords(oldName, newName) {
    const source = sanitizeName(oldName) || "brak";
    const target = sanitizeName(newName) || "brak";
    if (source === target) return { changed: false };

    const sourceCollection = this.containerMeta.get(source)?.collection || "brak";

    let changed = true;
    this.folderMeta.forEach((meta) => {
      if (meta.container === source) {
        meta.container = target;
        changed = true;
      }
      });

    this.albumAssignments.forEach((assignments) => {
      assignments.forEach((entry) => {
        if (entry.container === source) {
          entry.container = target;
          changed = true;
        }
      });
    });

    if (this.containerMeta.has(source)) {
      this.containerMeta.delete(source);
    }
    if (this.containersList.has(source)) {
      this.containersList.delete(source);
    }
    if (this.collectionMeta.has(sourceCollection)) {
      this.collectionMeta.get(sourceCollection).containers?.delete(source);
    }
    const targetInfo = this.ensureContainerEntry(target, sourceCollection);
    if (!this.collectionMeta.has(sourceCollection)) {
      this.collectionMeta.set(sourceCollection, { containers: new Set() });
    }
    this.collectionMeta.get(sourceCollection).containers.add(target);
    this.folderMeta.forEach((meta, folder) => {
      if (meta.container === target && folder !== "brak") {
        targetInfo.folders.add(folder);
      }
    });
    if (target !== "brak") changed = true;

    if (changed) {
      this.albumFoldersData = this.getSerializableAlbumFolders();
      this.syncFolderData();
      this.indexesDirty = true;
      this.rebuildAll();
    }
    return { changed };
  }

  setContainerCollection(name, collection) {
    const target = sanitizeName(name) || "brak";
    const nextCollection = sanitizeName(collection) || "brak";
    const entry = this.containerMeta.get(target);
    if (!entry || target === "brak") return { changed: false };
    const prevCollection = entry.collection || "brak";
    if (prevCollection === nextCollection) return { changed: false };
    entry.collection = nextCollection;
    this.ensureCollectionEntry(nextCollection).containers.add(target);
    if (this.collectionMeta.has(prevCollection)) {
      this.collectionMeta.get(prevCollection).containers?.delete(target);
    }
    this.syncFolderData();
    this.indexesDirty = true;
    this.rebuildAll();
    return { changed: true };
  }

  renameCollectionRecords(oldName, newName) {
    const source = sanitizeName(oldName) || "brak";
    const target = sanitizeName(newName) || "brak";
    if (source === target || source === "brak") return { changed: false };

    const containers = Array.from(this.collectionMeta.get(source)?.containers || []);
    containers.forEach((container) => {
      const entry = this.containerMeta.get(container);
      if (entry) entry.collection = target;
    });

    this.collectionMeta.delete(source);
    this.collectionsList.delete(source);
    this.ensureCollectionEntry(target);
    const targetMeta = this.collectionMeta.get(target);
    containers.forEach((container) => targetMeta.containers.add(container));

    this.syncFolderData();
    this.indexesDirty = true;
    this.rebuildAll();
    return { changed: true };
  }

  clearCollectionAssignments(name) {
    const target = sanitizeName(name) || "brak";
    if (target === "brak") return { changed: false };

    let changed = false;
    const fallback = "brak";
    const fallbackMeta = this.ensureCollectionEntry(fallback);

    this.containerMeta.forEach((meta, container) => {
      if (meta.collection === target) {
        meta.collection = fallback;
        fallbackMeta.containers.add(container);
        changed = true;
      }
    });

    if (this.collectionMeta.has(target) || this.collectionsList.has(target)) {
      changed = true;
    }
    this.collectionMeta.delete(target);
    this.collectionsList.delete(target);

    if (changed) {
      this.syncFolderData();
      this.indexesDirty = true;
      this.rebuildAll();
    }
    return { changed };
  }

  clearFolderAssignments(name) {
    const target = sanitizeName(name) || "brak";
    if (target === "brak") return { changed: false };

    let changed = false;
    this.albumAssignments.forEach((assignments, albumId) => {
      const nextAssignments = assignments.filter((entry) => entry.folder !== target);
      if (nextAssignments.length !== assignments.length) {
        this.albumAssignments.set(albumId, nextAssignments);
        const album = this.records.find((rec) => rec.id_albumu === albumId);
        if (album) {
          album.folder_names = nextAssignments.map((entry) => entry.folder);
        }
        changed = true;
      }
    });

    if (this.folderMeta.has(target) || this.foldersList.has(target)) {
      changed = true;
    }
    this.folderMeta.delete(target);
    this.foldersList.delete(target);
    this.containerMeta.forEach((info) => info.folders?.delete(target));

    if (changed) {
      this.albumFoldersData = this.getSerializableAlbumFolders();
      this.syncFolderData();
      this.indexesDirty = true;
      this.rebuildAll();
    }
    return { changed };
  }

  clearContainerAssignments(name) {
    const target = sanitizeName(name) || "brak";
    if (target === "brak") return { changed: false };

    let changed = false;
    this.folderMeta.forEach((meta) => {
      if (meta.container === target) {
        meta.container = "brak";
        changed = true;
      }
    });

    this.albumAssignments.forEach((assignments) => {
      assignments.forEach((entry) => {
        if (entry.container === target) {
          entry.container = "brak";
          changed = true;
        }
      });
    });

    if (this.containerMeta.has(target) || this.containersList.has(target)) {
      changed = true;
    }
    const collectionName = this.containerMeta.get(target)?.collection || "brak";
    if (this.collectionMeta.has(collectionName)) {
      this.collectionMeta.get(collectionName).containers?.delete(target);
    }
    this.containerMeta.delete(target);
    this.containersList.delete(target);

    if (changed) {
      this.albumFoldersData = this.getSerializableAlbumFolders();
      this.syncFolderData();
      this.indexesDirty = true;
      this.rebuildAll();
    }
    return { changed };
  }

  syncRecord(record, updates) {
    if (!record || !updates) return;
    Object.assign(record, updates);
  }

  syncFolderData() {
    this.collectionsData = this.getSerializableCollections();
    this.containersData = this.getSerializableContainers();
    this.foldersData = this.getSerializableFolders();
  }

  getFolderCounts(containerFilter) {
   if (containerFilter && containerFilter !== "__all__") {
      const scoped = this.cachedCounts.foldersByContainer.get(containerFilter) || new Map();
      return Object.fromEntries(scoped.entries());
    }
    return Object.fromEntries(this.cachedCounts.folders.entries());
  }

  getContainerCounts() {
     return Object.fromEntries(this.cachedCounts.containers.entries());
  }

  getFoldersForContainer(container) {
    if (!container || container === "__all__") return Array.from(this.foldersList);
    return Array.from(this.containerMeta.get(container)?.folders || []);
  }

  getContainersForCollection(collection) {
    if (!collection || collection === "__all__") return Array.from(this.containersList);
    return Array.from(this.collectionMeta.get(collection)?.containers || []);
  }

  getFoldersForCollection(collection) {
    if (!collection || collection === "__all__") return Array.from(this.foldersList);
    const containers = this.getContainersForCollection(collection);
    const folderSet = new Set();
    containers.forEach((container) => {
      const entry = this.containerMeta.get(container);
      entry?.folders?.forEach((folder) => folderSet.add(folder));
    });
    return Array.from(folderSet);
  }

  getAlbumFolderList(album) {
    if (!album) return [];
    const albumId = album.id_albumu;
    if (!albumId) return [];
    return Array.from(
      new Set((this.albumAssignments.get(albumId) || []).map((entry) => entry.folder).filter(Boolean))
    );
  }

  getAlbumsForFolder(folderName) {
    const target = sanitizeName(folderName);
    if (!target || target === "brak") return [];
    const albums = [];
    this.albumAssignments.forEach((assignments, albumId) => {
      if (!assignments.some((entry) => entry.folder === target)) return;
      const album = this.recordsById.get(albumId);
      if (album) albums.push(album);
    });
    return albums;
  }

  isAlbumAssigned(album) {
    return this.getAlbumFolderList(album).length > 0;
  }

  getLabelSelection() {
    return new Set(this.selectedLabels);
  }

  setLabelHierarchy(labelsHierarchy = []) {
    const before = new Set(LABEL_MAP.keys());
    const previousSelection = new Set(this.selectedLabels || []);
    const hadAllBefore =
      before.size > 0 &&
      previousSelection.size === before.size &&
      Array.from(before).every((label) => previousSelection.has(label));

    setLabelHierarchy(labelsHierarchy);
    const next = new Set(LABEL_MAP.keys());
    // Previous logic always intersected previous selection with the new label list,
    // which dropped freshly added labels even when the user had "select all" enabled.
    // Keep full selection when all labels were selected before refresh; otherwise keep partial intersection.
    const nextSelection = hadAllBefore
      ? new Set(next)
      : new Set(Array.from(previousSelection).filter((label) => next.has(label)));

    if (!nextSelection.size) {
      next.forEach((label) => nextSelection.add(label));
    }
    this.selectedLabels = nextSelection;
    if (this.activeFilters) {
      this.activeFilters.labelsSet = new Set(nextSelection);
      this.activeFilters.labelsKey = Array.from(nextSelection).sort().join("|");
    }
    return before.size !== next.size;
  }

  setLabelSelection(labels) {
    this.selectedLabels = new Set(labels);
  }

  getSelectorSelection() {
    return new Set(this.selectedSelectors);
  }

  setSelectorSelection(selectors) {
    this.selectedSelectors = new Set(selectors || DEFAULT_SELECTORS);
  }

  getSerializableRecords() {
    return this.records.map((rec) => {
      const originalValue = rec.release_original;
      const numericOriginal = Number(originalValue);
      const releaseValue =
        Number.isFinite(numericOriginal) && numericOriginal > 0 ? originalValue : rec.release_date || 0;
      return {
        ID_ALBUMU: rec.id_albumu || "",
        SELECTOR: rec.selector || rec.origSelector || "N",
        HEARD: clampHeard(rec.heard || 0),
        FAVORITE: rec.favorite ? 1 : 0,
        RATING: clampRating(rec.rating || 0),
        LABEL: rec.label || "",
        TIDAL_LINK: rec.link || "",
        FORMAT: rec.format || "",
        ROON_ID: rec.roon_id || buildRoonId(rec.id_albumu),
        SPOTIFY_LINK: rec.spotify_link || "",
        APPLE_MUSIC_LINK: rec.apple_music_link || "",
        CATALOG_NUMBER: rec.catalog_number || "",
        PICTURE: rec.picture || "",
        ARTIST_RAFFAELLO: rec.artist_raffaello || rec.artist || "",
        ARTIST_TIDAL: rec.artist_tidal || rec.artist || "",
        TITLE_RAFFAELLO: rec.title_raffaello || rec.title || "",
        TITLE_TIDAL: rec.title_tidal || rec.title || "",
        DURATION: rec.duration || 0,
        RELEASE_DATE: releaseValue,
        UPDATE_TS: rec.update_ts || null,
        BOOKLET: rec.booklet ? 1 : 0
      };
    });
  }

  getSerializableCollections() {
    return Array.from(this.collectionsList)
      .filter((name) => name && name !== "brak")
      .map((name, index) => ({
        name,
        sort_order: index
      }));
  }

  getSerializableContainers() {
    return Array.from(this.containersList)
      .filter((name) => name && name !== "brak")
      .map((name, index) => ({
        name,
        sort_order: index,
        collection: this.containerMeta.get(name)?.collection || "brak"
      }));
  }

  getSerializableFolders() {
    return Array.from(this.foldersList)
      .filter((name) => name && name !== "brak")
      .map((name, index) => ({
        name,
        container: this.folderMeta.get(name)?.container || "brak",
        sort_order: index
      }));
  }

  getSerializableAlbumFolders() {
    const entries = [];
    this.albumAssignments.forEach((assignments, albumId) => {
      if (!albumId) return;
      assignments.forEach((entry, index) => {
        entries.push({
          album_id: albumId,
          folder: entry.folder,
          added_ts: entry.added_ts || 0,
          row_order: entry.row_order || index
        });
      });
    });
    return entries;
  }

  buildWorkbook() {
    const headers = [
      "ID_ALBUMU",
      "SELECTOR",
      "HEARD",
      "FAVORITE",
      "RATING",
      "LABEL",
      "TIDAL_LINK",
      "FORMAT",
      "ROON_ID",
      "SPOTIFY_LINK",
      "APPLE_MUSIC_LINK",
      "CATALOG_NUMBER",
      "PICTURE",
      "ARTIST_RAFFAELLO",
      "ARTIST_TIDAL",
      "TITLE_RAFFAELLO",
      "TITLE_TIDAL",
      "DURATION",
      "RELEASE_DATE"
    ];
    const data = this.getSerializableRecords();
    const worksheet = window.XLSX.utils.json_to_sheet(data, { header: headers, skipHeader: false });
    const workbook = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(workbook, worksheet, this.currentSheetName || "Sheet1");
    return workbook;
  }

  getHierarchy() {
    return [...LABEL_HIERARCHY];
  }

  formatDuration(seconds) {
    return formatDuration(seconds);
  }

  truncateName(name, n) {
    return truncateName(name, n);
  }

  getCategoryClass(cat) {
    return CATEGORY_CLASSES[cat] || "";
  }

  updateSelector(album, nextSelector) {
    if (!album) return;
    album.selector = nextSelector;
    this.syncRecord(album, { selector: nextSelector });
  }

  updateAlbumData(album, updates = {}) {
    if (!album || !updates) return { changed: false };
    const changes = {};
    Object.entries(updates).forEach(([key, value]) => {
      if (album[key] !== value) {
        changes[key] = value;
      }
    });
    if (!Object.keys(changes).length) return { changed: false };
    Object.assign(album, changes);
    this.syncRecord(album, changes);
    this.indexesDirty = true;
    return { changed: true };
  }

  setAlbumFavorite(album, isFavorite) {
    if (!album) return;
    const nextValue = isFavorite ? 1 : 0;
    if (album.favorite === nextValue) return;
    album.favorite = nextValue;
    this.syncRecord(album, { favorite: nextValue });
  }

  removeAlbumFromDatabase(album) {
    if (!album) return { changed: false };
    const albumId = album.id_albumu;
    if (!albumId) return { changed: false };
    const index = this.records.findIndex((rec) => rec.id_albumu === albumId);
    if (index === -1) return { changed: false };
    this.records.splice(index, 1);
    this.albumAssignments.delete(albumId);
    this.albumFoldersData = this.getSerializableAlbumFolders();
    this.indexesDirty = true;
    this.rebuildAll();
    return { changed: true };
  }

  addAlbumsToFolder(albums, targetFolder) {
    if (!Array.isArray(albums) || !albums.length) return { added: 0 };
    if (!targetFolder || targetFolder === "__all__") return { added: 0 };
    const normalizedTarget = sanitizeName(targetFolder) || "brak";
    if (normalizedTarget === "brak") return { added: 0 };
    if (!this.folderMeta.has(normalizedTarget)) {
      throw new Error("Wybrany folder nie istnieje w aktualnej liście.");
    }

    const containerName = this.folderMeta.get(normalizedTarget)?.container || "brak";
    let maxOrder = 0;
    this.albumAssignments.forEach((entries) => {
      entries.forEach((entry) => {
        if (entry.folder === normalizedTarget) {
          maxOrder = Math.max(maxOrder, entry.row_order || 0);
        }
      });
    });

    let added = 0;
    const now = Date.now();
    albums.forEach((entry) => {
      const album = getAlbumData(entry);
      const albumId = album?.id_albumu;
      if (!albumId) return;
      const assignments = this.albumAssignments.get(albumId) || [];
      if (assignments.some((assignment) => assignment.folder === normalizedTarget)) return;
      assignments.push({
        folder: normalizedTarget,
        container: containerName,
        added_ts: now,
        row_order: maxOrder + 1
      });
      maxOrder += 1;
      this.albumAssignments.set(albumId, assignments);
      album.folder_names = assignments.map((assignment) => assignment.folder);
      added += 1;
    });

    if (added) {
      this.albumFoldersData = this.getSerializableAlbumFolders();
      this.indexesDirty = true;
      this.rebuildAll();
    }
    return { added };
  }
  
  ensureFolderEntry(name, container = "brak") {
    const normalized = sanitizeName(name) || "brak";
    const normalizedContainer = sanitizeName(container) || "brak";
    if (!this.folderMeta.has(normalized)) {
      this.folderMeta.set(normalized, { container: normalizedContainer });
    }
    const entry = this.folderMeta.get(normalized);
    entry.container = normalizedContainer || entry.container || "brak";
    const containerEntry = this.ensureContainerEntry(entry.container);
    containerEntry.folders.add(normalized);
    this.foldersList.add(normalized);
    this.syncFolderData();
    return entry;
  }

  ensureContainerEntry(name, collection = "brak") {
    const normalized = sanitizeName(name) || "brak";
    const normalizedCollection = sanitizeName(collection) || "brak";
    if (!this.containerMeta.has(normalized)) {
      this.containerMeta.set(normalized, { folders: new Set(), collection: normalizedCollection });
    }
    const entry = this.containerMeta.get(normalized);
    if (!entry.folders) entry.folders = new Set();
    if (normalizedCollection && normalizedCollection !== "brak") {
      entry.collection = normalizedCollection;
    }
    this.containersList.add(normalized);
    const collectionEntry = this.ensureCollectionEntry(entry.collection || "brak");
    collectionEntry.containers.add(normalized);
    this.syncFolderData();
    return entry;
  }

  ensureCollectionEntry(name) {
    const normalized = sanitizeName(name) || "brak";
    if (!this.collectionMeta.has(normalized)) {
      this.collectionMeta.set(normalized, { containers: new Set() });
    }
    this.collectionsList.add(normalized);
    return this.collectionMeta.get(normalized);
  }

  getFolderColor(name) {
    const normalized = sanitizeName(name) || "brak";
    return normalized === "brak" ? DEFAULT_EMPTY_COLOR : DEFAULT_FOLDER_COLOR;
  }

  getContainerColor(name) {
    const normalized = sanitizeName(name) || "brak";
    return normalized === "brak" ? DEFAULT_EMPTY_COLOR : DEFAULT_CONTAINER_COLOR;
  }
}

export {
  DataStore,
  DEFAULT_FOLDER_COLOR,
  DEFAULT_CONTAINER_COLOR,
  DEFAULT_EMPTY_COLOR,
  ALBUMS_PER_PAGE,
  CATEGORY_CLASSES,
  LABEL_HIERARCHY,
  LABEL_MAP,
  setLabelHierarchy,
  formatStatusDate,
  formatDuration,
  truncateName
};
