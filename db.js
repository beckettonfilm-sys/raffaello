const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3");

const CONFIG_PATH = path.join(__dirname, "db.config.json");
const CONFIG_SAMPLE_PATH = path.join(__dirname, "db.config.example.json");

const defaultConfig = {
  table: process.env.SQLITE_TABLE || "zajebiste_dane"
};

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.warn(`⚠️ Nie udało się odczytać pliku konfiguracyjnego ${filePath}:`, error);
    return {};
  }
}

const fileConfig = readJson(CONFIG_PATH);
const exampleConfig = readJson(CONFIG_SAMPLE_PATH);
const resolvedConfig = {
  ...exampleConfig,
  ...defaultConfig,
  ...fileConfig
};

const TABLE_NAME = resolvedConfig.table || "zajebiste_dane";
const FILTER_TABLE_NAME = "filtr_data";
const COLLECTIONS_TABLE_NAME = "collections";
const CONTAINERS_TABLE_NAME = "containers";
const FOLDERS_TABLE_NAME = "folders";
const ALBUM_FOLDERS_TABLE_NAME = "album_folders";
const DB_PREFIX = "music_database";
const BACKUP_DIR = path.join(__dirname, "BACKUP_DB");
let dbInstance;
let dbFilePath;

function formatTimestampForFileName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}_${pad(date.getHours())}-${pad(
    date.getMinutes()
  )}-${pad(date.getSeconds())}`;
}

function buildDatabaseFileName(date = new Date()) {
  return `${DB_PREFIX}_${formatTimestampForFileName(date)}.sqlite`;
}

async function ensureBackupDir() {
  await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
}

async function findLatestDatabaseFile() {
  await ensureBackupDir();
  const regex = new RegExp(
    `^${DB_PREFIX}_(\\d{2})-(\\d{2})-(\\d{4})_(\\d{2})-(\\d{2})-(\\d{2})\\.sqlite$`,
    "i"
  );
  const entries = await fs.promises.readdir(BACKUP_DIR, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    const match = entry.isFile() ? entry.name.match(regex) : null;
    if (!match) continue;
    const fullPath = path.join(BACKUP_DIR, entry.name);
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

async function resolveDatabaseFile() {
  if (dbFilePath) return dbFilePath;
  await ensureBackupDir();

  const latest = await findLatestDatabaseFile();
  if (latest) {
    dbFilePath = latest.path;
    return dbFilePath;
  }

  const fileName = buildDatabaseFileName();
  dbFilePath = path.join(BACKUP_DIR, fileName);
  return dbFilePath;
}

async function getDatabase() {
  if (dbInstance) return dbInstance;
  await resolveDatabaseFile();
  dbInstance = new sqlite3.Database(dbFilePath);
  await run(dbInstance, "PRAGMA foreign_keys = ON");
  return dbInstance;
}

async function closeDatabase() {
  if (!dbInstance) return;
  await new Promise((resolve, reject) => {
    dbInstance.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  dbInstance = null;
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function runCallback(error) {
      if (error) {
        reject(error);
        return;
      }
      resolve(this);
    });
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(rows || []);
    });
  });
}

function getColumnSet(columns = []) {
  return new Set(columns.map((col) => col.name));
}

function extractTidalAlbumId(link = "") {
  if (!link) return "";
  const match = String(link).match(/tidal\.com\/(?:browse\/)?album\/(\d+)/i);
  return match ? match[1] : "";
}

async function migrateAlbumsTable(db, columnSet) {
  const tempTable = `${TABLE_NAME}_new`;
  await run(
    db,
    `CREATE TABLE IF NOT EXISTS "${tempTable}" (
      id_albumu INTEGER PRIMARY KEY AUTOINCREMENT,
      row_order INTEGER NOT NULL DEFAULT 0,
      selector TEXT NOT NULL DEFAULT 'N',
      heard INTEGER NOT NULL DEFAULT 0,
      favorite INTEGER NOT NULL DEFAULT 0,
      label TEXT NULL,
      link TEXT NULL,
      format TEXT NULL,
      roon_id TEXT NULL,
      spotify_link TEXT NULL,
      apple_music_link TEXT NULL,
      catalog_number TEXT NULL,
      picture TEXT NULL,
      artist_raffaello TEXT NULL,
      artist_tidal TEXT NULL,
      title_raffaello TEXT NULL,
      title_tidal TEXT NULL,
      duration INTEGER NULL,
      release_date INTEGER NULL,
      rating INTEGER NOT NULL DEFAULT 0,
      update_ts INTEGER NULL,
      booklet INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  );

  const getCol = (name, fallback) => (columnSet.has(name) ? `"${name}"` : fallback);
  const idExpr = columnSet.has("id_albumu") ? "id_albumu" : columnSet.has("id") ? "id" : "NULL";
  const rowOrderExpr = getCol("row_order", "0");
  const selectorExpr = getCol("selector", "'N'");
  const heardExpr = getCol("heard", "0");
  const favoriteExpr = getCol("favorite", "0");
  const labelExpr = getCol("label", "NULL");
  const linkExpr = getCol("link", "NULL");
  const formatExpr = getCol("format", "NULL");
  const roonExpr = getCol("roon_id", "NULL");
  const spotifyExpr = getCol("spotify_link", "NULL");
  const appleExpr = getCol("apple_music_link", "NULL");
  const catalogExpr = getCol("catalog_number", "NULL");
  const pictureExpr = getCol("picture", "NULL");
  const artistTidalExpr = getCol("artist_tidal", columnSet.has("artist") ? "artist" : "NULL");
  const titleTidalExpr = getCol("title_tidal", columnSet.has("title") ? "title" : "NULL");
  const artistRaffaelloExpr = getCol("artist_raffaello", artistTidalExpr);
  const titleRaffaelloExpr = getCol("title_raffaello", titleTidalExpr);
  const durationExpr = getCol("duration", "NULL");
  const releaseExpr = getCol("release_date", "NULL");
  const ratingExpr = getCol("rating", "0");
  const updateTsExpr = getCol("update_ts", "NULL");
  const bookletExpr = getCol("booklet", "0");
  const updatedExpr = getCol("updated_at", "CURRENT_TIMESTAMP");

  await run(
    db,
    `INSERT INTO "${tempTable}" (
      id_albumu,
      row_order,
      selector,
      heard,
      favorite,
      label,
      link,
      format,
      roon_id,
      spotify_link,
      apple_music_link,
      catalog_number,
      picture,
      artist_raffaello,
      artist_tidal,
      title_raffaello,
      title_tidal,
      duration,
      release_date,
      rating,
      update_ts,
      booklet,
      updated_at
    )
    SELECT
      ${idExpr},
      ${rowOrderExpr},
      ${selectorExpr},
      ${heardExpr},
      ${favoriteExpr},
      ${labelExpr},
      ${linkExpr},
      ${formatExpr},
      ${roonExpr},
      ${spotifyExpr},
      ${appleExpr},
      ${catalogExpr},
      ${pictureExpr},
      ${artistRaffaelloExpr},
      ${artistTidalExpr},
      ${titleRaffaelloExpr},
      ${titleTidalExpr},
      ${durationExpr},
      ${releaseExpr},
      ${ratingExpr},
      ${updateTsExpr},
      ${bookletExpr},
      ${updatedExpr}
    FROM "${TABLE_NAME}"`
  );

  await run(db, `DROP TABLE "${TABLE_NAME}"`);
  await run(db, `ALTER TABLE "${tempTable}" RENAME TO "${TABLE_NAME}"`);
}

