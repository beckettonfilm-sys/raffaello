// import-from-xlsx.js
const path = require("path");
const XLSX = require("xlsx");

const {
  ensureSchema,
  replaceAlbums,
  replaceFolderData,
  fetchCollections,
  fetchContainers,
  fetchFolders,
  fetchAlbumFolders
} = require("./db");

const SHEETS = {
  albums: "SQLite",
  collections: "COLLECTIONS",
  containers: "CONTAINERS",
  folders: "FOLDERS",
  albumFolders: "ALBUM_FOLDERS"
};

function getWorksheetByName(workbook, preferredName) {
  if (!workbook?.Sheets) return null;
  if (preferredName && workbook.Sheets[preferredName]) return workbook.Sheets[preferredName];
  if (!preferredName) return null;
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
    if (!name || seen.has(name)) return;
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
    if (!name || seen.has(name)) return;
    seen.add(name);
    result.push({ name, sort_order: result.length });
  });
  return result;
}

async function run() {
  const overallStart = Date.now();

  try {
    const filePath = path.join(__dirname, "dane.xlsx");

    console.log("📂 Czytam plik XLSX:", filePath);
    const readStart = Date.now();
    const workbook = XLSX.readFile(filePath);

    const albumSheetName = workbook.Sheets?.[SHEETS.albums] ? SHEETS.albums : workbook.SheetNames[0];
    const albumWorksheet = workbook.Sheets?.[albumSheetName];

    if (!albumWorksheet) {
      throw new Error(`Nie znaleziono arkusza w pliku XLSX (${albumSheetName})`);
    }

    const rows = XLSX.utils.sheet_to_json(albumWorksheet, { defval: "" });
    const readEnd = Date.now();

    console.log(`📑 Wczytano ${rows.length} wierszy z arkusza "${albumSheetName}".`);
    console.log(`⏱ Wczytanie + parsowanie Excela: ${((readEnd - readStart) / 1000).toFixed(2)} s`);

    if (!rows.length) {
      throw new Error("Plik XLSX nie zawiera żadnych wierszy danych");
    }

    console.log("🛢 Sprawdzam schemat bazy...");
    const dbStart = Date.now();
    await ensureSchema();

    // Foldery/kontenery: jeśli XLSX ma arkusze z folderami, bierzemy je z pliku.
    // Jeśli ich nie ma (stare pliki), zachowujemy bieżące dane folderów w DB.
    const collectionsWs = getWorksheetByName(workbook, SHEETS.collections);
    const containersWs = getWorksheetByName(workbook, SHEETS.containers);
    const foldersWs = getWorksheetByName(workbook, SHEETS.folders);
    const albumFoldersWs = getWorksheetByName(workbook, SHEETS.albumFolders);
    const hasAnyFolderSheet = Boolean(collectionsWs || containersWs || foldersWs || albumFoldersWs);

    let collections = sheetToJsonSafe(collectionsWs);
    let containers = sheetToJsonSafe(containersWs);
    let folders = sheetToJsonSafe(foldersWs);
    let albumFolders = sheetToJsonSafe(albumFoldersWs);

    if (!hasAnyFolderSheet) {
      [collections, containers, folders, albumFolders] = await Promise.all([
        fetchCollections(),
        fetchContainers(),
        fetchFolders(),
        fetchAlbumFolders()
      ]);
    } else {
      if (!foldersWs) {
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
        if (!containersWs || !Array.isArray(containers) || containers.length === 0) {
          containers = normalizeContainersFromFolders(folders);
        }
        if (!collectionsWs || !Array.isArray(collections) || collections.length === 0) {
          collections = normalizeCollectionsFromContainers(containers);
          if (!collections.length) {
            collections = await fetchCollections();
          }
        }
        if (!albumFoldersWs) {
          albumFolders = await fetchAlbumFolders();
        }
      }
    }

    // Bezpiecznik FK: przypisania muszą wskazywać na istniejące ID_ALBUMU z importu.
    const importedAlbumIds = buildAlbumIdSet(rows);
    if (importedAlbumIds.size === 0) {
      albumFolders = [];
    } else {
      albumFolders = (albumFolders || []).filter((item) => importedAlbumIds.has(Number(item?.album_id)));
    }

    console.log("🧹 Czyszczę tabelę i wstawiam nowe rekordy (pełne nadpisanie)...");
    const total = await replaceAlbums(rows);
    await replaceFolderData({ collections, containers, folders, albumFolders });
    const dbEnd = Date.now();

    console.log(`⏱ Operacje na bazie (TRUNCATE + INSERT): ${((dbEnd - dbStart) / 1000).toFixed(2)} s`);
    console.log(`✅ Import zakończony sukcesem. Rekordów w bazie: ${total}.`);

    const overallEnd = Date.now();
    console.log(`⏱ Cały import (Excel + DB): ${((overallEnd - overallStart) / 1000).toFixed(2)} s`);
  } catch (error) {
    console.error("❌ Błąd podczas importu z XLSX:", error.message);
    console.error(error);
  } finally {
    process.exit();
  }
}

run();
