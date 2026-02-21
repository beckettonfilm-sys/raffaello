const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require("electron");
const { execFile } = require("child_process");
const path = require("path");
const http = require("http");
const https = require("https");
const {
  ensureSchema,
  fetchAlbums,
  fetchCollections,
  fetchContainers,
  fetchFolders,
  fetchAlbumFolders,
  fetchFilterPresets,
  replaceAlbums,
  replaceFolderData,
  appendRecords,
  getAlbumImportState,
  importJsonAlbums,
  checkDatabaseRecords,
  saveFilterPreset,
  renameFilterPreset,
  deleteFilterPreset,
  createDatabaseBackup,
  TABLE_NAME
} = require("./db");
const XLSX = require("xlsx");
const fs = require("fs");
const { runQobuzScraper } = require("./qobuzScraper");

const SHEET_NAME = "SQLite";

// Dodatkowe arkusze – backup/restore folderów i kontenerów.
// (Stare pliki XLSX mogą ich nie mieć – wtedy import zachowuje bieżące dane folderów z DB.)
const EXTRA_SHEETS = {
  collections: "COLLECTIONS",
  containers: "CONTAINERS",
  folders: "FOLDERS",
  albumFolders: "ALBUM_FOLDERS"
};

const FILES_ROOT_FOLDER = "FILES";
const FILES_MIGRATION_FOLDERS = ["CD_TEMPLATE", "LABELS", "pic_max", "pic_mini", "DATABASE", "BOOKLET", "FORMAT", "icons"];

function getAppDirectory() {
  return app.getAppPath() || __dirname;
}

function getFilesRoot(appDirectory = getAppDirectory()) {
  return path.join(appDirectory, FILES_ROOT_FOLDER);
}

