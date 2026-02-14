const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadDataModule() {
  const dataPath = path.resolve(__dirname, '..', 'data.js');
  const source = fs.readFileSync(dataPath, 'utf8');
  const transformed = source.replace(
    /export\s*\{([\s\S]*?)\};\s*$/,
    'module.exports = {$1};\n'
  );

  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    require,
    console,
    window: {},
    URL,
    Date,
    Set,
    Map
  });

  const script = new vm.Script(transformed, { filename: 'data.js' });
  script.runInContext(context);
  return module.exports;
}

function sortedSelection(store) {
  return Array.from(store.getLabelSelection()).sort();
}

function sortedActiveFilterSelection(store) {
  return Array.from(store.activeFilters.labelsSet).sort();
}

function labelsKeyFrom(values) {
  return [...values].sort().join('|');
}

(function run() {
  const { DataStore } = loadDataModule();

  // Case 1 (ALL): A,B selected -> A,B,C should remain selected after update.
  const allStore = new DataStore();
  allStore.setLabelHierarchy(['01 - A', '02 - B']);
  allStore.setLabelSelection(new Set(['A', 'B']));
  allStore.setLabelHierarchy(['01 - A', '02 - B', '03 - C']);
  assert.deepStrictEqual(sortedSelection(allStore), ['A', 'B', 'C']);
  assert.deepStrictEqual(sortedActiveFilterSelection(allStore), ['A', 'B', 'C']);
  assert.strictEqual(allStore.activeFilters.labelsKey, labelsKeyFrom(['A', 'B', 'C']));

  // Case 2 (PARTIAL): only A selected -> should stay A after update.
  const partialStore = new DataStore();
  partialStore.setLabelHierarchy(['01 - A', '02 - B']);
  partialStore.setLabelSelection(new Set(['A']));
  partialStore.setLabelHierarchy(['01 - A', '02 - B', '03 - C']);
  assert.deepStrictEqual(sortedSelection(partialStore), ['A']);
  assert.deepStrictEqual(sortedActiveFilterSelection(partialStore), ['A']);
  assert.strictEqual(partialStore.activeFilters.labelsKey, labelsKeyFrom(['A']));

  // Case 3 (EMPTY): selection no longer exists -> fallback to all available labels.
  const emptyStore = new DataStore();
  emptyStore.setLabelHierarchy(['01 - A', '02 - B']);
  emptyStore.setLabelSelection(new Set(['X']));
  emptyStore.setLabelHierarchy(['01 - A', '02 - B']);
  assert.deepStrictEqual(sortedSelection(emptyStore), ['A', 'B']);
  assert.deepStrictEqual(sortedActiveFilterSelection(emptyStore), ['A', 'B']);
  assert.strictEqual(emptyStore.activeFilters.labelsKey, labelsKeyFrom(['A', 'B']));

  console.log('label hierarchy regression checks passed');
})();