async function ensureSchema() {
  const db = await getDatabase();

  const existingColumns = await all(db, `PRAGMA table_info("${TABLE_NAME}")`);
  const columnSet = getColumnSet(existingColumns);
  const needsMigration =
    columnSet.size > 0 &&
    (!columnSet.has("id_albumu") ||
      columnSet.has("folder") ||
      columnSet.has("container") ||
      columnSet.has("ory_copy") ||
      columnSet.has("added") ||
      columnSet.has("artist") ||
      columnSet.has("title") ||
      !columnSet.has("artist_raffaello") ||
      !columnSet.has("artist_tidal") ||
      !columnSet.has("title_raffaello") ||
      !columnSet.has("title_tidal"));

  if (columnSet.size === 0) {
    await run(
      db,
      `CREATE TABLE IF NOT EXISTS "${TABLE_NAME}" (
        id_albumu INTEGER PRIMARY KEY AUTOINCREMENT,
        row_order INTEGER NOT NULL DEFAULT 0,
        selector TEXT NOT NULL DEFAULT 'N',
        heard INTEGER NOT NULL DEFAULT 0,
        favorite INTEGER NOT NULL DEFAULT 0,
        label TEXT NULL,
        link TEXT NULL,
        format TEXT NULL,
        roon_id TEXT NULL,
        spotify_link TEXT NULL,
        apple_music_link TEXT NULL,
        catalog_number TEXT NULL,
        picture TEXT NULL,
        artist_raffaello TEXT NULL,
        artist_tidal TEXT NULL,
        title_raffaello TEXT NULL,
        title_tidal TEXT NULL,
        duration INTEGER NULL,
        release_date INTEGER NULL,
        rating INTEGER NOT NULL DEFAULT 0,
        update_ts INTEGER NULL,
        booklet INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  );
  } else if (needsMigration) {
    await migrateAlbumsTable(db, columnSet);
  }

  const refreshedColumns = await all(db, `PRAGMA table_info("${TABLE_NAME}")`);
  const refreshedSet = getColumnSet(refreshedColumns);
  if (!refreshedSet.has("favorite")) {
    await run(db, `ALTER TABLE "${TABLE_NAME}" ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0`);
  }
  if (!refreshedSet.has("update_ts")) {
    await run(db, `ALTER TABLE "${TABLE_NAME}" ADD COLUMN update_ts INTEGER NULL`);
  }
  if (!refreshedSet.has("booklet")) {
    await run(db, `ALTER TABLE "${TABLE_NAME}" ADD COLUMN booklet INTEGER NOT NULL DEFAULT 0`);
  }
  if (!refreshedSet.has("rating")) {
    await run(db, `ALTER TABLE "${TABLE_NAME}" ADD COLUMN rating INTEGER NOT NULL DEFAULT 0`);
  }
  if (!refreshedSet.has("format")) {
    await run(db, `ALTER TABLE "${TABLE_NAME}" ADD COLUMN format TEXT NULL`);
  }
  if (!refreshedSet.has("roon_id")) {
    await run(db, `ALTER TABLE "${TABLE_NAME}" ADD COLUMN roon_id TEXT NULL`);
  }
  if (!refreshedSet.has("spotify_link")) {
    await run(db, `ALTER TABLE "${TABLE_NAME}" ADD COLUMN spotify_link TEXT NULL`);
  }
  if (!refreshedSet.has("apple_music_link")) {
    await run(db, `ALTER TABLE "${TABLE_NAME}" ADD COLUMN apple_music_link TEXT NULL`);
  }
  if (!refreshedSet.has("catalog_number")) {
    await run(db, `ALTER TABLE "${TABLE_NAME}" ADD COLUMN catalog_number TEXT NULL`);
  }

  await run(db, `CREATE INDEX IF NOT EXISTS "idx_${TABLE_NAME}_row_order" ON "${TABLE_NAME}" (row_order)`);

  await run(
    db,
    `CREATE TRIGGER IF NOT EXISTS "${TABLE_NAME}_updated_at"
    AFTER UPDATE ON "${TABLE_NAME}"
    BEGIN
      UPDATE "${TABLE_NAME}" SET updated_at = CURRENT_TIMESTAMP WHERE id_albumu = NEW.id_albumu;
    END;`
  );

  await run(
    db,
    `CREATE TABLE IF NOT EXISTS "${COLLECTIONS_TABLE_NAME}" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0
    )`
  );

  await run(
    db,
    `CREATE TABLE IF NOT EXISTS "${CONTAINERS_TABLE_NAME}" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      collection_id INTEGER NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(collection_id) REFERENCES "${COLLECTIONS_TABLE_NAME}"(id) ON DELETE SET NULL
    )`
  );

  const existingContainerColumns = await all(db, `PRAGMA table_info("${CONTAINERS_TABLE_NAME}")`);
  const containerColumnSet = getColumnSet(existingContainerColumns);
  if (!containerColumnSet.has("collection_id")) {
    await run(
      db,
      `ALTER TABLE "${CONTAINERS_TABLE_NAME}" ADD COLUMN collection_id INTEGER NULL REFERENCES "${COLLECTIONS_TABLE_NAME}"(id) ON DELETE SET NULL`
    );
  }

  await run(
    db,
    `CREATE INDEX IF NOT EXISTS "idx_${CONTAINERS_TABLE_NAME}_collection_id" ON "${CONTAINERS_TABLE_NAME}" (collection_id)`
  );

  await run(
    db,
    `CREATE TABLE IF NOT EXISTS "${FOLDERS_TABLE_NAME}" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      container_id INTEGER NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(container_id) REFERENCES "${CONTAINERS_TABLE_NAME}"(id) ON DELETE SET NULL
    )`
  );

  await run(
    db,
    `CREATE INDEX IF NOT EXISTS "idx_${FOLDERS_TABLE_NAME}_container_id" ON "${FOLDERS_TABLE_NAME}" (container_id)`
  );

  await run(
    db,
    `CREATE TABLE IF NOT EXISTS "${ALBUM_FOLDERS_TABLE_NAME}" (
      album_id INTEGER NOT NULL,
      folder_id INTEGER NOT NULL,
      added_ts INTEGER NOT NULL DEFAULT 0,
      row_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (album_id, folder_id),
      FOREIGN KEY(album_id) REFERENCES "${TABLE_NAME}"(id_albumu) ON DELETE CASCADE,
      FOREIGN KEY(folder_id) REFERENCES "${FOLDERS_TABLE_NAME}"(id) ON DELETE CASCADE
    )`
  );

  await run(
    db,
    `CREATE INDEX IF NOT EXISTS "idx_${ALBUM_FOLDERS_TABLE_NAME}_folder" ON "${ALBUM_FOLDERS_TABLE_NAME}" (folder_id, row_order)`
  );
  await run(
    db,
    `CREATE INDEX IF NOT EXISTS "idx_${ALBUM_FOLDERS_TABLE_NAME}_album" ON "${ALBUM_FOLDERS_TABLE_NAME}" (album_id)`
  );

  await run(
    db,
    `CREATE TABLE IF NOT EXISTS "${FILTER_TABLE_NAME}" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  );

  await run(
    db,
    `CREATE TRIGGER IF NOT EXISTS "${FILTER_TABLE_NAME}_updated_at"
    AFTER UPDATE ON "${FILTER_TABLE_NAME}"
    BEGIN
      UPDATE "${FILTER_TABLE_NAME}" SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;`
  );
}

