const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

test("duplicate import only fills an empty or unknown label", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "raffaello-db-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.copyFile(path.join(__dirname, "..", "db.js"), path.join(directory, "db.js"));
  await fs.copyFile(path.join(__dirname, "..", "db.config.example.json"), path.join(directory, "db.config.example.json"));
  await fs.symlink(path.join(__dirname, "..", "node_modules"), path.join(directory, "node_modules"), "dir");

  const script = `
    const db = require('./db');
    (async () => {
      await db.ensureSchema();
      const base = {
        ID_ALBUMU: 1, SELECTOR: 'N', HEARD: 0, FAVORITE: 0, RATING: 0, BOOKLET: 0, CD_BACK: 0,
        TIDAL_LINK: 'https://tidal.com/album/123', LABEL: 'unknown', row_order: 1
      };
      await db.importJsonAlbums({ records: [base, { ...base, ID_ALBUMU: 2, TIDAL_LINK: 'two', LABEL: '', row_order: 2 }] });
      const first = await db.importJsonAlbums({ labelUpdates: [
        { albumId: 1, label: 'JSON Label' }, { albumId: 2, label: 'Empty Label Filled' }
      ] });
      const second = await db.importJsonAlbums({ labelUpdates: [{ albumId: 1, label: 'Must Not Replace' }] });
      const albums = await db.fetchAlbums();
      process.stdout.write(JSON.stringify({ first: first.updatedLabels, second: second.updatedLabels, albums }));
    })().catch((error) => { console.error(error); process.exit(1); });
  `;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
  assert.deepEqual(output.first, ["JSON Label", "Empty Label Filled"]);
  assert.deepEqual(output.second, []);
  assert.equal(output.albums[0].LABEL, "JSON Label");
  assert.equal(output.albums[0].TIDAL_LINK, "https://tidal.com/album/123");
  assert.equal(output.albums[1].LABEL, "Empty Label Filled");
});
