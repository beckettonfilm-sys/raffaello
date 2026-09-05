const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { addLabelsToHierarchy, resolveImportedLabel, sanitizeJsonLabel } = require("../json-labels");

test("accepts only a non-empty string label", () => {
  assert.equal(sanitizeJsonLabel("  Chandos  "), "Chandos");
  for (const value of [undefined, null, "  ", 42, {}, []]) {
    assert.equal(sanitizeJsonLabel(value), "");
  }
});

test("JSON label has precedence over Excel and missing labels remain compatible", () => {
  assert.equal(resolveImportedLabel(" JSON Label ", "Excel Label"), "JSON Label");
  assert.equal(resolveImportedLabel(null, " Excel Label "), "Excel Label");
  assert.equal(resolveImportedLabel(undefined), "unknown");
});

test("adds unique labels before unknown without changing existing entries", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "raffaello-labels-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "labels.txt");
  await fs.writeFile(filePath, "01A - Existing\n99Z - unknown\n", "utf8");

  const added = await addLabelsToHierarchy(filePath, [" New Label ", "Existing", "new label"]);
  assert.deepEqual(added, ["New Label"]);
  assert.equal(await fs.readFile(filePath, "utf8"), "01A - Existing\n02C - New Label\n99Z - unknown\n");
});