const COLUMN_MAP = [
  { field: "ID_ALBUMU", column: "id_albumu" },
  { field: "SELECTOR", column: "selector" },
  { field: "HEARD", column: "heard" },
  { field: "FAVORITE", column: "favorite" },
  { field: "RATING", column: "rating" },
  { field: "LABEL", column: "label" },
  { field: "TIDAL_LINK", column: "link" },
  { field: "FORMAT", column: "format" },
  { field: "ROON_ID", column: "roon_id" },
  { field: "SPOTIFY_LINK", column: "spotify_link" },
  { field: "APPLE_MUSIC_LINK", column: "apple_music_link" },
  { field: "CATALOG_NUMBER", column: "catalog_number" },
  { field: "PICTURE", column: "picture" },
  { field: "ARTIST_RAFFAELLO", column: "artist_raffaello" },
  { field: "ARTIST_TIDAL", column: "artist_tidal" },
  { field: "TITLE_RAFFAELLO", column: "title_raffaello" },
  { field: "TITLE_TIDAL", column: "title_tidal" },
  { field: "DURATION", column: "duration" },
  { field: "RELEASE_DATE", column: "release_date" },
  { field: "UPDATE_TS", column: "update_ts" },
  { field: "BOOKLET", column: "booklet" }
];

function normalizeValue(column, value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (
    column === "duration" ||
    column === "release_date" ||
    column === "heard" ||
    column === "favorite" ||
    column === "id_albumu" ||
    column === "update_ts" ||
    column === "booklet" ||
    column === "rating"
  ) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return value;
}

function buildRoonId(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 999999) return "";
  return String(Math.floor(numeric)).padStart(6, "0");
}

