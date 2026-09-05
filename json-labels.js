const fs = require("fs");

function sanitizeJsonLabel(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveImportedLabel(jsonValue, excelValue = "") {
  return sanitizeJsonLabel(jsonValue) || sanitizeJsonLabel(excelValue) || "unknown";
}

function getLabelNameFromHierarchy(entry) {
  const parts = String(entry || "").split(" - ");
  parts.shift();
  return parts.join(" - ").trim();
}

async function addLabelsToHierarchy(labelsPath, labels = [], defaultHierarchy = []) {
  let raw = "";
  try {
    raw = await fs.promises.readFile(labelsPath, "utf8");
  } catch (_error) {
    raw = `${defaultHierarchy.join("\n")}\n`;
  }

  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  const knownNames = new Set(
    lines.map(getLabelNameFromHierarchy).filter(Boolean).map((name) => name.toLocaleLowerCase())
  );
  const newLabels = [];
  for (const value of labels) {
    const label = sanitizeJsonLabel(value);
    const key = label.toLocaleLowerCase();
    if (!label || knownNames.has(key)) continue;
    knownNames.add(key);
    newLabels.push(label);
  }
  if (!newLabels.length) return [];

  const usedCodes = lines
    .map((line) => Number.parseInt(line.match(/^(\d+)[A-Z]\s+-\s+/)?.[1], 10))
    .filter((code) => Number.isFinite(code) && code < 99);
  let nextCode = Math.max(0, ...usedCodes) + 1;
  const additions = newLabels.map((label) => `${String(nextCode++).padStart(2, "0")}C - ${label}`);
  const unknownIndex = lines.findIndex(
    (line) => getLabelNameFromHierarchy(line).toLocaleLowerCase() === "unknown"
  );
  lines.splice(unknownIndex >= 0 ? unknownIndex : lines.length, 0, ...additions);

  const temporaryPath = `${labelsPath}.tmp`;
  await fs.promises.writeFile(temporaryPath, `${lines.join("\n")}\n`, "utf8");
  await fs.promises.rename(temporaryPath, labelsPath);
  return newLabels;
}

module.exports = { addLabelsToHierarchy, getLabelNameFromHierarchy, resolveImportedLabel, sanitizeJsonLabel };
