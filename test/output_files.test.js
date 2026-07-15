const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const { formatRunTimestamp, resolveUniqueOutputPath, atomicWriteFile, validateXlsx } = require('../output_files');

test('formatRunTimestamp uses one DD-MM-YYYY_HH-MM-SS format', () => {
  assert.equal(formatRunTimestamp(new Date(2026, 6, 15, 18, 45, 20)), '15-07-2026_18-45-20');
});

test('resolveUniqueOutputPath never overwrites and adds _01/_02 on same-second collisions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raffaello-output-'));
  const stamp = '15-07-2026_18-45-20';
  fs.writeFileSync(path.join(dir, `title_artist_label_${stamp}.xlsx`), 'old');
  let p = await resolveUniqueOutputPath(dir, `title_artist_label_${stamp}`, '.xlsx');
  assert.equal(path.basename(p), `title_artist_label_${stamp}_01.xlsx`);
  fs.writeFileSync(p, 'old2');
  p = await resolveUniqueOutputPath(dir, `title_artist_label_${stamp}`, '.xlsx');
  assert.equal(path.basename(p), `title_artist_label_${stamp}_02.xlsx`);
});

test('atomicWriteFile writes through a session directory and preserves existing files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raffaello-atomic-'));
  const outputDir = path.join(root, 'download');
  const sessionDir = path.join(outputDir, '.sessions', 's1');
  fs.mkdirSync(outputDir, { recursive: true });
  const existing = path.join(outputDir, 'list_links_15-07-2026_18-45-20.txt');
  fs.writeFileSync(existing, 'previous');
  const manifest = { files: [] };
  const out = await atomicWriteFile({ sessionDir, outputDir, baseName: 'list_links_15-07-2026_18-45-20', extension: '.txt', content: 'new\n', type: 'links', manifest });
  assert.equal(fs.readFileSync(existing, 'utf8'), 'previous');
  assert.equal(path.basename(out), 'list_links_15-07-2026_18-45-20_01.txt');
  assert.equal(manifest.files.length, 1);
});

test('atomic XLSX validation requires albums sheet and headers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raffaello-xlsx-'));
  const outputDir = path.join(root, 'download');
  const sessionDir = path.join(outputDir, '.sessions', 's2');
  const manifest = { files: [] };
  const out = await atomicWriteFile({
    sessionDir,
    outputDir,
    baseName: 'title_artist_label_PARTIAL_15-07-2026_18-45-20',
    extension: '.xlsx',
    type: 'xlsx',
    manifest,
    partial: true,
    validate: validateXlsx(['album_title', 'main_artists', 'label', 'album_url', 'release_date']),
    content: (tmp) => {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ album_title: 'A', main_artists: 'B', label: 'C', album_url: 'u', release_date: '15.07.2026' }], { header: ['album_title', 'main_artists', 'label', 'album_url', 'release_date'] }), 'albums');
      XLSX.writeFile(wb, tmp);
    }
  });
  assert.equal(path.basename(out), 'title_artist_label_PARTIAL_15-07-2026_18-45-20.xlsx');
  assert.equal(manifest.files[0].partial, true);
});