function resolveRecordField(record = {}, field) {
  const getValue = (keys = []) => {
    for (const key of keys) {
      if (record[key] !== undefined) return record[key];
    }
    return undefined;
  };
  switch (field) {
    case "ARTIST_RAFFAELLO":
      return getValue(["ARTIST_RAFFAELLO", "ARTIST", "artist_raffaello", "artist"]);
    case "ARTIST_TIDAL":
      return getValue(["ARTIST_TIDAL", "ARTIST", "artist_tidal", "artist"]);
    case "TITLE_RAFFAELLO":
      return getValue(["TITLE_RAFFAELLO", "TITLE", "title_raffaello", "title"]);
    case "TITLE_TIDAL":
      return getValue(["TITLE_TIDAL", "TITLE", "title_tidal", "title"]);
    case "TIDAL_LINK":
      return getValue(["TIDAL_LINK", "LINK", "link", "tidal_link"]);
    case "FORMAT":
      return getValue(["FORMAT", "format"]);
    case "ROON_ID": {
      const existing = getValue(["ROON_ID", "roon_id", "roonId"]);
      if (existing !== undefined) return existing;
      const albumId = getValue(["ID_ALBUMU", "id_albumu", "id", "ID"]);
      return buildRoonId(albumId);
    }
    case "SPOTIFY_LINK":
      return getValue(["SPOTIFY_LINK", "spotify_link", "spotifyLink"]);
    case "APPLE_MUSIC_LINK":
      return getValue(["APPLE_MUSIC_LINK", "apple_music_link", "appleMusicLink"]);
    case "CATALOG_NUMBER":
      return getValue(["CATALOG_NUMBER", "catalog_number", "catalogNumber"]);
    case "BOOKLET":
      return getValue(["BOOKLET", "booklet"]) ?? 0;
    case "RATING":
      return getValue(["RATING", "rating"]) ?? 0;
    default: {
      const direct = getValue([field]);
      if (direct !== undefined) return direct;
      const lower = String(field || "").toLowerCase();
      return record[lower];
    }
  }
}

async function fetchAlbums() {
  const db = await getDatabase();
  const rows = await all(
    db,
    `SELECT ${COLUMN_MAP.map((c) => `"${c.column}"`).join(", ")}
     FROM "${TABLE_NAME}"
     ORDER BY row_order ASC, id_albumu ASC`
  );
  return rows.map((row) => {
    const record = {};
    COLUMN_MAP.forEach(({ field, column }) => {
      const raw = row[column];
      record[field] = raw === null || raw === undefined ? "" : raw;
    });
    return record;
  });
}

async function fetchContainers() {
  const db = await getDatabase();
  return all(
    db,
    `SELECT c.name, c.sort_order, col.name AS collection
     FROM "${CONTAINERS_TABLE_NAME}" c
     LEFT JOIN "${COLLECTIONS_TABLE_NAME}" col ON c.collection_id = col.id
     ORDER BY c.sort_order ASC, c.name COLLATE NOCASE ASC`
  );
}

async function fetchCollections() {
  const db = await getDatabase();
  return all(
    db,
    `SELECT name, sort_order
     FROM "${COLLECTIONS_TABLE_NAME}"
     ORDER BY sort_order ASC, name COLLATE NOCASE ASC`
  );
}

async function fetchFolders() {
  const db = await getDatabase();
  return all(
    db,
    `SELECT f.name, f.sort_order, c.name AS container
     FROM "${FOLDERS_TABLE_NAME}" f
     LEFT JOIN "${CONTAINERS_TABLE_NAME}" c ON f.container_id = c.id
     ORDER BY f.sort_order ASC, f.name COLLATE NOCASE ASC`
  );
}

async function fetchAlbumFolders() {
  const db = await getDatabase();
  return all(
    db,
    `SELECT af.album_id, af.added_ts, af.row_order, f.name AS folder
     FROM "${ALBUM_FOLDERS_TABLE_NAME}" af
     JOIN "${FOLDERS_TABLE_NAME}" f ON af.folder_id = f.id
     ORDER BY af.row_order ASC, af.added_ts DESC`
  );
}

async function fetchFilterPresets() {
  const db = await getDatabase();
  return all(
    db,
    `SELECT name, payload, updated_at
     FROM "${FILTER_TABLE_NAME}"
     ORDER BY name COLLATE NOCASE ASC`
  );
}

async function saveFilterPreset(name, payload) {
  const db = await getDatabase();
  const serialized = JSON.stringify(payload ?? {});
  await run(
    db,
    `INSERT INTO "${FILTER_TABLE_NAME}" (name, payload)
     VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET
       payload = excluded.payload,
       updated_at = CURRENT_TIMESTAMP`,
    [name, serialized]
  );
}

async function renameFilterPreset(currentName, nextName) {
  const db = await getDatabase();
  await run(
    db,
    `UPDATE "${FILTER_TABLE_NAME}"
     SET name = ?, updated_at = CURRENT_TIMESTAMP
     WHERE name = ?`,
    [nextName, currentName]
  );
}

async function deleteFilterPreset(name) {
  const db = await getDatabase();
  await run(
    db,
    `DELETE FROM "${FILTER_TABLE_NAME}"
     WHERE name = ?`,
    [name]
  );
}