function normalizeFilesSubpath(segment = "") {
  const normalized = String(segment || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return "";
  if (normalized === FILES_ROOT_FOLDER) return "";
  if (normalized.startsWith(`${FILES_ROOT_FOLDER}/`)) {
    return normalized.slice(FILES_ROOT_FOLDER.length + 1);
  }
  return normalized;
}

function getFilesPath(appDirectory = getAppDirectory(), ...segments) {
  const normalizedSegments = segments
    .map((segment) => normalizeFilesSubpath(segment))
    .filter(Boolean)
    .flatMap((segment) => segment.split("/").filter(Boolean));
  return path.join(getFilesRoot(appDirectory), ...normalizedSegments);
}

async function pathExists(targetPath) {
  try {
    await fs.promises.access(targetPath, fs.constants.F_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

async function moveFileSafe(sourcePath, targetPath) {
  try {
    await fs.promises.rename(sourcePath, targetPath);
  } catch (error) {
    if (error?.code === "EXDEV") {
      await fs.promises.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
      await fs.promises.unlink(sourcePath);
      return;
    }
    throw error;
  }
}

async function mergeDirectorySafe(sourceDir, targetDir) {
  await ensureDirectory(targetDir);
  const entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await mergeDirectorySafe(sourcePath, targetPath);
      try {
        await fs.promises.rmdir(sourcePath);
      } catch (_error) {}
      continue;
    }
    if (await pathExists(targetPath)) {
      console.log(`[FILES migration] Pomijam istniejący plik: ${targetPath}`);
      continue;
    }
    await moveFileSafe(sourcePath, targetPath);
    console.log(`[FILES migration] Przeniesiono plik: ${sourcePath} -> ${targetPath}`);
  }
}

async function migrateLegacyAssetsToFiles(appDirectory = getAppDirectory()) {
  const filesRoot = getFilesRoot(appDirectory);
  await ensureDirectory(filesRoot);

  for (const folderName of FILES_MIGRATION_FOLDERS) {
    const sourceDir = path.join(appDirectory, folderName);
    const targetDir = getFilesPath(appDirectory, folderName);
    if (!(await pathExists(sourceDir))) continue;

    if (!(await pathExists(targetDir))) {
      await fs.promises.rename(sourceDir, targetDir);
      console.log(`[FILES migration] Przeniesiono folder: ${sourceDir} -> ${targetDir}`);
      continue;
    }

    await mergeDirectorySafe(sourceDir, targetDir);
    try {
      await fs.promises.rmdir(sourceDir);
    } catch (_error) {}
    console.log(`[FILES migration] Scalono folder: ${sourceDir} -> ${targetDir}`);
  }
}

function getWorksheetByName(workbook, preferredName) {
  if (!workbook?.Sheets) return null;
  if (preferredName && workbook.Sheets[preferredName]) return workbook.Sheets[preferredName];
  if (!preferredName) return null;

  // Case-insensitive fallback (Excel potrafi przestawić / zmienić wielkość liter).
  const match = (workbook.SheetNames || []).find(
    (name) => String(name || "").trim().toLowerCase() === String(preferredName).trim().toLowerCase()
  );
  return match ? workbook.Sheets[match] : null;
}

function sheetToJsonSafe(worksheet) {
  if (!worksheet) return [];
  return XLSX.utils.sheet_to_json(worksheet, { defval: "" });
}

function buildAlbumIdSet(rows = []) {
  const set = new Set();
  rows.forEach((row) => {
    const id = Number(row?.ID_ALBUMU);
    if (Number.isFinite(id) && id > 0) set.add(id);
  });
  return set;
}

function normalizeContainersFromFolders(folders = []) {
  const seen = new Set();
  const result = [];
  folders.forEach((folder) => {
    const name = String(folder?.container || "").trim();
    if (!name) return;
    if (seen.has(name)) return;
    seen.add(name);
    result.push({ name, sort_order: result.length });
  });
  return result;
}

function normalizeCollectionsFromContainers(containers = []) {
  const seen = new Set();
  const result = [];
  containers.forEach((container) => {
    const name = String(container?.collection || "").trim();
    if (!name) return;
    if (seen.has(name)) return;
    seen.add(name);
    result.push({ name, sort_order: result.length });
  });
  return result;
}

const DATA_PREFIXES = {
  importDb: "music_database",
  updateDb: "update_database",
  importJson: "update_json"
};

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

function formatTimestampForFileName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}_${pad(date.getHours())}-${pad(
    date.getMinutes()
  )}-${pad(date.getSeconds())}`;
}

function buildTimestampedName(prefix, extension = "xlsx") {
  return `${prefix}_${formatTimestampForFileName()}.${extension}`;
}

function buildDuplicateAlbumsFileName() {
  return `zdublowane_albumy_${formatTimestampForFileName()}.xlsx`;
}

async function findLatestDataFile(targetDir, prefix) {
  const regex = new RegExp(
    `^${prefix}_(\\d{2})-(\\d{2})-(\\d{4})_(\\d{2})-(\\d{2})-(\\d{2})\\.xlsx$`,
    "i"
  );
  const entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    const match = entry.isFile() ? entry.name.match(regex) : null;
    if (!match) continue;
    const fullPath = path.join(targetDir, entry.name);
    const stats = await fs.promises.stat(fullPath);
    const [, day, month, year, hour, minute, second] = match;
    const parsedDate = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );
    const stamp = Number.isFinite(parsedDate.getTime()) ? parsedDate.getTime() : stats.mtimeMs;
    candidates.push({ name: entry.name, path: fullPath, timestamp: stamp });
  }

  candidates.sort((a, b) => b.timestamp - a.timestamp);
  return candidates[0] || null;
}

async function resolveSourceFile({ directory, filePath, prefix }) {
  const targetDir = directory || getAppDirectory();
  await ensureDirectory(targetDir);

  if (filePath) {
    const normalized = path.resolve(filePath);
    if (!fs.existsSync(normalized)) {
      throw new Error(`Wybrany plik nie istnieje: ${normalized}`);
    }
    return { path: normalized, name: path.basename(normalized) };
  }

  const latest = await findLatestDataFile(targetDir, prefix);
  if (!latest) {
    throw new Error(`Brak pliku ${prefix}_DD-MM-RRRR_HH-MM-SS.xlsx w folderze ${targetDir}.`);
  }
  return { path: latest.path, name: latest.name };
}

async function findLatestJsonFile(targetDir) {
  const entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".json")) continue;
    const fullPath = path.join(targetDir, entry.name);
    const stats = await fs.promises.stat(fullPath);
    candidates.push({ name: entry.name, path: fullPath, timestamp: stats.mtimeMs });
  }

  candidates.sort((a, b) => b.timestamp - a.timestamp);
  return candidates[0] || null;
}

async function resolveJsonSourceFile({ directory, filePath } = {}) {
  const targetDir = directory || getAppDirectory();
  await ensureDirectory(targetDir);

  if (filePath) {
    const normalized = path.resolve(filePath);
    if (!fs.existsSync(normalized)) {
      throw new Error(`Wybrany plik nie istnieje: ${normalized}`);
    }
    return { path: normalized, name: path.basename(normalized) };
  }

  const latest = await findLatestJsonFile(targetDir);
  if (!latest) {
    throw new Error(`Brak plików JSON w folderze ${targetDir}.`);
  }
  return { path: latest.path, name: latest.name };
}

function normalizeJsonRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const candidates = ["albums", "records", "items", "data"];
    for (const key of candidates) {
      if (Array.isArray(payload[key])) return payload[key];
    }
  }
  return [];
}

function parseJsonReleaseDate(value) {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number") {
    if (value > 1000000000000) return Math.floor(value / 1000);
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

function extractTidalAlbumId(link = "") {
  if (!link) return "";
  const match = String(link).match(/tidal\.com\/(?:browse\/)?album\/(\d+)/i);
  return match ? match[1] : "";
}

function parseJsonDuration(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric);
}

function sanitizeJsonText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function buildFolderNameForIssues(missingFields, isDuplicate) {
  const parts = [];
  if (isDuplicate) parts.push("duplikat");
  missingFields.forEach((field) => {
    parts.push(`brak_${field}`);
  });
  return parts.join("_and_");
}

async function loadLabelHierarchy() {
  const baseDir = getAppDirectory();
  const labelsPath = path.join(baseDir, "labels.txt");
  try {
    const raw = await fs.promises.readFile(labelsPath, "utf8");
    const parsed = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return parsed.length ? parsed : [...DEFAULT_LABEL_HIERARCHY];
  } catch (error) {
    return [...DEFAULT_LABEL_HIERARCHY];
  }
}

function getLabelNameFromHierarchy(entry) {
  const parts = String(entry || "").split(" - ");
  parts.shift();
  return parts.join(" - ").trim();
}

function buildUrlWithSize(url, targetSize) {
  if (!url) return "";
  const safe = String(url);
  // Replace ".../320x320.jpg" or ".../640x640.png" etc.
  const replaced = safe.replace(/\/\d{2,4}x\d{2,4}(?=\.[A-Za-z0-9]+(?:\?.*)?$)/, `/${targetSize}`);
  if (replaced !== safe) return replaced;
  // Fallback for simple string occurrence.
  return safe
    .replace("160x160", targetSize)
    .replace("320x320", targetSize)
    .replace("640x640", targetSize)
    .replace("750x750", targetSize);
}

function buildMaxCoverUrl(url) {
  return buildUrlWithSize(url, "1280x1280");
}

async function replaceFileAtomic(tmpPath, destPath) {
  try {
    await fs.promises.rename(tmpPath, destPath);
  } catch (error) {
    // Windows often refuses to overwrite on rename.
    try {
      await fs.promises.rm(destPath, { force: true });
    } catch (_e) {}
    await fs.promises.rename(tmpPath, destPath);
  }
}

function downloadBinaryFileOnce(url, destination, timeoutSec) {
  return new Promise(async (resolve, reject) => {
    try {
      if (!url) {
        reject(new Error("Brak URL do pobrania"));
        return;
      }
      const parsed = new URL(url);
      const client = parsed.protocol === "http:" ? http : https;

      await ensureDirectory(path.dirname(destination));

      const tmpPath = `${destination}.part`;
      const fileStream = fs.createWriteStream(tmpPath);

      const request = client.get(url, (response) => {
        if (response.statusCode && response.statusCode >= 400) {
          response.resume();
          fileStream.close(() => {
            fs.promises.rm(tmpPath, { force: true }).finally(() => {
              reject(new Error(`HTTP ${response.statusCode}`));
            });
          });
          return;
        }

        response.pipe(fileStream);

        fileStream.on("finish", async () => {
          fileStream.close(async () => {
            try {
              await replaceFileAtomic(tmpPath, destination);
              resolve();
            } catch (err) {
              reject(err);
            }
          });
        });
      });

      request.setTimeout(Math.max(1, timeoutSec) * 1000, () => {
        request.destroy(new Error("Timeout"));
      });

      request.on("error", (error) => {
        fileStream.close(() => {
          fs.promises.rm(tmpPath, { force: true }).finally(() => reject(error));
        });
      });

      fileStream.on("error", (error) => {
        request.destroy();
        fileStream.close(() => {
          fs.promises.rm(tmpPath, { force: true }).finally(() => reject(error));
        });
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function downloadBinaryFile(url, destination, { timeoutSec = 40, retries = 3 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await downloadBinaryFileOnce(url, destination, timeoutSec);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 600 * attempt));
      }
    }
  }
  throw lastError || new Error("Nie udało się pobrać pliku");
}

// =========================
// CD Mockup generator (mini = mockup)
// =========================

// Lazy-load sharp so the app does not crash before installing dependencies.
let _sharp = null;
try {
  // eslint-disable-next-line global-require
  _sharp = require("sharp");
} catch (_e) {
  _sharp = null;
}

const CD_MOCKUP = {
  PASTE_X: 169,
  PASTE_Y: 34,
  SIDE: 0, // 0 = no scaling
  MOCKUP_DOWNSCALE: 4,
  JPG_QUALITY: 75
};


// Limit równoległości generowania okładek/mockupów, żeby nie zajechać CPU/RAM.
// W praktyce import JSON i tak idzie sekwencyjnie, ale ten bezpiecznik chroni na przyszłość.
const COVER_TASK_LIMIT = 2;
let _coverTasksActive = 0;
const _coverTasksWaiters = [];

async function acquireCoverTaskSlot() {
  if (_coverTasksActive < COVER_TASK_LIMIT) {
    _coverTasksActive += 1;
    return;
  }
  await new Promise((resolve) => _coverTasksWaiters.push(resolve));
  _coverTasksActive += 1;
}

function releaseCoverTaskSlot() {
  _coverTasksActive = Math.max(0, _coverTasksActive - 1);
  const next = _coverTasksWaiters.shift();
  if (next) next();
}


let cdTemplateCachePromise = null;

async function loadCdTemplates(templateDir) {
  if (!_sharp) {
    throw new Error('Brak zależności "sharp" (zainstaluj: npm i sharp)');
  }
  const basePath = path.join(templateDir, "CD_BASE.jpg");
  const reflPath = path.join(templateDir, "CD_REFLECTIONS.png");

  const [baseExists, reflExists] = await Promise.all([
    fs.promises
      .access(basePath)
      .then(() => true)
      .catch(() => false),
    fs.promises
      .access(reflPath)
      .then(() => true)
      .catch(() => false)
  ]);

  if (!baseExists || !reflExists) {
    throw new Error(`Brak szablonów CD w ${templateDir} (CD_BASE.jpg / CD_REFLECTIONS.png)`);
  }

  const baseBuf = await fs.promises.readFile(basePath);
  const baseMeta = await _sharp(baseBuf).metadata();
  const baseW = baseMeta.width;
  const baseH = baseMeta.height;
  if (!baseW || !baseH) throw new Error("Nie można odczytać rozmiaru CD_BASE.jpg");

  let reflBuf = await fs.promises.readFile(reflPath);
  const reflMeta = await _sharp(reflBuf).metadata();
  if (reflMeta.width !== baseW || reflMeta.height !== baseH) {
    reflBuf = await _sharp(reflBuf)
      .resize(baseW, baseH, { fit: "fill", kernel: _sharp.kernel.lanczos3 })
      .png()
      .toBuffer();
  }

  return { baseBuf, reflBuf, baseW, baseH };
}

async function getCdTemplatesCached(templateDir) {
  if (!cdTemplateCachePromise) {
    cdTemplateCachePromise = loadCdTemplates(templateDir).catch((err) => {
      // Jeżeli pierwszy load się nie udał (np. brak plików), nie blokuj się na zawsze.
      cdTemplateCachePromise = null;
      throw err;
    });
  }
  return cdTemplateCachePromise;
}

async function generateCdMockup({ templateDir, coverPath, outputPath }) {
  if (!_sharp) {
    throw new Error('Brak zależności "sharp" (zainstaluj: npm i sharp)');
  }

  const { baseBuf, reflBuf, baseW, baseH } = await getCdTemplatesCached(templateDir);

  // Przygotuj okładkę do wklejenia.
  // SIDE=0 oznacza: nie skalujemy "na sztywno", ale jeśli obraz jest za duży, to musimy go dopasować,
  // bo sharp.composite wymaga, żeby warstwa mieściła się w bazie (również po uwzględnieniu PASTE_X/Y).
  let cover = _sharp(coverPath).rotate().ensureAlpha();

  if (CD_MOCKUP.SIDE && CD_MOCKUP.SIDE > 0) {
    cover = cover.resize(CD_MOCKUP.SIDE, CD_MOCKUP.SIDE, { kernel: _sharp.kernel.lanczos3 });
  } else {
    // Dopasuj TYLKO jeśli trzeba, bez powiększania małych obrazów.
    const maxW = Math.max(1, baseW - CD_MOCKUP.PASTE_X);
    const maxH = Math.max(1, baseH - CD_MOCKUP.PASTE_Y);
    const meta = await _sharp(coverPath).metadata().catch(() => ({}));
    const w = meta?.width || 0;
    const h = meta?.height || 0;
    if ((w && w > maxW) || (h && h > maxH)) {
      cover = cover.resize(maxW, maxH, {
        fit: "inside",
        withoutEnlargement: true,
        kernel: _sharp.kernel.lanczos3
      });
    }
  }

  const coverPng = await cover.png().toBuffer();

  // KLUCZOWA POPRAWKA:
  // W sharp/libvips .resize() potrafi zostać "przepchnięty" przed .composite() (optymalizacja pipeline).
  // To powodowało błąd: "Image to composite must have same dimensions or smaller".
  // Robimy więc barierę: najpierw renderujemy composite do bufora, dopiero potem downscale + JPG.
  const compositedPng = await _sharp(baseBuf)
    .ensureAlpha()
    .composite([
      { input: coverPng, left: CD_MOCKUP.PASTE_X, top: CD_MOCKUP.PASTE_Y },
      { input: reflBuf, left: 0, top: 0 }
    ])
    .png()
    .toBuffer();

  let out = _sharp(compositedPng);

  if (CD_MOCKUP.MOCKUP_DOWNSCALE && CD_MOCKUP.MOCKUP_DOWNSCALE > 1) {
    const outW = Math.max(1, Math.floor(baseW / CD_MOCKUP.MOCKUP_DOWNSCALE));
    const outH = Math.max(1, Math.floor(baseH / CD_MOCKUP.MOCKUP_DOWNSCALE));
    out = out.resize(outW, outH, { kernel: _sharp.kernel.lanczos3 });
  }

  await ensureDirectory(path.dirname(outputPath));
  const tmpPath = `${outputPath}.part`;
  await out.jpeg({ quality: CD_MOCKUP.JPG_QUALITY, mozjpeg: true }).toFile(tmpPath);
  await replaceFileAtomic(tmpPath, outputPath);
}


async function ensureAlbumCovers({ appDirectory, albumId, pictureUrl }) {
  // Bezpiecznik na wypadek, gdyby import kiedyś poszedł równolegle:
  // ograniczamy liczbę jednoczesnych zadań (download + sharp).
  await acquireCoverTaskSlot();
  try {
    const miniDir = getFilesPath(appDirectory, "pic_mini");
    const maxDir = getFilesPath(appDirectory, "pic_max");
    await ensureDirectory(miniDir);
    await ensureDirectory(maxDir);

    const miniTarget = path.join(miniDir, `mini_${albumId}.jpg`);
    const maxTarget = path.join(maxDir, `max_${albumId}.jpg`);
    const miniDefault = path.join(miniDir, "mini_default.jpg");
    const maxDefault = path.join(maxDir, "max_default.jpg");

    let usedDefault = false;

    // 1) MAX cover (pure cover for preview)
    try {
      const maxUrl = buildMaxCoverUrl(pictureUrl);
      await downloadBinaryFile(maxUrl, maxTarget, { timeoutSec: 40, retries: 3 });
    } catch (error) {
      usedDefault = true;
      try {
        await fs.promises.copyFile(maxDefault, maxTarget);
      } catch (copyErr) {
        // Jeżeli nawet default nie istnieje, pokaż czytelny błąd.
        throw new Error(`Nie udało się pobrać max okładki i brak max_default.jpg: ${copyErr.message || copyErr}`);
      }
    }

    // 2) MINI cover = CD mockup generated from MAX cover
    try {
      // Templaty po migracji: APP_DIR/FILES/CD_TEMPLATE
      const templateDir = getFilesPath(appDirectory, "CD_TEMPLATE");
      await generateCdMockup({ templateDir, coverPath: maxTarget, outputPath: miniTarget });
    } catch (error) {
      usedDefault = true;
      console.warn(
        `[CD MOCKUP] album=${albumId} -> fallback mini_default (powód: ${error?.message || error})`
      );
      await fs.promises.copyFile(miniDefault, miniTarget);
    }

    return usedDefault;
  } finally {
    releaseCoverTaskSlot();
  }
}


async function ensureDirectory(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

let mainWindow;
let allowAppClose = false;
let quitRequested = false;
let closeInProgress = false;
let closeTimeout = null;
let hardExitTimeout = null;
const CLOSE_FAILSAFE_TIMEOUT_MS = 8000;

function clearCloseTimeout() {
  if (!closeTimeout) return;
  clearTimeout(closeTimeout);
  closeTimeout = null;
}

function quitApplicationWithFallback() {
  allowAppClose = true;
  clearCloseTimeout();
  app.quit();
  if (hardExitTimeout) return;
  hardExitTimeout = setTimeout(() => {
    app.exit(0);
  }, 1500);
}

function requestRendererAppClose() {
  if (closeInProgress) return true;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (!mainWindow.webContents || mainWindow.webContents.isDestroyed()) return false;
  closeInProgress = true;
  mainWindow.webContents.send("app-close-request");
  return true;
}

function buildExportSummary({ total, schemaMs, dbMs, xlsxMs, overallMs, fileName }) {
  const lines = [
    `✅ Eksport zakończony. Zapisano ${total} rekordów do pliku ${fileName}.`,
    `⏱ Schemat bazy: ${(schemaMs / 1000).toFixed(2)} s`,
    `⏱ Pobranie danych: ${(dbMs / 1000).toFixed(2)} s`,
    `⏱ Tworzenie XLSX: ${(xlsxMs / 1000).toFixed(2)} s`,
    `⏱ Całość: ${(overallMs / 1000).toFixed(2)} s`
  ];
  return lines.join("\n");
}

function buildImportSummary({
  totalRows,
  sheetName,
  readMs,
  dbMs,
  overallMs,
  sourceRows,
  duplicates,
  missingLink
}) {
  const lines = [
    `✅ Import zakończony. Wstawiono ${totalRows} rekordów z arkusza "${sheetName}".`
  ];

  if (Number.isFinite(sourceRows)) lines.push(`📄 Wiersze w XLSX: ${sourceRows}`);
  if (Number.isFinite(duplicates)) lines.push(`🟡 Duplikaty (TIDAL_LINK): ${duplicates}`);
  if (Number.isFinite(missingLink)) lines.push(`🟠 Bez TIDAL_LINK: ${missingLink}`);

  lines.push(
    `⏱ Wczytanie XLSX: ${(readMs / 1000).toFixed(2)} s`,
    `⏱ Operacje na bazie: ${(dbMs / 1000).toFixed(2)} s`,
    `⏱ Całość: ${(overallMs / 1000).toFixed(2)} s`
  );

  return lines.join("\n");
}

function isProcessRunning(processName) {
  if (!processName) return Promise.resolve(false);
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile("tasklist", ["/FI", `IMAGENAME eq ${processName}`], { windowsHide: true }, (error, stdout = "") => {
        if (error) {
          resolve(false);
          return;
        }
        resolve(stdout.toLowerCase().includes(processName.toLowerCase()));
      });
      return;
    }
    execFile("ps", ["-A"], (error, stdout = "") => {
      if (error) {
        resolve(false);
        return;
      }
      resolve(stdout.toLowerCase().includes(processName.toLowerCase()));
    });
  });
}

function maximizeTidalWindow() {
  if (process.platform !== "win32") return Promise.resolve(false);
  const script = [
    "$sig = '[DllImport(\"user32.dll\")]public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);[DllImport(\"user32.dll\")]public static extern bool SetForegroundWindow(IntPtr hWnd);'",
    "Add-Type -MemberDefinition $sig -Name WinAPI -Namespace Win32",
    "$process = Get-Process -Name 'TIDAL' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
    "if ($process) { [Win32.WinAPI]::ShowWindowAsync($process.MainWindowHandle, 3) | Out-Null; [Win32.WinAPI]::SetForegroundWindow($process.MainWindowHandle) | Out-Null }"
  ].join("; ");
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", script],
      { windowsHide: true },
      (error) => {
        resolve(!error);
      }
    );
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 720,
    autoHideMenuBar: true,
    // Ikona apki dla Raffaello
    icon: getFilesPath(getAppDirectory(), "icons", "Raffaello_LOGO_01.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.maximize();
  allowAppClose = false;
  quitRequested = false;
  closeInProgress = false;
  clearCloseTimeout();

  mainWindow.on("close", (event) => {
    if (allowAppClose) return;
    event.preventDefault();
    const requested = requestRendererAppClose();
    if (!requested && quitRequested) {
      quitApplicationWithFallback();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (process.platform !== "darwin") {
    mainWindow.setMenuBarVisibility(false);
  }

  await mainWindow.loadFile(path.join(__dirname, "index.html"));
}

async function bootstrapDatabase() {
  try {
    await ensureSchema();
  } catch (error) {
    dialog.showErrorBox(
      "Błąd połączenia z SQLite / bazą danych",
      `Nie udało się przygotować bazy danych. Sprawdź plik bazy danych.\n\nSzczegóły: ${error.message}`
    );
    throw error;
  }
}

function registerHandlers() {
  ipcMain.handle("fetch-workbook", async () => {
    const [records, labelsHierarchy] = await Promise.all([fetchAlbums(), loadLabelHierarchy()]);
    const collections = await fetchCollections();
    const containers = await fetchContainers();
    const folders = await fetchFolders();
    const albumFolders = await fetchAlbumFolders();
    const labelsSet = new Set(labelsHierarchy.map(getLabelNameFromHierarchy).filter(Boolean));
    const missingLabels = Array.from(
      new Set(
        records
          .map((record) => String(record?.LABEL || "").trim())
          .filter((label) => label && !labelsSet.has(label))
      )
    );
    return {
      status: "ok",
      file_name: `SQLite / baza danych – tabela '${TABLE_NAME}'`,
      sheet_name: SHEET_NAME,
      updated_at: Date.now(),
      records,
      collections,
      containers,
      folders,
      albumFolders,
      labelsHierarchy,
      missingLabels
    };
  });

  ipcMain.handle("fetch-filter-presets", async () => {
    await ensureSchema();
    const presets = await fetchFilterPresets();
    return {
      status: "ok",
      presets
    };
  });

  ipcMain.handle("save-filter-preset", async (_event, payload = {}) => {
    const name = String(payload?.name || "").trim();
    if (!name) {
      throw new Error("Nazwa filtra jest wymagana.");
    }
    await ensureSchema();
    await saveFilterPreset(name, payload?.filters || {});
    return { status: "ok" };
  });

  ipcMain.handle("rename-filter-preset", async (_event, payload = {}) => {
    const currentName = String(payload?.currentName || "").trim();
    const nextName = String(payload?.nextName || "").trim();
    if (!currentName || !nextName) {
      throw new Error("Nazwa filtra jest wymagana.");
    }
    await ensureSchema();
    await renameFilterPreset(currentName, nextName);
    return { status: "ok" };
  });

  ipcMain.handle("delete-filter-preset", async (_event, payload = {}) => {
    const name = String(payload?.name || "").trim();
    if (!name) {
      throw new Error("Nazwa filtra jest wymagana.");
    }
    await ensureSchema();
    await deleteFilterPreset(name);
    return { status: "ok" };
  });

  ipcMain.handle("is-process-running", async (_event, payload = {}) => {
    const name = String(payload?.name || "").trim();
    if (!name) {
      return { status: "error", error: "Nazwa procesu jest wymagana." };
    }
    const running = await isProcessRunning(name);
    return { status: "ok", running };
  });

  ipcMain.handle("update-workbook", async (_event, payload = {}) => {
    const {
      records = [],
      sheetName = SHEET_NAME,
      collections = [],
      containers = [],
      folders = [],
      albumFolders = []
    } = payload;
    const count = await replaceAlbums(records);
    await replaceFolderData({ collections, containers, folders, albumFolders });
    const timestamp = Date.now();
    return {
      status: "ok",
      message: `✅ Zapisano ${count} rekordów w tabeli SQLite / baza danych '${TABLE_NAME}'.`,
      updated_at: timestamp,
      sheet_name: sheetName,
      file_name: `SQLite / baza danych – tabela '${TABLE_NAME}'`
    };
  });

  ipcMain.handle("backup-database", async () => {
    const result = await createDatabaseBackup();
    return {
      status: "ok",
      backupFileName: result.backupFileName,
      backupPath: result.backupPath,
      sourcePath: result.sourcePath
    };
  });

  ipcMain.handle("check-database", async (_event, payload = {}) => {
    const result = await checkDatabaseRecords({ collectionName: payload?.collectionName });
    return {
      status: "ok",
      totalRecords: result.totalRecords,
      incompleteRecords: result.incompleteRecords,
      missingCounts: result.missingCounts,
      errorContainerName: result.errorContainerName,
      errorFoldersCreated: result.errorFoldersCreated,
      errorAssignmentsInserted: result.errorAssignmentsInserted
    };
  });

  ipcMain.handle("export-xlsx", async (_event, payload = {}) => {
    const targetDir = payload?.directory || getAppDirectory();
    await ensureDirectory(targetDir);
    const fileName = buildTimestampedName(DATA_PREFIXES.importDb);
    const dataFilePath = path.join(targetDir, fileName);

    const overallStart = Date.now();
    const schemaStart = Date.now();
    await ensureSchema();
    const schemaEnd = Date.now();

    const dbStart = Date.now();
    const [records, collections, containers, folders, albumFolders] = await Promise.all([
      fetchAlbums(),
      fetchCollections(),
      fetchContainers(),
      fetchFolders(),
      fetchAlbumFolders()
    ]);
    const dbEnd = Date.now();

    const xlsxStart = Date.now();
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(records), SHEET_NAME);
    // Foldery/kontenery jako osobne arkusze – dzięki temu IMPORT DB przywraca je w całości.
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(collections || []), EXTRA_SHEETS.collections);
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(containers || []), EXTRA_SHEETS.containers);
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(folders || []), EXTRA_SHEETS.folders);
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(albumFolders || []), EXTRA_SHEETS.albumFolders);
    XLSX.writeFile(workbook, dataFilePath);
    const xlsxEnd = Date.now();

    const overallEnd = Date.now();
    const payloadResponse = {
      status: "ok",
      total: records.length,
      filePath: dataFilePath,
      fileName,
      summary: buildExportSummary({
        total: records.length,
        schemaMs: schemaEnd - schemaStart,
        dbMs: dbEnd - dbStart,
        xlsxMs: xlsxEnd - xlsxStart,
        overallMs: overallEnd - overallStart,
        fileName
      })
    };
    return payloadResponse;
  });

  ipcMain.handle("import-xlsx", async (_event, payload = {}) => {
    const targetDir = payload?.directory || getAppDirectory();
    await ensureDirectory(targetDir);

    const source = await resolveSourceFile({
      directory: targetDir,
      filePath: payload?.filePath,
      prefix: DATA_PREFIXES.importDb
    });

    const overallStart = Date.now();
    const readStart = Date.now();
    const workbook = XLSX.readFile(source.path);

    // 1) Albumy – preferujemy arkusz o nazwie SHEET_NAME ("SQLite"), bo stary import brał "pierwszy".
    const albumSheetName = workbook.Sheets?.[SHEET_NAME] ? SHEET_NAME : workbook.SheetNames[0];
    const albumWorksheet = workbook.Sheets?.[albumSheetName];
    if (!albumWorksheet) {
      throw new Error(`Nie znaleziono arkusza w pliku XLSX (${albumSheetName}).`);
    }
    const rows = XLSX.utils.sheet_to_json(albumWorksheet, { defval: "" });

    // 2) Foldery/kontenery – jeśli plik je zawiera, importujemy z pliku.
    // Jeśli NIE zawiera (stare pliki), zachowujemy bieżące dane folderów z DB.
    const collectionsWs = getWorksheetByName(workbook, EXTRA_SHEETS.collections);
    const containersWs = getWorksheetByName(workbook, EXTRA_SHEETS.containers);
    const foldersWs = getWorksheetByName(workbook, EXTRA_SHEETS.folders);
    const albumFoldersWs = getWorksheetByName(workbook, EXTRA_SHEETS.albumFolders);
    const hasAnyFolderSheet = Boolean(collectionsWs || containersWs || foldersWs || albumFoldersWs);

    const readEnd = Date.now();

    await ensureSchema();

    let collections = sheetToJsonSafe(collectionsWs);
    let containers = sheetToJsonSafe(containersWs);
    let folders = sheetToJsonSafe(foldersWs);
    let albumFolders = sheetToJsonSafe(albumFoldersWs);

    if (!hasAnyFolderSheet) {
      // Stary XLSX (bez arkuszy folderów) → nie kasujemy folderów/kontenerów i przypisań.
      [collections, containers, folders, albumFolders] = await Promise.all([
        fetchCollections(),
        fetchContainers(),
        fetchFolders(),
        fetchAlbumFolders()
      ]);
    } else {
      // Mamy przynajmniej część arkuszy folderów.
      if (!foldersWs) {
        // Bez listy folderów nie da się sensownie odtworzyć struktury – bierzemy ją z DB.
        const [existingCollections, existingContainers, existingFolders, existingAlbumFolders] = await Promise.all([
          fetchCollections(),
          fetchContainers(),
          fetchFolders(),
          fetchAlbumFolders()
        ]);
        if (!collectionsWs) collections = existingCollections;
        if (!containersWs) containers = existingContainers;
        folders = existingFolders;
        if (!albumFoldersWs) albumFolders = existingAlbumFolders;
      } else {
        // Foldery są w pliku.
        if (!containersWs || !Array.isArray(containers) || containers.length === 0) {
          // Plik ma foldery, ale nie ma kontenerów → wyciągamy kontenery z kolumny "container".
          containers = normalizeContainersFromFolders(folders);
        }

        if (!collectionsWs || !Array.isArray(collections) || collections.length === 0) {
          collections = normalizeCollectionsFromContainers(containers);
          if (!collections.length) {
            collections = await fetchCollections();
          }
        }

        if (!albumFoldersWs) {
          // Struktura folderów jest w pliku, ale przypisań brak → próbujemy zachować przypisania z DB.
          albumFolders = await fetchAlbumFolders();
        }
      }
    }

    // 3) Bezpiecznik FK: przypisania muszą wskazywać na istniejące ID_ALBUMU z importu.
    const importedAlbumIds = buildAlbumIdSet(rows);
    if (importedAlbumIds.size === 0) {
      albumFolders = [];
    } else {
      albumFolders = (albumFolders || []).filter((item) => importedAlbumIds.has(Number(item?.album_id)));
    }

    const dbStart = Date.now();
    const total = await replaceAlbums(rows);
    await replaceFolderData({ collections, containers, folders, albumFolders });
    const dbEnd = Date.now();

    const overallEnd = Date.now();
    const payloadResponse = {
      status: "ok",
      total,
      sheetName: albumSheetName,
      summary: buildImportSummary({
        totalRows: total,
        sheetName: albumSheetName,
        readMs: readEnd - readStart,
        dbMs: dbEnd - dbStart,
        overallMs: overallEnd - overallStart
      }),
      fileName: source.name
    };
    return payloadResponse;
  });

  ipcMain.handle("import-news-xlsx", async (_event, payload = {}) => {
    const targetDir = payload?.directory || getAppDirectory();
    await ensureDirectory(targetDir);

    const source = await resolveSourceFile({
      directory: targetDir,
      filePath: payload?.filePath,
      prefix: DATA_PREFIXES.updateDb
    });

    const overallStart = Date.now();
    const readStart = Date.now();
    const workbook = XLSX.readFile(source.path);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) {
      throw new Error(`Nie znaleziono arkusza w pliku XLSX (${sheetName}).`);
    }
    const rows = XLSX.utils.sheet_to_json(worksheet, { defval: "" });
    const readEnd = Date.now();

    await ensureSchema();
    const dbStart = Date.now();
    const stats = await appendRecords(rows, { markUpdated: true });
    const duplicateRecords = stats?.duplicateRecords || [];
    let duplicatesFileName = null;
    let duplicatesFilePath = null;
    if (duplicateRecords.length) {
      const duplicateWorkbook = XLSX.utils.book_new();
      const duplicateSheet = XLSX.utils.json_to_sheet(duplicateRecords);
      XLSX.utils.book_append_sheet(duplicateWorkbook, duplicateSheet, "DUPLIKATY");
      duplicatesFileName = buildDuplicateAlbumsFileName();
      const targetDirectory = path.dirname(source.path);
      duplicatesFilePath = path.join(targetDirectory, duplicatesFileName);
      XLSX.writeFile(duplicateWorkbook, duplicatesFilePath);
    }
    const dbEnd = Date.now();

    const inserted = Number(stats?.inserted ?? 0);
    const duplicates = Number(stats?.duplicates ?? 0);
    const missingLink = Number(stats?.missingLink ?? 0);
    const sourceRows = Number(stats?.sourceRows ?? rows.length);
    const overallEnd = Date.now();

    const payloadResponse = {
      status: "ok",
      total: inserted,
      duplicates,
      missingLink,
      sourceRows,
      insertedLinks: stats?.insertedLinks || [],
      duplicatesFileName,
      duplicatesFilePath,
      sheetName,
      summary: buildImportSummary({
        totalRows: inserted,
        sheetName,
        sourceRows,
        duplicates,
        missingLink,
        readMs: readEnd - readStart,
        dbMs: dbEnd - dbStart,
        overallMs: overallEnd - overallStart
      }),
      fileName: source.name
    };
    return payloadResponse;
  });

  ipcMain.handle("import-json", async (event, payload = {}) => {
    const targetDir = payload?.directory || getAppDirectory();
    await ensureDirectory(targetDir);
    const collectionName = payload?.collectionName;

    const source = await resolveJsonSourceFile({
      directory: targetDir,
      filePath: payload?.filePath
    });

    let jsonData;
    try {
      const raw = await fs.promises.readFile(source.path, "utf8");
      jsonData = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Nie udało się odczytać pliku JSON: ${error.message}`);
    }

    const records = normalizeJsonRecords(jsonData);
    if (!records.length) {
      return {
        status: "ok",
        summary: "⚠️ Plik JSON nie zawiera rekordów do importu.",
        fileName: source.name,
        filePath: source.path
      };
    }

    await ensureSchema();
    const { maxId, maxOrder, linkMap, tidalIdMap } = await getAlbumImportState();
    const existingLinks = new Set(linkMap.keys());
    const existingTidalIds = new Set(tidalIdMap.keys());

    let nextId = maxId + 1;
    let nextOrder = maxOrder + 1;
    if (nextId > 999999 || maxId + records.length > 999999) {
      throw new Error("Przekroczono maksymalną liczbę albumów (999999).");
    }
    const albumsToInsert = [];
    const errorAssignments = [];
    const missingCounts = {
      TIDAL_LINK: 0,
      ARTIST: 0,
      TITLE: 0,
      DURATION: 0,
      RELEASE_DATE: 0,
      PICTURE: 0
    };

    let duplicates = 0;
    let complete = 0;
    let incomplete = 0;

    const importStamp = Date.now();
    records.forEach((record) => {
      const link = sanitizeJsonText(record?.albumLink);
      const tidalId = extractTidalAlbumId(link);
      const artist = sanitizeJsonText(record?.artist);
      const title = sanitizeJsonText(record?.title);
      const duration = parseJsonDuration(record?.duration);
      const releaseDate = parseJsonReleaseDate(record?.releaseDate);
      const picture = sanitizeJsonText(record?.picture);

      const missingFields = [];
      if (!link) missingFields.push("TIDAL_LINK");
      if (!artist) missingFields.push("ARTIST");
      if (!title) missingFields.push("TITLE");
      if (!duration) missingFields.push("DURATION");
      if (!releaseDate) missingFields.push("RELEASE_DATE");
      if (!picture) missingFields.push("PICTURE");

      missingFields.forEach((field) => {
        missingCounts[field] += 1;
      });

      const duplicateKey = tidalId || link;
      const isDuplicate = Boolean(duplicateKey && (tidalId ? existingTidalIds.has(duplicateKey) : existingLinks.has(duplicateKey)));
      if (isDuplicate) {
        duplicates += 1;
      }

      if (isDuplicate || missingFields.length) {
        const folderName = buildFolderNameForIssues(missingFields, isDuplicate);
        const albumId = isDuplicate
          ? tidalId
            ? tidalIdMap.get(tidalId)
            : linkMap.get(link)
          : nextId;
        if (albumId) {
          errorAssignments.push({ albumId, folderName });
        }
      }

      if (isDuplicate) {
        return;
      }

      if (!missingFields.length) {
        complete += 1;
      } else {
        incomplete += 1;
      }

      albumsToInsert.push({
        ID_ALBUMU: nextId,
        SELECTOR: "N",
        HEARD: 0,
        FAVORITE: 0,
        RATING: 0,
        BOOKLET: 0,
        CD_BACK: 0,
        LABEL: "unknown",
        TIDAL_LINK: link,
        FORMAT: "TIDAL streaming",
        ROON_ID: String(nextId).padStart(6, "0"),
        SPOTIFY_LINK: "",
        APPLE_MUSIC_LINK: "",
        CATALOG_NUMBER: "",
        PICTURE: picture,
        ARTIST_RAFFAELLO: artist,
        ARTIST_TIDAL: artist,
        TITLE_RAFFAELLO: title,
        TITLE_TIDAL: title,
        DURATION: duration,
        RELEASE_DATE: releaseDate,
        UPDATE_TS: importStamp,
        row_order: nextOrder
      });

      if (link) existingLinks.add(link);
      if (tidalId) existingTidalIds.add(tidalId);
      nextId += 1;
      nextOrder += 1;
    });

    const totalSteps = albumsToInsert.length * 2;
    let completedSteps = 0;
    const reportProgress = (message) => {
      completedSteps = Math.min(completedSteps + 1, totalSteps);
      if (event?.sender) {
        event.sender.send("import-json-progress", {
          current: completedSteps,
          total: totalSteps,
          message
        });
      }
    };

    const appDirectory = getAppDirectory();
    let defaultCoverCount = 0;

    const importResult = await importJsonAlbums({
      records: albumsToInsert,
      errorAssignments,
      collectionName,
      onBeforeInsert: async (_record, index) => {
        reportProgress(`Importuję album nr ${index} do bazy.`);
      },
      onAfterInsert: async (record, index) => {
        reportProgress(`Pobieram okładki dla albumu nr ${index}.`);
        const usedDefault = await ensureAlbumCovers({
          appDirectory,
          albumId: record.ID_ALBUMU,
          pictureUrl: record.PICTURE
        });
        if (usedDefault) defaultCoverCount += 1;
      }
    });

    const inserted = Number(importResult?.inserted || 0);
    const errorContainerName = importResult?.errorContainerName;
    const errorFoldersCreated = Number(importResult?.errorFoldersCreated || 0);
    const errorAssignmentsInserted = Number(importResult?.errorAssignmentsInserted || 0);

    const summaryLines = [
      `✅ Import JSON zakończony. Wczytano ${inserted} albumów.`,
      `📄 Rekordy w JSON: ${records.length}`,
      `✅ Kompletne dane: ${complete}`
    ];

    if (incomplete) summaryLines.push(`⚠️ Niekompletne dane: ${incomplete}`);
    if (duplicates) summaryLines.push(`🟡 Duplikaty (ID_TIDAL): ${duplicates}`);

    Object.entries(missingCounts).forEach(([field, count]) => {
      if (count) summaryLines.push(`🔸 Brak ${field}: ${count}`);
    });

    if (defaultCoverCount) {
      summaryLines.push(`🖼️ Okładki domyślne: ${defaultCoverCount}`);
    }

    if (errorContainerName) {
      const errorAlbums = errorAssignmentsInserted || errorAssignments.length;
      summaryLines.push(
        `📦 Kontener błędów: ${errorContainerName} (folderów: ${errorFoldersCreated}, albumów: ${errorAlbums})`
      );
    }

    return {
      status: "ok",
      summary: summaryLines.join("\n"),
      fileName: source.name,
      filePath: source.path,
      inserted,
      duplicates,
      missingCounts,
      errorContainerName,
      errorFoldersCreated
    };
  });
  ipcMain.handle("run-qobuz-scraper", async (event, payload = {}) => {
    const sendProgress = (progressPayload) => {
      event.sender.send("qobuz-scrape-progress", progressPayload);
    };

    try {
      return await runQobuzScraper({
        appRootOverride: payload?.appRootOverride,
        dryRun: payload?.dryRun === true,
        emitProgress: sendProgress
      });
    } catch (error) {
      console.error("[Qobuz Scraper] Błąd:", error);
      sendProgress({ phase: "error", percent: 100, message: error?.message || "Error" });
      return {
        ok: false,
        error: {
          code: error?.code || "UNEXPECTED_ERROR",
          message: error?.message || "Nieoczekiwany błąd scrapera Qobuz.",
          details: error?.details || {}
        }
      };
    }
  });

  ipcMain.handle("select-directory", async (_event, payload = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "Wybierz folder dla operacji danych",
      defaultPath: payload?.defaultPath
    });
    if (result.canceled || !result.filePaths.length) {
      return { status: "cancelled", error: "Użytkownik anulował wybór" };
    }
    return { status: "ok", path: result.filePaths[0] };
  });

  ipcMain.handle("get-app-directory", () => ({
    status: "ok",
    path: getAppDirectory()
  }));

  ipcMain.handle("select-file", async (_event, payload = {}) => {
    const { defaultPath, filters } = payload;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile"],
      title: "Wybierz plik danych",
      defaultPath,
      filters: filters && Array.isArray(filters) ? filters : [{ name: "Arkusze Excel", extensions: ["xlsx"] }]
    });
    if (result.canceled || !result.filePaths.length) {
      return { status: "cancelled", error: "Użytkownik anulował wybór" };
    }
    return { status: "ok", path: result.filePaths[0] };
  });

  ipcMain.handle("resolve-import-file", async (_event, payload = {}) => {
    const { directory, filePath, prefix } = payload;
    const source = await resolveSourceFile({ directory, filePath, prefix: prefix || DATA_PREFIXES.importDb });
    return { status: "ok", filePath: source.path, fileName: source.name };
  });

  ipcMain.handle("resolve-json-file", async (_event, payload = {}) => {
    const { directory, filePath } = payload;
    const source = await resolveJsonSourceFile({ directory, filePath });
    return { status: "ok", filePath: source.path, fileName: source.name };
  });

  ipcMain.handle("save-file", async (_event, payload = {}) => {
    const { directory, fileName, data, binary = true } = payload;
    if (!fileName) {
      return { status: "error", error: "Brak nazwy pliku" };
    }
    const targetDir = directory || getAppDirectory();
    await ensureDirectory(targetDir);
    const filePath = path.join(targetDir, fileName);
    const buffer = binary ? Buffer.from(data || []) : Buffer.from(String(data ?? ""), "utf8");
    await fs.promises.writeFile(filePath, buffer);
    return { status: "ok", filePath };
  });

  ipcMain.handle("read-text-file", async (_event, payload = {}) => {
    const { filePath } = payload;
    if (!filePath) {
      return { status: "error", error: "Brak ścieżki pliku" };
    }
    const normalized = path.resolve(filePath);
    if (!fs.existsSync(normalized)) {
      return { status: "error", error: `Nie znaleziono pliku: ${normalized}` };
    }
    const contents = await fs.promises.readFile(normalized, "utf8");
    return { status: "ok", contents };
  });

  ipcMain.handle("check-file-exists", async (_event, payload = {}) => {
    const filePath = String(payload?.filePath || "");
    if (!filePath) {
      return { status: "error", error: "Brak ścieżki pliku." };
    }
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      return { status: "ok", exists: true };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { status: "ok", exists: false };
      }
      return { status: "error", error: error.message || "Nie udało się sprawdzić pliku." };
    }
  });

  ipcMain.handle("open-external", async (_event, url) => {
    if (!url || typeof url !== "string") return false;
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle("delete-album-assets", async (_event, payload = {}) => {
    const albumId = Number(payload?.albumId);
    if (!Number.isFinite(albumId) || albumId <= 0) {
      return { status: "error", error: "Nieprawidłowe ID albumu." };
    }
    const baseDir = getAppDirectory();
    const targets = [
      getFilesPath(baseDir, "pic_mini", `mini_${albumId}.jpg`),
      getFilesPath(baseDir, "pic_max", `max_${albumId}.jpg`),
      getFilesPath(baseDir, "CD_BACK", `back_${albumId}.jpg`)
    ];
    await Promise.all(
      targets.map(async (target) => {
        try {
          await fs.promises.unlink(target);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      })
    );
    return { status: "ok" };
  });

  ipcMain.handle("maximize-tidal-window", async () => {
    return maximizeTidalWindow();
  });

  ipcMain.on("app-close-confirmed", () => {
    clearCloseTimeout();
    closeInProgress = false;
    allowAppClose = true;

    if (mainWindow && !mainWindow.isDestroyed()) {
      const { webContents } = mainWindow;
      if (webContents && !webContents.isDestroyed() && webContents.isDevToolsOpened()) {
        webContents.closeDevTools();
      }
    }

    quitRequested = true;
    quitApplicationWithFallback();
  });
}

app.on("before-quit", (event) => {
  if (allowAppClose) return;
  quitRequested = true;
  event.preventDefault();

  const requested = requestRendererAppClose();
  if (!requested) {
    quitApplicationWithFallback();
    return;
  }

  clearCloseTimeout();
  closeTimeout = setTimeout(() => {
    quitApplicationWithFallback();
  }, CLOSE_FAILSAFE_TIMEOUT_MS);
});

app.whenReady().then(async () => {
  if (process.platform !== "darwin") {
    // Wyłączamy menu aplikacji na Windows/Linux, żeby ALT nie przełączał focusu na pasek menu
    // (to potrafi rozwalić wpisywanie w polach tekstowych po native dialogach).
    Menu.setApplicationMenu(null);
  }
  try {
    await migrateLegacyAssetsToFiles(getAppDirectory());
  } catch (error) {
    console.warn(`[FILES migration] Błąd migracji folderów do FILES: ${error?.message || error}`);
  }
  await bootstrapDatabase();
  registerHandlers();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || quitRequested || allowAppClose) {
    quitApplicationWithFallback();
  }
});
