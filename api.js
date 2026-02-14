function ensureElectronAPI() {
  if (!window?.electronAPI) {
    throw new Error("Brak warstwy Electron. Uruchom aplikację jako klienta desktopowego.");
  }
  return window.electronAPI;
}

async function fetchWorkbook() {
  const api = ensureElectronAPI();
  const response = await api.fetchWorkbook();
  if (!response || response.status !== "ok") {
    throw new Error(response?.error || "Nie udało się pobrać danych z SQLite / bazy danych");
  }
  return response;
}

async function updateWorkbook(payload = {}) {
  const api = ensureElectronAPI();
  const response = await api.updateWorkbook(payload);
  if (!response || response.status !== "ok") {
    throw new Error(response?.error || "Nie udało się zapisać danych do SQLite / bazy danych");
  }
  return response;
}

async function exportWorkbookToFile(options = {}) {
  const api = ensureElectronAPI();
  const response = await api.exportXlsx(options);
  if (!response || response.status !== "ok") {
    throw new Error(response?.error || "Nie udało się wyeksportować danych do XLSX");
  }
  return response;
}

async function importWorkbookFromFile(options = {}) {
  const api = ensureElectronAPI();
  const response = await api.importXlsx(options);
  if (!response || response.status !== "ok") {
    throw new Error(response?.error || "Nie udało się zaimportować danych z XLSX");
  }
  return response;
}

async function importNewsWorkbookFromFile(options = {}) {
  const api = ensureElectronAPI();
  const response = await api.importNewsXlsx(options);
  if (!response || response.status !== "ok") {
    throw new Error(response?.error || "Nie udało się zaimportować danych z XLSX");
  }
  return response;
}

async function importJsonFromFile(options = {}) {
  const api = ensureElectronAPI();
  const response = await api.importJson(options);
  if (!response || response.status !== "ok") {
    throw new Error(response?.error || "Nie udało się zaimportować danych z JSON");
  }
  return response;
}

async function runQobuzScraper(options = {}) {
  const api = ensureElectronAPI();
  const response = await api.runQobuzScraper(options);
  if (!response || response.ok !== true) {
    throw new Error(response?.error?.message || "Nie udało się uruchomić Qobuz Scraper");
  }
  return response;
}

async function deleteAlbumAssets(payload = {}) {
  const api = ensureElectronAPI();
  const response = await api.deleteAlbumAssets(payload);
  if (!response || response.status !== "ok") {
    throw new Error(response?.error || "Nie udało się usunąć okładek albumu");
  }
  return response;
}

async function selectDirectory(options = {}) {
  const api = ensureElectronAPI();
  const response = await api.selectDirectory(options);
  if (!response) {
    throw new Error("Nie udało się wybrać folderu docelowego");
  }
  if (response.status === "ok") return response.path;
  if (response.status === "cancelled") return null;
  throw new Error(response?.error || "Nie udało się wybrać folderu docelowego");
}

async function getAppDirectory() {
  const api = ensureElectronAPI();
  const response = await api.getAppDirectory();
  if (!response || response.status !== "ok") {
    throw new Error(response?.error || "Nie udało się ustalić katalogu aplikacji");
  }
  return response.path;
}

async function selectFile(options = {}) {
  const api = ensureElectronAPI();
  const response = await api.selectFile(options);
  if (!response) {
    throw new Error("Nie udało się wybrać pliku");
  }
  if (response.status === "ok") return response.path;
  if (response.status === "cancelled") return null;
  throw new Error(response?.error || "Nie udało się wybrać pliku");
}

async function checkFileExists(options = {}) {
  const api = ensureElectronAPI();
  const response = await api.checkFileExists(options);
  if (!response || response.status !== "ok") {
    throw new Error(response?.error || "Nie udało się sprawdzić pliku");
  }
  return Boolean(response.exists);
}

async function resolveImportFile(options = {}) {
  const api = ensureElectronAPI();
  const response = await api.resolveImportFile(options);
  if (!response || response.status !== "ok") {
    throw new Error(response?.error || "Nie udało się odnaleźć pliku do importu");
  }
  return response;
}

async function resolveJsonFile(options = {}) {
  const api = ensureElectronAPI();
  const response = await api.resolveJsonFile(options);
  if (!response || response.status !== "ok") {
    throw new Error(response?.error || "Nie udało się odnaleźć pliku JSON");
  }
  return response;
}