async function replaceAlbums(records = []) {
  const db = await getDatabase();
  const total = records.length;
  const maxId = records.reduce((max, record) => {
    const id = Number(record?.ID_ALBUMU ?? record?.id_albumu ?? record?.id ?? 0);
    return Number.isFinite(id) ? Math.max(max, id) : max;
  }, 0);
  if (maxId > 999999) {
    throw new Error("Przekroczono maksymalną liczbę albumów (999999).");
  }
  const batchSize = 200;

  console.log(`🧹 DELETE + INSERT w paczkach (batchSize=${batchSize}) dla ${total} rekordów...`);

  try {
    const t0 = Date.now();
    await run(db, "BEGIN TRANSACTION");
    await run(db, `DELETE FROM "${ALBUM_FOLDERS_TABLE_NAME}"`);
    await run(db, `DELETE FROM "${TABLE_NAME}"`);
    try {
      await run(db, "DELETE FROM sqlite_sequence WHERE name = ?", [TABLE_NAME]);
    } catch (error) {
      console.warn("⚠️ Nie udało się zresetować sekwencji SQLite:", error.message);
    }
    const tAfterDelete = Date.now();

    if (total) {
      const dataColumns = COLUMN_MAP.map((c) => `"${c.column}"`);
      const columns = [...dataColumns, '"row_order"'];

      let inserted = 0;

      for (let offset = 0; offset < total; offset += batchSize) {
        const batch = records.slice(offset, offset + batchSize);

        const placeholders = batch.map(() => `(${COLUMN_MAP.map(() => "?").join(", ")}, ?)`).join(", ");

        const values = [];

        batch.forEach((record, indexInBatch) => {
          COLUMN_MAP.forEach(({ field, column }) => {
            values.push(normalizeValue(column, resolveRecordField(record, field)));
          });
          const rowOrder = offset + indexInBatch;
          values.push(rowOrder);
        });

        const sql = `INSERT INTO "${TABLE_NAME}" (${columns.join(", ")}) VALUES ${placeholders}`;
        await run(db, sql, values);

        inserted += batch.length;
        console.log(`   → Wstawiono ${inserted}/${total} rekordów...`);
      }
    }

    await run(db, "COMMIT");
    const tEnd = Date.now();

    const deleteMs = tAfterDelete - t0;
    const insertMs = tEnd - tAfterDelete;
    const totalMs = tEnd - t0;

    console.log(
      `✅ Zastąpiono rekordy w bazie. Łącznie: ${total}. ` +
      `DELETE: ${deleteMs} ms, INSERT: ${insertMs} ms, razem: ${(totalMs / 1000).toFixed(2)} s.`
    );

    return total;
  } catch (error) {
    await run(db, "ROLLBACK");
    console.error("❌ Błąd w replaceAlbums:", error.message);
    throw error;
  }
}

async function appendRecords(records = [], { markUpdated = false } = {}) {
  const db = await getDatabase();
  const sourceRows = Array.isArray(records) ? records.length : 0;
  if (!sourceRows) return { inserted: 0, duplicates: 0, missingLink: 0, sourceRows: 0 };

  const existingRows = await all(db, `SELECT link, row_order FROM "${TABLE_NAME}" ORDER BY row_order ASC`);
  const existingKeys = new Set();
  let maxOrder = 0;

  existingRows.forEach((row) => {
    const linkKey = row.link || "";
    if (linkKey) existingKeys.add(linkKey);
    maxOrder = Math.max(maxOrder, row.row_order || 0);
  });

  const dataColumns = COLUMN_MAP.map((c) => `"${c.column}"`);
  const columns = [...dataColumns, '"row_order"'];

  const rowsToInsert = [];
  const insertedLinks = [];
  const duplicateRecords = [];
  let order = maxOrder + 1;

  let duplicates = 0;
  let missingLink = 0;

  const updateStamp = markUpdated ? Date.now() : null;
  records.forEach((record) => {
    const linkKey = record.TIDAL_LINK || record.LINK || record.link || record.tidal_link || "";
    if (!linkKey) {
      missingLink += 1;
      return;
    }
    if (existingKeys.has(linkKey)) {
      duplicates += 1;
      duplicateRecords.push(record);
      return;
    }
    existingKeys.add(linkKey);
    insertedLinks.push(linkKey);

    const rowValues = [];
    COLUMN_MAP.forEach(({ field, column }) => {
      const resolved = field === "UPDATE_TS" && updateStamp ? updateStamp : resolveRecordField(record, field);
      rowValues.push(normalizeValue(column, resolved));
    });
    rowValues.push(order);
    order += 1;
    rowsToInsert.push(rowValues);
  });

  if (!rowsToInsert.length) {
    return { inserted: 0, duplicates, missingLink, sourceRows, insertedLinks, duplicateRecords };
  }

  const batchSize = 200;

  await run(db, "BEGIN TRANSACTION");
  try {
    for (let offset = 0; offset < rowsToInsert.length; offset += batchSize) {
      const batch = rowsToInsert.slice(offset, offset + batchSize);
      const placeholders = batch.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
      const flatValues = batch.flat();
      await run(db, `INSERT INTO "${TABLE_NAME}" (${columns.join(", ")}) VALUES ${placeholders}`, flatValues);
    }
    await run(db, "COMMIT");
  } catch (error) {
    await run(db, "ROLLBACK");
    throw error;
  }

  return { inserted: rowsToInsert.length, duplicates, missingLink, sourceRows, insertedLinks, duplicateRecords };
}

async function getAlbumImportState() {
  const db = await getDatabase();
  const rows = await all(db, `SELECT id_albumu, link, row_order FROM "${TABLE_NAME}"`);
  const linkMap = new Map();
  const tidalIdMap = new Map();
  let maxId = 0;
  let maxOrder = 0;
  rows.forEach((row) => {
    const id = Number(row.id_albumu) || 0;
    const order = Number(row.row_order) || 0;
    if (id > maxId) maxId = id;
    if (order > maxOrder) maxOrder = order;
    const link = row.link || "";
    if (link) linkMap.set(link, id);
    const tidalId = extractTidalAlbumId(link);
    if (tidalId) tidalIdMap.set(tidalId, id);
  });
  return { maxId, maxOrder, linkMap, tidalIdMap };
}

async function resolveCollectionId(db, collectionName) {
  if (!collectionName || collectionName === "__all__" || collectionName === "brak") return null;
  const existing = await all(db, `SELECT id FROM "${COLLECTIONS_TABLE_NAME}" WHERE name = ?`, [collectionName]);
  if (existing[0]?.id) return existing[0].id;
  const maxRow = await all(db, `SELECT MAX(sort_order) as max_order FROM "${COLLECTIONS_TABLE_NAME}"`);
  const nextOrder = Number(maxRow[0]?.max_order ?? -1) + 1;
  const insert = await run(
    db,
    `INSERT INTO "${COLLECTIONS_TABLE_NAME}" (name, sort_order) VALUES (?, ?)`,
    [collectionName, nextOrder]
  );
  return insert?.lastID || null;
}

function buildErrorContainerName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}_${pad(
    date.getHours()
  )}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `ERROR_${stamp}`;
}

function buildFolderNameForIssues(missingFields = [], isDuplicate = false) {
  const parts = [];
  if (isDuplicate) parts.push("duplikat");
  missingFields.forEach((field) => {
    parts.push(`brak_${field}`);
  });
  return parts.join("_and_");
}

async function createErrorContainer(db, { collectionName } = {}) {
  const containers = await all(db, `SELECT name, sort_order FROM "${CONTAINERS_TABLE_NAME}"`);
  const existing = new Set(containers.map((row) => row.name));
  let name = buildErrorContainerName();
  let index = 1;
  while (existing.has(name)) {
    name = `${buildErrorContainerName()} (${index})`;
    index += 1;
  }
  const maxSort = containers.reduce((max, row) => Math.max(max, Number(row.sort_order) || 0), -1);
  const collectionId = await resolveCollectionId(db, collectionName);
  const insert = await run(
    db,
    `INSERT INTO "${CONTAINERS_TABLE_NAME}" (name, collection_id, sort_order) VALUES (?, ?, ?)`,
    [name, collectionId, maxSort + 1]
  );
  return { name, id: insert.lastID };
}

async function assignErrorFolders(db, { errorAssignments = [], collectionName, now = Date.now() } = {}) {
  const result = {
    errorContainerName: null,
    errorFoldersCreated: 0,
    errorAssignmentsInserted: 0
  };

  if (!errorAssignments.length) return result;

  const { name: containerName, id: containerId } = await createErrorContainer(db, { collectionName });
  result.errorContainerName = containerName;

  const baseNames = Array.from(
    new Set(errorAssignments.map((assignment) => String(assignment.folderName || "").trim()).filter(Boolean))
  );
  const existingFolders = await all(db, `SELECT name FROM "${FOLDERS_TABLE_NAME}"`);
  const existingFolderNames = new Set(existingFolders.map((row) => row.name));
  const folderNameMap = new Map();

  baseNames.forEach((base) => {
    let candidate = base;
    let index = 1;
    while (existingFolderNames.has(candidate)) {
      candidate = `${base} (${index})`;
      index += 1;
    }
    folderNameMap.set(base, candidate);
    existingFolderNames.add(candidate);
  });

  if (folderNameMap.size) {
    const maxSortRow = await all(db, `SELECT MAX(sort_order) as max_order FROM "${FOLDERS_TABLE_NAME}"`);
    let nextSortOrder = Number(maxSortRow[0]?.max_order ?? -1) + 1;

    const folderValues = [];
    const folderRows = [];
    folderNameMap.forEach((uniqueName) => {
      folderValues.push(uniqueName, containerId, nextSortOrder);
      folderRows.push("(?, ?, ?)");
      nextSortOrder += 1;
    });

    await run(
      db,
      `INSERT INTO "${FOLDERS_TABLE_NAME}" (name, container_id, sort_order) VALUES ${folderRows.join(", ")}`,
      folderValues
    );
    result.errorFoldersCreated = folderNameMap.size;
  }

  const uniqueFolderNames = Array.from(folderNameMap.values());
  const folderRows = uniqueFolderNames.length
    ? await all(
        db,
        `SELECT id, name FROM "${FOLDERS_TABLE_NAME}" WHERE name IN (${uniqueFolderNames
          .map(() => "?")
          .join(", ")})`,
        uniqueFolderNames
      )
    : [];
  const folderIdMap = new Map(folderRows.map((row) => [row.name, row.id]));
  const folderIds = folderRows.map((row) => row.id);

  const maxOrderRows = folderIds.length
    ? await all(
        db,
        `SELECT folder_id, MAX(row_order) as max_order
             FROM "${ALBUM_FOLDERS_TABLE_NAME}"
             WHERE folder_id IN (${folderIds.map(() => "?").join(", ")})
             GROUP BY folder_id`,
        folderIds
      )
    : [];
  const folderOrderMap = new Map(maxOrderRows.map((row) => [row.folder_id, Number(row.max_order) || 0]));

  const assignmentValues = [];
  const assignmentRows = [];

  errorAssignments.forEach((assignment) => {
    const baseName = String(assignment.folderName || "").trim();
    const albumId = Number(assignment.albumId);
    if (!baseName || !Number.isFinite(albumId) || albumId <= 0) return;
    const targetName = folderNameMap.get(baseName) || baseName;
    const folderId = folderIdMap.get(targetName);
    if (!folderId) return;
    const nextOrder = (folderOrderMap.get(folderId) || 0) + 1;
    folderOrderMap.set(folderId, nextOrder);
    assignmentValues.push(albumId, folderId, now, nextOrder);
    assignmentRows.push("(?, ?, ?, ?)");
  });

  if (assignmentRows.length) {
    const stmt = await run(
      db,
      `INSERT OR IGNORE INTO "${ALBUM_FOLDERS_TABLE_NAME}" (album_id, folder_id, added_ts, row_order)
           VALUES ${assignmentRows.join(", ")}`,
      assignmentValues
    );
    result.errorAssignmentsInserted = stmt?.changes || 0;
  }

  return result;
}