async function backupDatabase() {
  const api = ensureElectronAPI();
  const response = await api.backupDatabase();
  if (!response || response.status !== "ok") {
    throw new Error(response?.error || "Nie udało się wykonać backupu bazy danych");
  }
  return response;
}

async function checkDatabaseRecords(options = {}) {
  const api = ensureElectronAPI();
  const response = await api.checkDatabase(options);
  if (!response || response.status !== "ok") {
    throw new Error(response?.error || "Nie udało się sprawdzić danych w bazie");
  }
  return response;
}

async function fetchFilterPresets() {
  const api = ensureElectronAPI();
  const response = await api.fetchFilterPresets();
  if (!response || response.status !== "ok") {
    throw new Error(response?.error || "Nie udało się pobrać zapisanych filtrów");
  }
  return response.presets || [];
}

async function saveFilterPreset(name, filters) {
  const api = ensureElectronAPI();
  const response = await api.saveFilterPreset({ name, filters });
  if (!response || response.status !== "ok") {
    throw new Error(response?.error || "Nie udało się zapisać filtrów");
  }
  return response;
}

async function renameFilterPreset(currentName, nextName) {
  const api = ensureElectronAPI();
  const response = await api.renameFilterPreset({ currentName, nextName });
  if (!response || response.status !== "ok") {
    throw new Error(response?.error || "Nie udało się zmienić nazwy filtrów");
  }
  return response;
}

async function deleteFilterPreset(name) {
  const api = ensureElectronAPI();
  const response = await api.deleteFilterPreset({ name });
  if (!response || response.status !== "ok") {
    throw new Error(response?.error || "Nie udało się usunąć filtrów");
  }
  return response;
}

async function isProcessRunning(name) {
  const api = ensureElectronAPI();
  const response = await api.isProcessRunning({ name });
  if (!response || response.status !== "ok") {
    throw new Error(response?.error || "Nie udało się sprawdzić procesu");
  }
  return response.running === true;
}

function onImportJsonProgress(handler) {
  const api = ensureElectronAPI();
  if (!handler) return () => {};
  const listener = (_event, payload) => handler(payload);
  api.onImportJsonProgress(listener);
  return () => api.removeImportJsonProgress(listener);
}

function onQobuzScrapeProgress(handler) {
  const api = ensureElectronAPI();
  if (!handler) return () => {};
  const listener = (_event, payload) => handler(payload);
  api.onQobuzScrapeProgress(listener);
  return () => api.removeQobuzScrapeProgress(listener);
}

async function saveBinaryFile(fileName, data, directory) {
  const api = ensureElectronAPI();
  const response = await api.saveFile({
    fileName,
    directory,
    binary: true,
    data: Array.from(new Uint8Array(data))
  });
  if (!response || response.status !== "ok") {
    throw new Error(response?.error || "Nie udało się zapisać pliku");
  }
  return response.filePath;
}

async function saveTextFile(fileName, contents, directory) {
  const api = ensureElectronAPI();
  const response = await api.saveFile({
    fileName,
    directory,
    binary: false,
    data: contents
  });
  if (!response || response.status !== "ok") {
    throw new Error(response?.error || "Nie udało się zapisać pliku TXT");
  }
  return response.filePath;
}

async function readTextFile(filePath) {
  const api = ensureElectronAPI();
  const response = await api.readTextFile({ filePath });
  if (!response || response.status !== "ok") {
    throw new Error(response?.error || "Nie udało się odczytać pliku TXT");
  }
  return response.contents || "";
}

export {
  fetchWorkbook,
  updateWorkbook,
  exportWorkbookToFile,
  importWorkbookFromFile,
  importNewsWorkbookFromFile,
  importJsonFromFile,
  runQobuzScraper,
  selectDirectory,
  selectFile,
  getAppDirectory,
  resolveImportFile,
  resolveJsonFile,
  backupDatabase,
  checkDatabaseRecords,
  saveBinaryFile,
  saveTextFile,
  readTextFile,
  fetchFilterPresets,
  saveFilterPreset,
  renameFilterPreset,
  deleteFilterPreset,
  isProcessRunning,
  onImportJsonProgress,
  onQobuzScrapeProgress,
  deleteAlbumAssets,
  checkFileExists
};