async function importJsonAlbums({
  records = [],
  errorAssignments = [],
  collectionName,
  onBeforeInsert,
  onAfterInsert
} = {}) {
  const db = await getDatabase();
  const result = {
    inserted: 0,
    errorContainerName: null,
    errorFoldersCreated: 0,
    errorAssignmentsInserted: 0
  };
  const now = Date.now();

  await run(db, "BEGIN TRANSACTION");
  try {
    if (records.length) {
      const dataColumns = COLUMN_MAP.map((c) => `"${c.column}"`);
      const columns = [...dataColumns, '"row_order"'];
      const hasCallbacks = typeof onBeforeInsert === "function" || typeof onAfterInsert === "function";

      if (hasCallbacks) {
        for (let index = 0; index < records.length; index += 1) {
          const record = records[index];
          if (typeof onBeforeInsert === "function") {
            await onBeforeInsert(record, index + 1);
          }
          const values = [];
          COLUMN_MAP.forEach(({ field, column }) => {
            values.push(normalizeValue(column, resolveRecordField(record, field)));
          });
          values.push(Number(record.row_order) || 0);
          const placeholders = `(${COLUMN_MAP.map(() => "?").join(", ")}, ?)`;
          await run(db, `INSERT INTO "${TABLE_NAME}" (${columns.join(", ")}) VALUES ${placeholders}`, values);
          if (typeof onAfterInsert === "function") {
            await onAfterInsert(record, index + 1);
          }
        }
        result.inserted = records.length;
      } else {
        const batchSize = 200;

        for (let offset = 0; offset < records.length; offset += batchSize) {
          const batch = records.slice(offset, offset + batchSize);
          const placeholders = batch.map(() => `(${COLUMN_MAP.map(() => "?").join(", ")}, ?)`).join(", ");
          const values = [];

          batch.forEach((record) => {
            COLUMN_MAP.forEach(({ field, column }) => {
              values.push(normalizeValue(column, resolveRecordField(record, field)));
            });
            values.push(Number(record.row_order) || 0);
          });

          await run(db, `INSERT INTO "${TABLE_NAME}" (${columns.join(", ")}) VALUES ${placeholders}`, values);
        }
        result.inserted = records.length;
      }
    }

    if (errorAssignments.length) {
      const assignmentResult = await assignErrorFolders(db, { errorAssignments, collectionName, now });
      result.errorContainerName = assignmentResult.errorContainerName;
      result.errorFoldersCreated = assignmentResult.errorFoldersCreated;
      result.errorAssignmentsInserted = assignmentResult.errorAssignmentsInserted;
    }

    await run(db, "COMMIT");
  } catch (error) {
    await run(db, "ROLLBACK");
    throw error;
  }

  return result;
}

async function checkDatabaseRecords({ collectionName } = {}) {
  await ensureSchema();
  const db = await getDatabase();
  const rows = await all(
    db,
    `SELECT id_albumu, label, link, picture, artist_raffaello, artist_tidal, title_raffaello, title_tidal, duration, release_date␊
     FROM "${TABLE_NAME}"`
  );

  const missingCounts = {
    TIDAL_LINK: 0,
    ARTIST_RAFFAELLO: 0,
    ARTIST_TIDAL: 0,
    TITLE_RAFFAELLO: 0,
    TITLE_TIDAL: 0,
    DURATION: 0,
    RELEASE_DATE: 0,
    PICTURE: 0,
    LABEL: 0
  };
  const errorAssignments = [];
  let incompleteRecords = 0;

  rows.forEach((row) => {
    const missingFields = [];
    const link = String(row.link ?? "").trim();
    const artistRaffaello = String(row.artist_raffaello ?? "").trim();
    const artistTidal = String(row.artist_tidal ?? "").trim();
    const titleRaffaello = String(row.title_raffaello ?? "").trim();
    const titleTidal = String(row.title_tidal ?? "").trim();
    const picture = String(row.picture ?? "").trim();
    const label = String(row.label ?? "").trim();
    const duration = Number(row.duration);
    const releaseDate = Number(row.release_date);

    if (!link) missingFields.push("TIDAL_LINK");
    if (!artistRaffaello) missingFields.push("ARTIST_RAFFAELLO");
    if (!artistTidal) missingFields.push("ARTIST_TIDAL");
    if (!titleRaffaello) missingFields.push("TITLE_RAFFAELLO");
    if (!titleTidal) missingFields.push("TITLE_TIDAL");
    if (!Number.isFinite(duration) || duration <= 0) missingFields.push("DURATION");
    if (!Number.isFinite(releaseDate) || releaseDate <= 0) missingFields.push("RELEASE_DATE");
    if (!picture) missingFields.push("PICTURE");
    if (!label) missingFields.push("LABEL");

    if (missingFields.length) {
      incompleteRecords += 1;
      missingFields.forEach((field) => {
        missingCounts[field] += 1;
      });
      errorAssignments.push({
        albumId: row.id_albumu,
        folderName: buildFolderNameForIssues(missingFields)
      });
    }
  });

  const assignmentResult = await assignErrorFolders(db, { errorAssignments, collectionName });

  return {
    totalRecords: rows.length,
    incompleteRecords,
    missingCounts,
    errorContainerName: assignmentResult.errorContainerName,
    errorFoldersCreated: assignmentResult.errorFoldersCreated,
    errorAssignmentsInserted: assignmentResult.errorAssignmentsInserted
  };
}

async function createDatabaseBackup() {
  await ensureSchema();
  await ensureBackupDir();
  const sourcePath = await resolveDatabaseFile();
  const backupFileName = buildDatabaseFileName();
  const backupPath = path.join(BACKUP_DIR, backupFileName);
  await fs.promises.copyFile(sourcePath, backupPath);
  dbFilePath = backupPath;
  await closeDatabase();
  return { backupFileName, backupPath, sourcePath };
}

async function replaceFolderData({ collections = [], containers = [], folders = [], albumFolders = [] } = {}) {
  const db = await getDatabase();
  await run(db, "BEGIN TRANSACTION");
  try {
    await run(db, `DELETE FROM "${ALBUM_FOLDERS_TABLE_NAME}"`);
    await run(db, `DELETE FROM "${FOLDERS_TABLE_NAME}"`);
    await run(db, `DELETE FROM "${CONTAINERS_TABLE_NAME}"`);
    await run(db, `DELETE FROM "${COLLECTIONS_TABLE_NAME}"`);
    await run(db, "DELETE FROM sqlite_sequence WHERE name = ?", [CONTAINERS_TABLE_NAME]);
    await run(db, "DELETE FROM sqlite_sequence WHERE name = ?", [FOLDERS_TABLE_NAME]);
    await run(db, "DELETE FROM sqlite_sequence WHERE name = ?", [COLLECTIONS_TABLE_NAME]);

    if (collections.length || containers.length) {
      const normalizedCollections = [];
      const seen = new Set();
      collections.forEach((collection, index) => {
        const name = String(collection?.name || collection || "").trim();
        if (!name || name === "brak" || seen.has(name)) return;
        seen.add(name);
        normalizedCollections.push({
          name,
          sort_order: Number(collection?.sort_order ?? index) || index
        });
      });
      containers.forEach((container) => {
        const name = String(container?.collection || "").trim();
        if (!name || name === "brak" || seen.has(name)) return;
        seen.add(name);
        normalizedCollections.push({
          name,
          sort_order: normalizedCollections.length
        });
      });

      if (normalizedCollections.length) {
        const collectionValues = [];
        const collectionRows = normalizedCollections.map((collection) => {
          collectionValues.push(collection.name, Number(collection.sort_order) || 0);
          return "(?, ?)";
        });
        await run(
          db,
          `INSERT INTO "${COLLECTIONS_TABLE_NAME}" (name, sort_order) VALUES ${collectionRows.join(", ")}`,
          collectionValues
        );
      }
    }

    if (containers.length) {
      const collectionRows = await all(db, `SELECT id, name FROM "${COLLECTIONS_TABLE_NAME}"`);
      const collectionMap = new Map(collectionRows.map((row) => [row.name, row.id]));
      const containerValues = [];
      const containerRows = containers.map((container, index) => {
        const collectionName = String(container?.collection || "").trim();
        const collectionId = collectionName && collectionMap.has(collectionName) ? collectionMap.get(collectionName) : null;
        containerValues.push(container.name, collectionId, Number(container.sort_order ?? index) || index);
        return "(?, ?, ?)";
      });
      await run(
        db,
        `INSERT INTO "${CONTAINERS_TABLE_NAME}" (name, collection_id, sort_order) VALUES ${containerRows.join(", ")}`,
        containerValues
      );
    }

    if (folders.length) {
      const containerRows = await all(db, `SELECT id, name FROM "${CONTAINERS_TABLE_NAME}"`);
      const containerMap = new Map(containerRows.map((row) => [row.name, row.id]));
      const folderValues = [];
      const folderRows = folders.map((folder, index) => {
        const containerId = folder.container && containerMap.has(folder.container) ? containerMap.get(folder.container) : null;
        folderValues.push(folder.name, containerId, Number(folder.sort_order ?? index) || index);
        return "(?, ?, ?)";
      });
      await run(
        db,
        `INSERT INTO "${FOLDERS_TABLE_NAME}" (name, container_id, sort_order) VALUES ${folderRows.join(", ")}`,
        folderValues
      );
    }

    if (albumFolders.length) {
      const folderRows = await all(db, `SELECT id, name FROM "${FOLDERS_TABLE_NAME}"`);
      const folderMap = new Map(folderRows.map((row) => [row.name, row.id]));
      const values = [];
      const placeholders = albumFolders
        .map((assignment) => {
          const folderId = folderMap.get(assignment.folder);
          const albumId = Number(assignment.album_id);
          if (!folderId || !Number.isFinite(albumId) || albumId <= 0) return null;
          values.push(albumId, folderId, Number(assignment.added_ts) || 0, Number(assignment.row_order) || 0);
          return "(?, ?, ?, ?)";
        })
        .filter(Boolean);
      if (placeholders.length) {
        await run(
          db,
          `INSERT INTO "${ALBUM_FOLDERS_TABLE_NAME}" (album_id, folder_id, added_ts, row_order)
           VALUES ${placeholders.join(", ")}`,
          values
        );
      }
    }

    await run(db, "COMMIT");
  } catch (error) {
    await run(db, "ROLLBACK");
    throw error;
  }
}

module.exports = {
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
  TABLE_NAME,
  COLLECTIONS_TABLE_NAME,
  CONTAINERS_TABLE_NAME,
  FOLDERS_TABLE_NAME,
  ALBUM_FOLDERS_TABLE_NAME,
  FILTER_TABLE_NAME,
  resolvedConfig
};