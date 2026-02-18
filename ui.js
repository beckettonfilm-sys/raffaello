import {
  DataStore,
  ALBUMS_PER_PAGE,
  CATEGORY_CLASSES,
  LABEL_HIERARCHY,
  LABEL_MAP,
  formatStatusDate,
  formatDuration,
  truncateName
} from "./data.js";
import {
  fetchWorkbook,
  updateWorkbook,
  exportWorkbookToFile,
  importWorkbookFromFile,
  importNewsWorkbookFromFile,
  importJsonFromFile,
  runQobuzScraper,
  deleteAlbumAssets,
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
  checkFileExists
} from "./api.js";

const DATA_DIRECTORIES = {
  importDb: ["DATABASE", "MUSIC_DATABASE"],
  importJson: ["DATABASE", "UPDATE_JSON"],
  updateDb: ["DATABASE", "UPDATE_DATABASE"],
  exportDb: ["DATABASE", "EXPORT_DATABASE"],
  download: ["DATABASE", "EXPORT_DATABASE"]
};

const DATA_PREFIXES = {
  importDb: "music_database",
  updateDb: "update_database"
};

function buildPath(base, ...segments) {
  const normalize = (value) => String(value || "").replace(/[\\/]+$/, "");
  let result = normalize(base);
  segments.forEach((segment) => {
    const cleaned = String(segment || "").replace(/^\\+|^\/+/g, "");
    if (!cleaned) return;
    if (result && !/[\\/]$/.test(result)) {
      result += "/";
    }
    result += cleaned;
  });
  return result;
}

const SELECTOR_LABELS = {
  N: "NIEWYSŁUCHANY",
  X: "SPRAWDZONY",
  F: "PROPOZYCJA",
  K: "WYSŁUCHANY",
  O: "DO OCENY"
};

const SELECTOR_STYLES = {
  N: {
    borderColor: "rgba(255,130,169,0.5)",
    hoverColor: "rgba(255,0,81,1)",
    infoBg: "#FDFFFC"
  },
  X: {
    borderColor: "rgba(150,150,150,0.6)",
    hoverColor: "rgba(150,150,150,1)",
    infoBg: "#f7f7f7"
  },
  F: {
    borderColor: "rgba(30, 136, 229, 0.45)",
    hoverColor: "rgba(30, 136, 229, 0.85)",
    infoBg: "#e3f2fd"
  },
  K: {
    borderColor: "rgba(67, 160, 71, 0.45)",
    hoverColor: "rgba(67, 160, 71, 0.85)",
    infoBg: "#e8f5e9"
    },
  O: {
    borderColor: "rgba(255, 235, 59, 0.55)",
    hoverColor: "rgba(255, 193, 7, 0.95)",
    infoBg: "#fff9c4"
  }
};

const SELECTOR_VALUES = Object.keys(SELECTOR_LABELS);

function truncateForStatus(name, maxLength = 15) {
  if (!name) return "";
  if (name.length <= maxLength) return name;
  return `${name.slice(0, maxLength)}...`;
}

function getSelectorStyle(selector) {
  return SELECTOR_STYLES[selector] || SELECTOR_STYLES.N;
}

class UiController {
  constructor(store = new DataStore()) {
    this.store = store;
    this.remixSlotsPerPage = 5;
    this.remixTotalSlots = 50;
    this.remixPageCount = Math.ceil(this.remixTotalSlots / this.remixSlotsPerPage);
    this.uiState = {
      currentCategory: "DB",
      currentPage: 0,
      pageByCategory: { DB: 0, FD: 0, NR: 0 },
      activeFilterTab: "remix",
      foldersNeedRefresh: false,
      foldersRefreshMode: "AUTO",
      autoDataLoaded: false,
      dataPaths: {
        importDb: { mode: "AUTO", manualDirectory: "" },
        importJson: { mode: "AUTO", manualDirectory: "" },
        updateDb: { mode: "AUTO", manualDirectory: "" },
        exportDb: { mode: "AUTO", manualDirectory: "" },
        download: { mode: "AUTO", manualDirectory: "" }
      },
      appDirectory: "",
      operationInProgress: false,
      fileStatusBackup: "",
      selectedLabels: store.getLabelSelection(),
      selectedSelectors: store.getSelectorSelection(),
      heardRange: { min: null, max: null },
      sortMode: "release_desc",
      durationRange: { min: null, max: null },
      statusTimeout: null,
      pendingStatusMessage: "",
      loadRetryTimer: null,
      updateDbLinks: new Set(),
      filterPresets: [],
      activeFilterPreset: "__none__",
      storedFilterPreset: "__none__",
      storedFilterPresetApplied: false,
      skipFolderFiltering: true,
      lastSkipFolderFiltering: false,
      showAlbumId: false,
      activeCollection: "__all__",
      activeOptionsTab: "operations",
      operationsScope: "folders",
      showFavorites: true,
      showFavoriteCorners: true,
      cdBackGlobalEnabled: true,
      showRatings: this.readStoredRatingState(),
      autoFilterFolder: false,
      remixEnabled: false,
      remixSlots: this.createEmptyRemixSlots(),
      remixPage: 1,
      remixPagesEnabled: this.createRemixPagesEnabled(),
      remixList: [],
      remixSearchTerm: "",
      remixLocked: new Map(),
      storedSelections: this.readStoredSelections(),
      storedSelectionsApplied: false,
      keyModifiers: {
        favorite: false,
        copy: false,
        delete: false,
        lock: false,
        picture: false,
        edit: false
      },
      ratingKey: null,
      formatOptions: [],
      formatLookup: { byCode: new Map(), byLabel: new Map() }
    };
    const storedRemix = this.readStoredRemixState();
    if (storedRemix) {
      this.uiState.remixEnabled = storedRemix.enabled;
      this.uiState.remixSlots = storedRemix.slots;
      this.uiState.remixPagesEnabled = storedRemix.pages;
    }
    this.dom = {};
    this.renderScheduled = false;
    this.progressInterval = null;
    this.progressValue = 0;
  }

  init() {
    this.cacheDom();
    this.uiState.storedFilterPreset = this.readStoredFilterPreset();
    this.buildFilterPanel();
    this.setRatingVisibility(this.uiState.showRatings);
    this.buildOptionsPanel();
    this.updateAllDataDirectoryHints();
    this.bootstrapDataPaths();
    this.loadFilterPresets();
    this.attachEvents();
    this.clearFileStatus();
    this.loadInitialData();
  }

  createEmptyRemixSlots() {
    return Array.from({ length: this.remixTotalSlots }, () => ({
      folder: "",
      percent: 100,
      mode: "percent",
      count: null,
      enabled: true
    }));
  }

  createRemixPagesEnabled() {
    return Array.from({ length: this.remixPageCount }, () => true);
  }

  normalizeRemixPages(rawPages) {
    return Array.from({ length: this.remixPageCount }, (_, index) => rawPages?.[index] !== false);
  }

  getRemixSlotIndex(pageIndex) {
    return (this.uiState.remixPage - 1) * this.remixSlotsPerPage + pageIndex;
  }

  getRemixPageForSlotIndex(index) {
    return Math.floor(index / this.remixSlotsPerPage) + 1;
  }

  isRemixPageEnabled(page) {
    return this.uiState.remixPagesEnabled?.[page - 1] !== false;
  }

  isRemixSlotPageEnabled(index) {
    return this.isRemixPageEnabled(this.getRemixPageForSlotIndex(index));
  }

  toggleRemixPageEnabled(page) {
    const pageIndex = page - 1;
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= this.remixPageCount) return;
    const next = !this.isRemixPageEnabled(page);
    this.uiState.remixPagesEnabled[pageIndex] = next;
    this.updateRemixPageButtons();
    if (this.uiState.remixEnabled) {
      this.resetCurrentPage();
      this.processAndRender();
    }
  }

  setRemixPage(nextPage) {
    const parsed = Number(nextPage);
    const clamped = Number.isFinite(parsed)
      ? Math.max(1, Math.min(this.remixPageCount, Math.round(parsed)))
      : 1;
    if (this.uiState.remixPage === clamped) return;
    this.uiState.remixPage = clamped;
    this.updateRemixPageButtons();
    this.refreshRemixSlotDisplays();
  }

  updateRemixPageButtons() {
    const pagesWrap = this.dom.remixPages;
    if (!pagesWrap) return;
    const buttons = Array.from(pagesWrap.querySelectorAll(".remix-page-btn"));
    buttons.forEach((button) => {
      const page = Number(button.dataset.remixPage || 0);
      if (page === this.uiState.remixPage) {
        button.classList.add("active");
      } else {
        button.classList.remove("active");
      }
      const dot = button.querySelector(".menu-chip__dot");
      if (dot) {
        dot.classList.toggle("active", this.isRemixPageEnabled(page));
      }
    });
  }

  cacheDom() {
    this.dom = {
      albumsContainer: document.getElementById("albumsContainer"),
      updateBtn: document.getElementById("updateBtn"),
      folderSelect: document.getElementById("folderSelect"),
      containerSelect: document.getElementById("containerSelect"),
      releaseYearFrom: null,
      releaseMonthFrom: null,
      releaseYearTo: null,
      releaseMonthTo: null,
      releaseYearFromControl: null,
      releaseYearToControl: null,
      searchInput: null,
      filterBtn: document.getElementById("filterBtn"),
      filterBtnDot: document.querySelector("#filterBtn .menu-chip__dot"),
      filterClearBtn: document.getElementById("filterClearBtn"),
      optionsBtn: document.getElementById("optionsBtn"),
      filterPanel: document.getElementById("filter-panel"),
      optionsPanel: document.getElementById("options-panel"),
      collectionSelect: document.getElementById("collectionSelect"),
      addEntityBtn: document.getElementById("addEntityBtn"),
      editEntityBtn: document.getElementById("editEntityBtn"),
      deleteEntityBtn: document.getElementById("deleteEntityBtn"),
      operationsScopeInputs: {},
      foldersRefreshBtn: document.getElementById("foldersRefreshBtn"),
      appRefreshBtn: document.getElementById("appRefreshBtn"),
      foldersRefreshModeInput: null,
      foldersRefreshModeLabels: null,
      fileStatus: document.getElementById("fileStatus"),
      navItems: Array.from(document.querySelectorAll(".nav-item")),
      pageInfo: document.getElementById("pageInfo"),
      countDB: document.getElementById("countDB"),
      newCounter: document.getElementById("newCounter"),
      originalCounter: document.getElementById("originalCounter"),
      copyCounter: document.getElementById("copyCounter"),
      progressContainer: document.getElementById("progressContainer"),
      progressFill: document.querySelector(".progress-fill"),
      progressLabel: document.getElementById("progressLabel"),
      pagination: document.querySelector(".pagination"),
      dataModeToggle: null,
      dataModeLabels: null,
      dataDirectoryHint: null,
      downloadDbBtn: null,
      downloadTxtBtn: null,
      importDbBtn: null,
      importJsonBtn: null,
      qobuzScrapeBtn: null,
      exportDbBtn: null,
      updateDbBtn: null,
      heardMinDisplay: null,
      heardMinLeftBtn: null,
      heardMinRightBtn: null,
      heardMaxDisplay: null,
      heardMaxLeftBtn: null,
      heardMaxRightBtn: null,
      sortDurationAscBtn: null,
      sortDurationDescBtn: null,
      sortReleaseAscBtn: null,
      sortReleaseDescBtn: null,
      durationRangeMinInput: null,
      durationRangeMaxInput: null,
      filterPresetSelect: null,
      filterPresetSaveBtn: null,
      filterPresetEditBtn: null,
      filterPresetDeleteBtn: null,
      filterPresetCopyBtn: null,
      skipFolderFilteringInput: null,
      skipFolderFilteringLabels: null,
      showFavoritesInput: null,
      showFavoriteCornersInput: null,
      showFavoriteCornersLabels: null,
      autoFilterFolderInput: null,
      autoFilterFolderLabels: null,
      ratingToggleInput: null,
      ratingToggleLabels: null,
      remixToggleInput: null,
      remixToggleLabels: null,
      remixSearchInput: null,
      remixSearchSuggestions: null,
      remixSlots: [],
      remixPages: null,
      remixTabButton: null,
      remixTabDot: null,
      filterTabButtons: [],
      filterTabControls: [],
      filterTabsBar: null,
      searchSuggestions: null,
      dataModeToggles: {},
      dataModeLabels: {},
      dataDirectoryHints: {}
    };
  }

  attachEvents() {
    const {
      updateBtn,
      folderSelect,
      containerSelect,
      filterBtn,
      filterClearBtn,
      optionsBtn,
      filterPanel,
      optionsPanel,
      collectionSelect,
      addEntityBtn,
      editEntityBtn,
      deleteEntityBtn,
      foldersRefreshBtn,
      appRefreshBtn,
      foldersRefreshModeInput,
      foldersRefreshModeLabels,
      downloadDbBtn,
      downloadTxtBtn,
      importDbBtn,
      importJsonBtn,
      qobuzScrapeBtn,
      updateDbBtn,
      exportDbBtn,
      searchInput,
      navItems,
      pagination
    } = this.dom;

    updateBtn?.addEventListener("click", () => this.handleSave());
    appRefreshBtn?.addEventListener("click", () => {
      window.location.reload();
    });
    downloadDbBtn?.addEventListener("click", () => this.exportFilteredSelection());
    downloadTxtBtn?.addEventListener("click", () => this.exportFilteredLinks());

    folderSelect?.addEventListener("change", () => {
      this.markFoldersPending();
      this.processAndRender();
    });
    containerSelect?.addEventListener("change", () => {
      this.rebuildFolderSelect();
      this.markFoldersPending();
      this.processAndRender();
    });

    searchInput?.addEventListener("input", () => {
      this.resetCurrentPage();
      this.processAndRender();
      this.updateSearchSuggestions();
    });

    filterBtn?.addEventListener("click", () => this.toggleFilterPanel());
    filterClearBtn?.addEventListener("click", () => this.clearAllFilters());
    optionsBtn?.addEventListener("click", () => this.toggleOptionsPanel());

    collectionSelect?.addEventListener("change", () => {
      this.handleCollectionChange(collectionSelect.value);
    });
    addEntityBtn?.addEventListener("click", () => {
      this.flashOptionButton(addEntityBtn);
      this.handleEntityAction("add");
    });
    editEntityBtn?.addEventListener("click", () => {
      this.flashOptionButton(editEntityBtn);
      this.handleEntityAction("edit");
    });
    deleteEntityBtn?.addEventListener("click", () => {
      this.flashOptionButton(deleteEntityBtn);
      this.handleEntityAction("delete");
    });

    importDbBtn?.addEventListener("click", () => {
      this.flashOptionButton(importDbBtn);
      this.importFromXlsx();
    });

    importJsonBtn?.addEventListener("click", () => {
      this.flashOptionButton(importJsonBtn);
      this.importFromJson();
    });

    qobuzScrapeBtn?.addEventListener("click", () => {
      this.flashOptionButton(qobuzScrapeBtn);
      this.runQobuzScrape();
    });

    exportDbBtn?.addEventListener("click", () => {
      this.flashOptionButton(exportDbBtn);
      this.exportToXlsx();
    });

    updateDbBtn?.addEventListener("click", () => {
      this.flashOptionButton(updateDbBtn);
      this.importNewsFromXlsx();
    });

    Object.entries(this.dom.dataModeToggles || {}).forEach(([operationKey, input]) => {
      input?.addEventListener("change", () => this.handleDataModeToggle(operationKey));
    });

    Object.values(this.dom.operationsScopeInputs || {}).forEach((input) => {
      input?.addEventListener("change", () => this.handleOperationsScopeChange(input.value));
    });
    foldersRefreshBtn?.addEventListener("click", async () => {
      await this.refreshFoldersView();
    });

    pagination?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-page]");
      if (!button || button.disabled) return;
      const destination = button.dataset.page;
      const totalPages = Number(this.dom.pagination?.dataset.totalpages || 0);
      if (destination === "first") {
        this.setCurrentPage(0);
        this.renderAlbumsPage();
      } else if (destination === "prev") {
        if (this.uiState.currentPage > 0) {
          this.setCurrentPage(this.uiState.currentPage - 1);
          this.renderAlbumsPage();
        }
      } else if (destination === "next") {
        this.setCurrentPage(this.uiState.currentPage + 1);
        this.renderAlbumsPage();
      } else if (destination === "last" && totalPages > 0) {
        this.setCurrentPage(totalPages - 1);
        this.renderAlbumsPage();
      }
    });

    pagination?.addEventListener("change", (event) => {
      const select = event.target.closest(".pagination__pages");
      if (!select) return;
      const pageNumber = parseInt(select.value, 10);
      if (!Number.isNaN(pageNumber)) {
        this.setCurrentPage(pageNumber);
        this.renderAlbumsPage();
      }
    });

    navItems?.forEach((item) => {
      item.addEventListener("click", () => {
        const cat = item.dataset.page || "DB";
        this.renderCategory(cat);
      });
    });

    const shouldIgnoreKeyEvent = (event) => {
      const target = event.target;
      if (!target) return false;
      const tag = target.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        target.isContentEditable ||
        target.closest?.(".modal-card")
      );
    };

    document.addEventListener("keydown", (event) => {
      if (shouldIgnoreKeyEvent(event)) return;
      if (event.key.toLowerCase() !== "r") return;
      if (!this.uiState.remixEnabled) {
        this.showRemixStatus("Aby losowo rozmieścić albumy aktywuj funkcję REMIX.", "warning");
        return;
      }
      this.uiState.remixList = this.buildRemixList();
      this.resetCurrentPage();
      this.renderAlbumsPage();
      this.showRemixStatus("Przeładowano losowe ułożenie albumów.", "on");
    });

    document.addEventListener("keydown", (event) => {
      if (shouldIgnoreKeyEvent(event)) return;
      if (event.key.toLowerCase() !== "q") return;
      this.setRatingVisibility(!this.uiState.showRatings);
    });

    document.addEventListener("keydown", (event) => {
      if (shouldIgnoreKeyEvent(event)) return;
      if (!/^[1-5]$/.test(event.key)) return;
      this.uiState.ratingKey = Number(event.key);
    });

    document.addEventListener("keydown", (event) => {
      if (shouldIgnoreKeyEvent(event)) return;
      const key = event.key.toLowerCase();
      if (key === "f") {
        this.uiState.keyModifiers.favorite = true;
      } else if (key === "c") {
        this.uiState.keyModifiers.copy = true;
      } else if (key === "d") {
        this.uiState.keyModifiers.delete = true;
      } else if (key === "alt") {
        this.uiState.keyModifiers.edit = true;
      } else if (key === "b") {
        this.uiState.keyModifiers.lock = true;
      } else if (key === "o") {
        this.uiState.keyModifiers.picture = true;
      }
    });

    document.addEventListener("keyup", (event) => {
      if (/^[1-5]$/.test(event.key)) {
        const value = Number(event.key);
        if (this.uiState.ratingKey === value) {
          this.uiState.ratingKey = null;
        }
      }
      const key = event.key.toLowerCase();
      if (key === "f") {
        this.uiState.keyModifiers.favorite = false;
      } else if (key === "c") {
        this.uiState.keyModifiers.copy = false;
      } else if (key === "d") {
        this.uiState.keyModifiers.delete = false;
      } else if (key === "alt") {
        this.uiState.keyModifiers.edit = false;
      } else if (key === "b") {
        this.uiState.keyModifiers.lock = false;
      } else if (key === "o") {
        this.uiState.keyModifiers.picture = false;
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key.toLowerCase() !== "i") return;
      if (this.uiState.showAlbumId) return;
      this.uiState.showAlbumId = true;
      document.body.classList.add("show-album-id");
    });

    document.addEventListener("keyup", (event) => {
      if (event.key.toLowerCase() !== "i") return;
      this.uiState.showAlbumId = false;
      document.body.classList.remove("show-album-id");
    });

    if (window.electronAPI?.onAppCloseRequest) {
      window.electronAPI.onAppCloseRequest(() => {
        this.handleAppCloseRequest();
      });
    }
  }

  toggleFilterPanel() {
    const { filterPanel } = this.dom;
    if (!filterPanel) return;
    if (filterPanel.style.display === "flex") return;
    filterPanel.style.visibility = "hidden";
    filterPanel.style.display = "flex";
    this.syncFilterPanelWidth();
    this.syncFilterTabWidths();
    filterPanel.style.visibility = "";
  }

  hideFilterPanel() {
    const { filterPanel } = this.dom;
    if (filterPanel) filterPanel.style.display = "none";
  }

  syncFilterPanelWidth() {
    const { filterPanel } = this.dom;
    if (!filterPanel || !this.activateFilterTab) return;
    const previousTab = this.uiState.activeFilterTab;
    this.activateFilterTab("label");
    const width = Math.ceil(filterPanel.getBoundingClientRect().width);
    if (width) {
      filterPanel.style.width = `${width}px`;
    }
    this.activateFilterTab(previousTab);
  }

  syncFilterTabWidths() {
  const buttons = this.dom.filterTabButtons || [];
  if (!buttons.length) return;

  const tabsBar = this.dom.filterTabsBar;

  // W panelu FILTR mamy CSS grid (5 kolumn), więc NIE ustawiamy szerokości na sztywno,
  // bo to wypycha elementy poza panel i potem overflow:hidden je ucina.
  if (tabsBar?.classList?.contains("filter-tabs--filters")) {
    [...buttons, ...(this.dom.filterTabControls || [])].forEach((el) => {
      if (!el) return;
      el.style.width = "";
      el.style.minWidth = "";
    });
    return;
  }

  const widths = buttons.map((btn) => Math.ceil(btn.getBoundingClientRect().width || 0));
  const maxWidth = Math.max(...widths);
  if (!maxWidth) return;

  [...buttons, ...(this.dom.filterTabControls || [])].forEach((el) => {
    if (!el) return;
    el.style.width = `${maxWidth}px`;
    el.style.minWidth = `${maxWidth}px`;
  });

  const remixPages = this.dom.remixPages;
  if (tabsBar && remixPages) {
    const barWidth = Math.ceil(tabsBar.getBoundingClientRect().width || 0);
    if (barWidth) {
      remixPages.style.width = `${Math.round(barWidth * 0.8)}px`;
    }
  }
}

  toggleOptionsPanel() {
    const { optionsPanel } = this.dom;
    if (!optionsPanel) return;
    if (optionsPanel.style.display === "block") return;
    optionsPanel.style.display = "block";
  }

  hideOptionsPanel() {
    const { optionsPanel } = this.dom;
    if (optionsPanel) optionsPanel.style.display = "none";
  }

  activateOptionsTab(tabId) {
    const { optionsTabSections, optionsTabsBar } = this.dom;
    if (!optionsTabSections) return;
    const target = optionsTabSections.has(tabId) ? tabId : "operations";
    this.uiState.activeOptionsTab = target;
    optionsTabSections.forEach((section, key) => {
      section.hidden = key !== target;
    });
    optionsTabsBar?.querySelectorAll(".filter-tab__btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === target);
    });
  }

  flashOptionButton(button) {
    if (!button) return;
    button.classList.add("active");
    setTimeout(() => button.classList.remove("active"), 260);
  }

  setCurrentPage(page) {
    const nextPage = Number.isInteger(page) && page >= 0 ? page : 0;
    this.uiState.currentPage = nextPage;
    if (!this.uiState.pageByCategory) {
      this.uiState.pageByCategory = {};
    }
    this.uiState.pageByCategory[this.uiState.currentCategory] = nextPage;
  }

  resetCurrentPage() {
    this.setCurrentPage(0);
  }

  getStoredPage(category) {
    if (!this.uiState.pageByCategory) return 0;
    return this.uiState.pageByCategory[category] ?? 0;
  }

  buildFilterPanel() {
    const { filterPanel } = this.dom;
    if (!filterPanel) return;

    if (!this.uiState.selectedLabels.size) {
      this.uiState.selectedLabels = this.store.getLabelSelection();
    }
    if (!this.uiState.selectedSelectors.size) {
      this.uiState.selectedSelectors = this.store.getSelectorSelection();
    }

    filterPanel.innerHTML = "";
    this.dom.filterTabButtons = [];
    this.dom.filterTabControls = [];

    const header = document.createElement("div");
    header.className = "filter-panel__header";

    const togglesWrap = document.createElement("div");
    togglesWrap.className = "filter-panel__toggles";

    const remixToggleWrap = document.createElement("div");
    remixToggleWrap.className = "filter-header-toggle filter-header-toggle--remix";
    const remixToggleLabel = document.createElement("span");
    remixToggleLabel.className = "filter-header-toggle__label";
    remixToggleLabel.textContent = "REMIX";
    const remixSwitch = this.createSwitch({
      id: "remixModeToggle",
      leftLabel: "OFF",
      rightLabel: "ON",
      defaultRight: this.uiState.remixEnabled,
      compact: true
    });
    this.dom.remixToggleInput = remixSwitch.input;
    this.dom.remixToggleLabels = { left: remixSwitch.leftLabel, right: remixSwitch.rightLabel };
    this.updateSwitchLabels(remixSwitch.input, remixSwitch.leftLabel, remixSwitch.rightLabel);
    remixSwitch.input.addEventListener("change", () => {
      this.setRemixEnabled(remixSwitch.input.checked);
    });
    remixToggleWrap.appendChild(remixToggleLabel);
    remixToggleWrap.appendChild(remixSwitch.wrapper);

    const autoFilterWrap = document.createElement("div");
    autoFilterWrap.className = "filter-header-toggle";
    const autoFilterLabel = document.createElement("span");
    autoFilterLabel.className = "filter-header-toggle__label";
    autoFilterLabel.textContent = "AUTO FOLDER SAVE FILTR";
    const autoFilterSwitch = this.createSwitch({
      id: "autoFilterFolderToggle",
      leftLabel: "OFF",
      rightLabel: "ON",
      defaultRight: this.uiState.autoFilterFolder,
      compact: true
    });
    this.dom.autoFilterFolderInput = autoFilterSwitch.input;
    this.dom.autoFilterFolderLabels = {
      left: autoFilterSwitch.leftLabel,
      right: autoFilterSwitch.rightLabel
    };
    this.updateSwitchLabels(
      autoFilterSwitch.input,
      autoFilterSwitch.leftLabel,
      autoFilterSwitch.rightLabel
    );
    autoFilterSwitch.input.addEventListener("change", () => {
      this.uiState.autoFilterFolder = autoFilterSwitch.input.checked;
      this.updateSwitchLabels(
        autoFilterSwitch.input,
        autoFilterSwitch.leftLabel,
        autoFilterSwitch.rightLabel
      );
    });
    autoFilterWrap.appendChild(autoFilterLabel);
    autoFilterWrap.appendChild(autoFilterSwitch.wrapper);

    togglesWrap.appendChild(remixToggleWrap);
    togglesWrap.appendChild(autoFilterWrap);

    const ratingWrap = document.createElement("div");
    ratingWrap.className = "filter-header-toggle";
    const ratingLabel = document.createElement("span");
    ratingLabel.className = "filter-header-toggle__label";
    ratingLabel.textContent = "RATING";
    const ratingSwitch = this.createSwitch({
      id: "ratingToggle",
      leftLabel: "OFF",
      rightLabel: "ON",
      defaultRight: this.uiState.showRatings,
      compact: true
    });
    this.dom.ratingToggleInput = ratingSwitch.input;
    this.dom.ratingToggleLabels = {
      left: ratingSwitch.leftLabel,
      right: ratingSwitch.rightLabel
    };
    this.updateSwitchLabels(ratingSwitch.input, ratingSwitch.leftLabel, ratingSwitch.rightLabel);
    ratingSwitch.input.addEventListener("change", () => {
      this.setRatingVisibility(ratingSwitch.input.checked);
    });
    ratingWrap.appendChild(ratingLabel);
    ratingWrap.appendChild(ratingSwitch.wrapper);

    togglesWrap.appendChild(ratingWrap);

    const closeBtn = document.createElement("button");
    closeBtn.className = "filter-panel__close";
    closeBtn.setAttribute("aria-label", "Zamknij panel filtrów");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => this.hideFilterPanel());

    const actions = document.createElement("div");
    actions.className = "filter-panel__actions";
    actions.appendChild(closeBtn);

    header.appendChild(togglesWrap);
    header.appendChild(actions);

    const tabsBar = document.createElement("div");
    tabsBar.className = "filter-tabs filter-tabs--filters";
    this.dom.filterTabsBar = tabsBar;

    const tabsContent = document.createElement("div");
    tabsContent.className = "filter-tabs__content";

    const tabs = [
      { id: "remix", label: "REMIX", builder: () => this.createRemixSection() },
      { id: "label", label: "LABELS", builder: () => this.createLabelsSection() },
      { id: "selector", label: "SELECTOR", builder: () => this.createSelectorSection() },
      { id: "search", label: "SEARCH & DATA", builder: () => this.createSearchSection() },
      { id: "time", label: "TIME", builder: () => this.createTimeSection() }
    ];

    const presetsRow = document.createElement("div");
    presetsRow.className = "filter-tabs__row";
    const presetSaveBtn = document.createElement("button");
    presetSaveBtn.type = "button";
    presetSaveBtn.className = "filter-presets__save";
    presetSaveBtn.textContent = "SAVE FILTR";
    presetSaveBtn.addEventListener("click", () => this.handleSaveFilterPreset());
    const presetSelect = document.createElement("select");
    presetSelect.className = "filter-presets__select";
    presetSelect.addEventListener("change", (event) => this.handlePresetSelectionChange(event));
    const presetEditBtn = document.createElement("button");
    presetEditBtn.type = "button";
    presetEditBtn.className = "filter-presets__edit";
    presetEditBtn.textContent = "EDIT FILTR";
    presetEditBtn.addEventListener("click", () => this.handlePresetRename());
    const presetDeleteBtn = document.createElement("button");
    presetDeleteBtn.type = "button";
    presetDeleteBtn.className = "filter-presets__delete";
    presetDeleteBtn.textContent = "DELETE FILTR";
    presetDeleteBtn.addEventListener("click", () => this.handlePresetDelete());

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "filter-presets__copy";
    copyBtn.textContent = "COPY FILTR";
    copyBtn.addEventListener("click", () => this.handleCopyFilterPreset());

    const sections = new Map();
    const indicators = new Map();

    this.activateFilterTab = (id) => {
      this.uiState.activeFilterTab = id;
      tabsBar.querySelectorAll(".filter-tab__btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.tab === id);
      });
      sections.forEach((section, key) => {
        if (section) section.hidden = key !== id;
      });
    };

    tabs.forEach((tab) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "filter-tab__btn";
      const label = document.createElement("span");
      label.className = "filter-tab__label";
      label.textContent = tab.label;
      const dot = document.createElement("span");
      dot.className = "filter-tab__dot";
      label.appendChild(dot);
      btn.appendChild(label);
      btn.dataset.tab = tab.id;
      btn.addEventListener("click", () => this.activateFilterTab(tab.id));
      tabsBar.appendChild(btn);
      this.dom.filterTabButtons.push(btn);
      if (tab.id === "remix") {
        this.dom.remixTabButton = btn;
        this.dom.remixTabDot = dot;
      }

      const section = tab.builder();
      section.classList.add("filter-tab__panel");
      section.hidden = true;
      section.dataset.tab = tab.id;
      tabsContent.appendChild(section);
      sections.set(tab.id, section);
      indicators.set(tab.id, dot);
    });

    presetsRow.appendChild(presetSelect);
    presetsRow.appendChild(presetSaveBtn);
    presetsRow.appendChild(presetEditBtn);
    presetsRow.appendChild(presetDeleteBtn);
    presetsRow.appendChild(copyBtn);

    presetsRow.querySelectorAll("button, select").forEach((el) => {
      this.dom.filterTabControls.push(el);
    });
    tabsBar.appendChild(presetsRow);

    this.dom.filterTabsContent = tabsContent;
    this.dom.filterTabIndicators = indicators;
    this.dom.filterPresetSelect = presetSelect;
    this.dom.filterPresetSaveBtn = presetSaveBtn;
    this.dom.filterPresetEditBtn = presetEditBtn;
    this.dom.filterPresetDeleteBtn = presetDeleteBtn;
    this.dom.filterPresetCopyBtn = copyBtn;

    filterPanel.appendChild(header);
    filterPanel.appendChild(tabsBar);
    filterPanel.appendChild(tabsContent);

    this.updateHeardRangeDisplay();
    this.updateTimeSortButtons();
    this.updateFilterPresetOptions();
    this.activateFilterTab(this.uiState.activeFilterTab);
    this.updateRemixModeUi();
    this.updateFilterTabIndicators();
    requestAnimationFrame(() => this.syncFilterTabWidths());
  }

  buildOptionsPanel() {
    const { optionsPanel } = this.dom;
    if (!optionsPanel) return;

    optionsPanel.innerHTML = "";
    this.dom.dataModeToggles = {};
    this.dom.dataModeLabels = {};
    this.dom.dataDirectoryHints = {};

    const header = document.createElement("div");
    header.className = "filter-panel__header";

    const spacer = document.createElement("div");

    const actions = document.createElement("div");
    actions.className = "filter-panel__actions";
    const backupBtn = document.createElement("button");
    backupBtn.type = "button";
    backupBtn.className = "filter-backup-btn";
    backupBtn.textContent = "BACKUP DB";
    backupBtn.addEventListener("click", () => this.handleDatabaseBackup());
    const checkBtn = document.createElement("button");
    checkBtn.type = "button";
    checkBtn.className = "filter-backup-btn";
    checkBtn.textContent = "SPRAWDŹ DANE";
    checkBtn.addEventListener("click", () => this.handleDatabaseCheck());
    const closeBtn = document.createElement("button");
    closeBtn.className = "filter-panel__close";
    closeBtn.setAttribute("aria-label", "Zamknij panel opcji");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => this.hideOptionsPanel());
    actions.appendChild(backupBtn);
    actions.appendChild(checkBtn);
    actions.appendChild(closeBtn);

    header.appendChild(spacer);
    header.appendChild(actions);

    const tabsBar = document.createElement("div");
    tabsBar.className = "filter-tabs";
    const tabsContent = document.createElement("div");
    tabsContent.className = "filter-tabs__content";
    const sections = new Map();

    const tabs = [
      { id: "paths", label: "PATHS", builder: () => this.createPathsSection() },
      { id: "operations", label: "OPERATIONS", builder: () => this.createOperationsSection() },
      { id: "info", label: "INFO", builder: () => this.createInfoSection() }
    ];

    tabs.forEach((tab) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "filter-tab__btn";
      btn.dataset.tab = tab.id;
      btn.textContent = tab.label;
      btn.addEventListener("click", () => this.activateOptionsTab(tab.id));
      tabsBar.appendChild(btn);

      const section = tab.builder();
      section.classList.add("filter-tab__panel");
      section.hidden = true;
      tabsContent.appendChild(section);
      sections.set(tab.id, section);
    });

    this.dom.optionsTabSections = sections;
    this.dom.optionsTabsBar = tabsBar;

    optionsPanel.appendChild(header);
    optionsPanel.appendChild(tabsBar);
    optionsPanel.appendChild(tabsContent);

    this.activateOptionsTab(this.uiState.activeOptionsTab);
  }

  createRemixSection() {
    const remixSection = document.createElement("div");
    remixSection.className = "filter-section remix-section";
    const pageButtons = document.createElement("div");
    pageButtons.className = "remix-pages";
    for (let i = 1; i <= this.remixPageCount; i += 1) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "menu-chip pagination__btn remix-page-btn";
      btn.dataset.remixPage = String(i);
      const span = document.createElement("span");
      span.className = "menu-chip__inner";
      span.textContent = String(i);
      const dot = document.createElement("span");
      dot.className = "menu-chip__dot";
      dot.classList.toggle("active", this.isRemixPageEnabled(i));
      span.appendChild(dot);
      btn.appendChild(span);
      btn.addEventListener("click", (event) => {
        if (event.ctrlKey) {
          event.preventDefault();
          this.toggleRemixPageEnabled(i);
          return;
        }
        this.setRemixPage(i);
      });
      pageButtons.appendChild(btn);
    }
    this.dom.remixPages = pageButtons;
    remixSection.appendChild(pageButtons);

    const searchRow = document.createElement("div");
    searchRow.className = "remix-search__row";
    const searchWrap = document.createElement("div");
    searchWrap.className = "remix-search";
    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.placeholder = "Szukaj folderu";
    searchInput.title = "Szukaj folderu";
    searchWrap.appendChild(searchInput);
    const searchSuggestions = document.createElement("ul");
    searchSuggestions.className = "search-suggestions search-suggestions--remix";
    searchSuggestions.hidden = true;
    searchWrap.appendChild(searchSuggestions);
    searchRow.appendChild(searchWrap);
    const remixActions = this.createActionsRow([
      {
        label: "CLEAR",
        handler: () => this.clearRemixSlots()
      }
    ]);
    remixActions.classList.add("filter-actions--inline", "remix-search__actions");
    searchRow.appendChild(remixActions);
    remixSection.appendChild(searchRow);

    this.dom.remixSearchInput = searchInput;
    this.dom.remixSearchSuggestions = searchSuggestions;
    searchInput.addEventListener("input", () => {
      this.uiState.remixSearchTerm = searchInput.value;
      this.updateRemixSearchSuggestions();
    });
    searchInput.addEventListener("blur", () => {
      this.deferHideSuggestions(searchSuggestions);
    });

    const slotsWrap = document.createElement("div");
    slotsWrap.className = "remix-slots";

    this.dom.remixSlots = [];
    for (let index = 0; index < this.remixSlotsPerPage; index += 1) {
      const row = document.createElement("div");
      row.className = "remix-slot";

      const info = document.createElement("div");
      info.className = "remix-slot__info";
      const label = document.createElement("div");
      label.className = "remix-slot__label";
      label.textContent = `FOLDER ${index + 1}`;
      const value = document.createElement("div");
      value.className = "remix-slot__value";
      info.appendChild(label);
      info.appendChild(value);

      const percentControl = document.createElement("div");
      percentControl.className = "remix-percent";
      const percentLeft = document.createElement("button");
      percentLeft.type = "button";
      percentLeft.className = "menu-chip pagination__btn filter-arrow-btn";
      const percentLeftInner = document.createElement("span");
      percentLeftInner.className = "menu-chip__inner";
      percentLeftInner.textContent = "<<";
      percentLeft.appendChild(percentLeftInner);
      const percentValueWrap = document.createElement("div");
      percentValueWrap.className = "remix-percent__value";
      const percentValue = document.createElement("input");
      percentValue.type = "text";
      percentValue.className = "remix-percent__input";
      percentValueWrap.appendChild(percentValue);
      const percentRight = document.createElement("button");
      percentRight.type = "button";
      percentRight.className = "menu-chip pagination__btn filter-arrow-btn";
      const percentRightInner = document.createElement("span");
      percentRightInner.className = "menu-chip__inner";
      percentRightInner.textContent = ">>";
      percentRight.appendChild(percentRightInner);
      percentLeft.addEventListener("click", () => {
        if (percentLeft.dataset.suppressClick === "true") {
          percentLeft.dataset.suppressClick = "";
          return;
        }
        this.shiftRemixValue(this.getRemixSlotIndex(index), -1);
      });
      percentRight.addEventListener("click", () => {
        if (percentRight.dataset.suppressClick === "true") {
          percentRight.dataset.suppressClick = "";
          return;
        }
        this.shiftRemixValue(this.getRemixSlotIndex(index), 1);
      });
      this.attachHoldAction(percentLeft, () => this.shiftRemixValue(this.getRemixSlotIndex(index), -1));
      this.attachHoldAction(percentRight, () => this.shiftRemixValue(this.getRemixSlotIndex(index), 1));
      percentValue.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        this.applyRemixValueInput(this.getRemixSlotIndex(index), percentValue.value);
      });
      percentValue.addEventListener("blur", () => {
        this.refreshRemixSlotDisplays();
      });
      percentValue.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.toggleRemixSlotMode(this.getRemixSlotIndex(index));
      });
      percentControl.appendChild(percentLeft);
      percentControl.appendChild(percentValueWrap);
      percentControl.appendChild(percentRight);

      const assignBtn = document.createElement("button");
      assignBtn.type = "button";
      assignBtn.className = "remix-slot__assign";
      assignBtn.textContent = "PRZYPISZ";
      assignBtn.addEventListener("click", () => this.assignRemixFolder(this.getRemixSlotIndex(index)));
      const unassignBtn = document.createElement("button");
      unassignBtn.type = "button";
      unassignBtn.className = "remix-slot__unassign";
      unassignBtn.textContent = "ODPISZ";
      unassignBtn.addEventListener("click", () => this.unassignRemixFolder(this.getRemixSlotIndex(index)));

      const remixToggle = this.createSwitch({
        leftLabel: "",
        rightLabel: "",
        defaultRight: true,
        compact: true
      });
      remixToggle.wrapper.classList.add("toggle-wrapper--iconless", "remix-slot__toggle");
      remixToggle.input.addEventListener("change", () => {
        this.toggleRemixSlotEnabled(this.getRemixSlotIndex(index), remixToggle.input.checked);
      });

      const actionsWrap = document.createElement("div");
      actionsWrap.className = "remix-slot__actions";
      actionsWrap.appendChild(assignBtn);
      actionsWrap.appendChild(unassignBtn);
      actionsWrap.appendChild(remixToggle.wrapper);

      row.appendChild(info);
      row.appendChild(percentControl);
      row.appendChild(actionsWrap);
      slotsWrap.appendChild(row);

      this.dom.remixSlots.push({ label, value, percentValue, percentValueWrap, toggle: remixToggle.input, row });
    }

    remixSection.appendChild(slotsWrap);
    this.updateRemixPageButtons();
    this.refreshRemixSlotDisplays();
    this.updateRemixSearchSuggestions();
    return remixSection;
  }

  createInfoSection() {
    const infoSection = document.createElement("div");
    infoSection.className = "filter-section options-info-section";
    infoSection.appendChild(this.createSectionTitle("INFO"));

    const infoStack = document.createElement("div");
    infoStack.className = "options-info-stack";

    const newCounter = document.createElement("div");
    newCounter.id = "newCounter";
    newCounter.className = "new-counter";
    newCounter.textContent = "NEW / UPDATE 0";

    const originalCounter = document.createElement("div");
    originalCounter.id = "originalCounter";
    originalCounter.className = "new-counter new-counter--original";
    originalCounter.textContent = "Z 0";

    const copyCounter = document.createElement("div");
    copyCounter.id = "copyCounter";
    copyCounter.className = "new-counter new-counter--copy";
    copyCounter.textContent = "B 0";

    infoStack.appendChild(newCounter);
    infoStack.appendChild(originalCounter);
    infoStack.appendChild(copyCounter);
    infoSection.appendChild(infoStack);

    this.dom.newCounter = newCounter;
    this.dom.originalCounter = originalCounter;
    this.dom.copyCounter = copyCounter;

    const infoTitle = document.createElement("div");
    infoTitle.className = "options-info-title";
    infoTitle.textContent = "Opcje i skróty";
    infoSection.appendChild(infoTitle);

    const shortcuts = [
      "LPM na albumie: otwiera odtwarzacz web dla wybranego albumu.",
      "ALT + LPM na albumie: otwiera okno EDYCJA DANYCH.",
      "O + LPM na albumie: pokazuje podgląd okładki.",
      "O + PPM na albumie: otwiera źródło okładki w przeglądarce.",
      "F + LPM na albumie: dodaje album do ulubionych.",
      "F + PPM na albumie: usuwa album z ulubionych.",
      "C + LPM na albumie: kopiuje dane albumu do schowka.",
      "D + LPM na albumie: usuwa album.",
      "B + LPM na albumie (REMIX): blokuje album w folderze remix.",
      "B + PPM na albumie (REMIX): odblokowuje album w folderze remix.",
      "CTRL + LPM na albumie: zwiększa licznik HEARD.",
      "CTRL + PPM na albumie: zmniejsza licznik HEARD.",
      "1-5 + LPM na albumie: ustawia ocenę albumu w gwiazdkach.",
      "SHIFT + LPM na albumie: przypisuje album do wybranego folderu.",
      "SHIFT + PPM na albumie: usuwa przypisanie albumu z folderu (lub z folderu REMIX).",
      "Przytrzymanie I na klawiaturze: pokazuje ID albumów.",
      "Q na klawiaturze: włącza/wyłącza widoczność ocen RATING.",
      "R na klawiaturze: losuje ponownie układ albumów w trybie REMIX.",
      "Kliknięcie ikony labela na karcie albumu: zmienia selektor albumu.",
      "CTRL + klik na numer strony REMIX: włącza/wyłącza stronę remix.",
      "IMPORT DB: wczytuje dane z SQLite do aplikacji.",
      "UPDATE DB: zapisuje zmiany do SQLite.",
      "EXPORT DB: eksportuje dane do XLSX.",
      "IMPORT JSON: importuje albumy z JSON.",
      "SAVE XLSX / SAVE TXT: zapisuje dane lub linki do plików.",
      "BACKUP DB: tworzy kopię bazy danych.",
      "SPRAWDŹ DANE: sprawdza kompletność danych i tworzy kontener ERROR z brakami.",
      "ADD / EDIT / DELETE (OPERACJE NA): zarządza FOLDERS, CONTAINERS lub COLLECTIONS.",
      "AUTO / MANUAL w PATHS: ustawia tryb wyboru katalogów dla operacji."
    ];

    const list = document.createElement("ul");
    list.className = "options-info-list";
    shortcuts.forEach((line) => {
      const item = document.createElement("li");
      item.className = "options-info-item";
      item.textContent = line;
      list.appendChild(item);
    });
    infoSection.appendChild(list);

    return infoSection;
  }

  createSearchSection() {
    const searchSection = document.createElement("div");
    searchSection.className = "filter-section";
    searchSection.appendChild(this.createSectionTitle("SEARCH"));

    const searchRow = document.createElement("div");
    searchRow.className = "filter-search__row";

    const searchWrap = document.createElement("div");
    searchWrap.className = "filter-search";
    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.id = "searchInput";
    searchInput.placeholder = "Szukaj albumu lub wykonawcy";
    searchInput.title = "Szukaj";
    searchWrap.appendChild(searchInput);
    const searchSuggestions = document.createElement("ul");
    searchSuggestions.className = "search-suggestions";
    searchSuggestions.hidden = true;
    searchWrap.appendChild(searchSuggestions);

    searchRow.appendChild(searchWrap);
    searchSection.appendChild(searchRow);

    const searchActions = this.createActionsRow([
      {
        label: "CLEAR",
        handler: () => {
          if (searchInput) searchInput.value = "";
          this.hideSuggestions(this.dom.searchSuggestions);
          this.resetCurrentPage();
          this.processAndRender();
        }
      }
    ]);
    searchActions.classList.add("filter-actions--inline", "filter-actions--search");
    searchSection.appendChild(searchActions);

    const searchSpacer = document.createElement("div");
    searchSpacer.className = "filter-search__spacer";
    searchSection.appendChild(searchSpacer);

    searchSection.appendChild(this.createSectionTitle("DATA"));

    const skipFolderRow = document.createElement("div");
    skipFolderRow.className = "filter-toggle-row";
    const skipLabel = document.createElement("div");
    skipLabel.className = "filter-toggle-title";
    skipLabel.textContent = "Pomiń filtrowanie w folderach i kontenerach";
    const skipSwitch = this.createSwitch({
      id: "skipFolderFilteringToggle",
      leftLabel: "OFF",
      rightLabel: "ON",
      defaultRight: this.uiState.skipFolderFiltering,
      compact: true
    });
    this.dom.skipFolderFilteringInput = skipSwitch.input;
    this.dom.skipFolderFilteringLabels = { left: skipSwitch.leftLabel, right: skipSwitch.rightLabel };
    this.updateSwitchLabels(skipSwitch.input, skipSwitch.leftLabel, skipSwitch.rightLabel);
    skipSwitch.input.addEventListener("change", () => {
      this.uiState.skipFolderFiltering = skipSwitch.input.checked;
      this.updateSwitchLabels(skipSwitch.input, skipSwitch.leftLabel, skipSwitch.rightLabel);
      this.processAndRender();
    });
    skipFolderRow.appendChild(skipLabel);
    skipFolderRow.appendChild(skipSwitch.wrapper);
    searchSection.appendChild(skipFolderRow);

    const refreshModeRow = document.createElement("div");
    refreshModeRow.className = "filter-toggle-row";
    const refreshModeLabel = document.createElement("div");
    refreshModeLabel.className = "filter-toggle-title";
    refreshModeLabel.textContent =
      "Automatyczny tryb odświeżania folderów i kontenerów w zakładce FOLDERS";
    const refreshModeSwitch = this.createSwitch({
      leftLabel: "OFF",
      rightLabel: "ON",
      defaultRight: this.uiState.foldersRefreshMode === "AUTO",
      compact: true
    });
    this.dom.foldersRefreshModeInput = refreshModeSwitch.input;
    this.dom.foldersRefreshModeLabels = {
      left: refreshModeSwitch.leftLabel,
      right: refreshModeSwitch.rightLabel
    };
    this.updateSwitchLabels(
      refreshModeSwitch.input,
      refreshModeSwitch.leftLabel,
      refreshModeSwitch.rightLabel
    );
    refreshModeSwitch.input.addEventListener("change", () => {
      this.toggleFoldersRefreshMode(refreshModeSwitch.input.checked);
      this.updateSwitchLabels(
        refreshModeSwitch.input,
        refreshModeSwitch.leftLabel,
        refreshModeSwitch.rightLabel
      );
      this.updateFilterTabIndicators();
    });
    refreshModeRow.appendChild(refreshModeLabel);
    refreshModeRow.appendChild(refreshModeSwitch.wrapper);
    searchSection.appendChild(refreshModeRow);

    const favoriteCornerRow = document.createElement("div");
    favoriteCornerRow.className = "filter-toggle-row";
    const favoriteCornerLabel = document.createElement("div");
    favoriteCornerLabel.className = "filter-toggle-title";
    favoriteCornerLabel.textContent = "Pokaż zaznaczone rogi albumów dodanych do ulubionych";
    const favoriteCornerSwitch = this.createSwitch({
      leftLabel: "OFF",
      rightLabel: "ON",
      defaultRight: this.uiState.showFavoriteCorners,
      compact: true
    });
    this.dom.showFavoriteCornersInput = favoriteCornerSwitch.input;
    this.dom.showFavoriteCornersLabels = {
      left: favoriteCornerSwitch.leftLabel,
      right: favoriteCornerSwitch.rightLabel
    };
    this.updateSwitchLabels(
      favoriteCornerSwitch.input,
      favoriteCornerSwitch.leftLabel,
      favoriteCornerSwitch.rightLabel
    );
    favoriteCornerSwitch.input.addEventListener("change", () => {
      this.uiState.showFavoriteCorners = favoriteCornerSwitch.input.checked;
      this.updateSwitchLabels(
        favoriteCornerSwitch.input,
        favoriteCornerSwitch.leftLabel,
        favoriteCornerSwitch.rightLabel
      );
      this.renderAlbumsPage();
    });
    favoriteCornerRow.appendChild(favoriteCornerLabel);
    favoriteCornerRow.appendChild(favoriteCornerSwitch.wrapper);
    searchSection.appendChild(favoriteCornerRow);

    const cdBackGlobalRow = document.createElement("div");
    cdBackGlobalRow.className = "filter-toggle-row";
    const cdBackGlobalLabel = document.createElement("div");
    cdBackGlobalLabel.className = "filter-toggle-title";
    cdBackGlobalLabel.textContent = "CD BACK (GLOBAL) – wyświetlanie tyłu okładki";
    const cdBackGlobalSwitch = this.createSwitch({
      id: "cdBackGlobalToggle",
      leftLabel: "OFF",
      rightLabel: "ON",
      defaultRight: this.uiState.cdBackGlobalEnabled,
      compact: true
    });
    this.updateSwitchLabels(
      cdBackGlobalSwitch.input,
      cdBackGlobalSwitch.leftLabel,
      cdBackGlobalSwitch.rightLabel
    );
    cdBackGlobalSwitch.input.addEventListener("change", () => {
      this.uiState.cdBackGlobalEnabled = cdBackGlobalSwitch.input.checked;
      this.updateSwitchLabels(
        cdBackGlobalSwitch.input,
        cdBackGlobalSwitch.leftLabel,
        cdBackGlobalSwitch.rightLabel
      );
      this.processAndRender();
    });
    cdBackGlobalRow.appendChild(cdBackGlobalLabel);
    cdBackGlobalRow.appendChild(cdBackGlobalSwitch.wrapper);
    searchSection.appendChild(cdBackGlobalRow);

    const dateRange = document.createElement("div");
    dateRange.className = "filter-date-range";
    const months = [
      { label: "wszystkie miesiące", value: "__all__" },
      { label: "styczeń", value: "1" },
      { label: "luty", value: "2" },
      { label: "marzec", value: "3" },
      { label: "kwiecień", value: "4" },
      { label: "maj", value: "5" },
      { label: "czerwiec", value: "6" },
      { label: "lipiec", value: "7" },
      { label: "sierpień", value: "8" },
      { label: "wrzesień", value: "9" },
      { label: "październik", value: "10" },
      { label: "listopad", value: "11" },
      { label: "grudzień", value: "12" }
    ];
    
    const createCycleButton = ({ id, className, options, onChange }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = className;
      if (id) button.id = id;
      let index = 0;
      const update = () => {
        const current = options[index];
        button.textContent = current.label;
        button.value = current.value;
      };
      const setValue = (value, { silent = false } = {}) => {
        const nextIndex = options.findIndex((option) => option.value === value);
        index = nextIndex >= 0 ? nextIndex : 0;
        update();
        if (!silent) {
          onChange?.(button.value);
        }
      };
      button.setValue = setValue;
      const shiftIndex = (delta) => {
        index = (index + delta + options.length) % options.length;
        update();
        onChange?.(button.value);
        };
      button.addEventListener("click", () => {
        shiftIndex(1);
      });
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        shiftIndex(-1);
      });
      update();
      return button;
    };

    const createYearControl = ({ id, onChange }) => {
      const yearInput = document.createElement("input");
      yearInput.type = "hidden";
      yearInput.id = id;
      yearInput.value = "__all__";

      const wrapper = document.createElement("div");
      wrapper.className = "filter-year-control";

      const digitOptions = [
        ["X", "1", "2"],
        ["X", "9", "0"],
        ["X", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
        ["X", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]
      ];
      const digitIndexes = digitOptions.map(() => 0);
      const digitButtons = digitOptions.map((options, idx) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "filter-year-digit";
        btn.textContent = options[0];
        const shiftDigit = (delta) => {
          digitIndexes[idx] = (digitIndexes[idx] + delta + options.length) % options.length;
          btn.textContent = options[digitIndexes[idx]];
          updateYearValue();
          };
        btn.addEventListener("click", () => {
          shiftDigit(1);
        });
        btn.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          shiftDigit(-1);
        });
        wrapper.appendChild(btn);
        return btn;
      });

      const updateYearValue = (silent = false) => {
        const digits = digitOptions.map((options, idx) => options[digitIndexes[idx]]);
        if (digits.some((digit) => digit === "X")) {
          yearInput.value = "__all__";
        } else {
          yearInput.value = digits.join("");
        }
        if (!silent) {
          onChange?.(yearInput.value);
        }
      };

      const setValue = (value, { silent = false } = {}) => {
        if (typeof value === "string" && /^\d{4}$/.test(value)) {
          value.split("").forEach((digit, idx) => {
            const options = digitOptions[idx];
            const targetIndex = options.indexOf(digit);
            digitIndexes[idx] = targetIndex >= 0 ? targetIndex : 0;
            digitButtons[idx].textContent = options[digitIndexes[idx]];
          });
        } else {
          digitIndexes.forEach((_, idx) => {
            digitIndexes[idx] = 0;
            digitButtons[idx].textContent = digitOptions[idx][0];
          });
        }
        updateYearValue(silent);
      };

      return { wrapper, input: yearInput, setValue, updateYearValue };
    };

    const buildDateBlock = ({ labelText, yearId, monthId, clearLabel, onClear }) => {
      const block = document.createElement("div");
      block.className = "filter-date-block";

      const label = document.createElement("div");
      label.className = "filter-date-label";
      label.textContent = labelText;

      const selectsWrap = document.createElement("div");
      selectsWrap.className = "filter-date-selects";

      const monthButton = createCycleButton({
        id: monthId,
        className: "filter-cycle-btn",
        options: months,
        onChange: () => {
          this.resetCurrentPage();
          this.processAndRender();
        }
      });
      monthButton.title = "Miesiąc wydania";

      const yearControl = createYearControl({
        id: yearId,
        onChange: (value) => {
          if (value === "__all__") {
            monthButton.setValue("__all__", { silent: true });
          }
          this.resetCurrentPage();
          this.processAndRender();
        }
      });
      yearControl.input.title = "Rok wydania";

      selectsWrap.appendChild(yearControl.wrapper);
      selectsWrap.appendChild(yearControl.input);
      selectsWrap.appendChild(monthButton);

      const actions = this.createActionsRow([{ label: clearLabel, handler: onClear }]);
      actions.classList.add("filter-actions--inline");

      block.appendChild(label);
      block.appendChild(selectsWrap);
      block.appendChild(actions);

      return { block, yearControl, monthButton };
    };

    const fromBlock = buildDateBlock({
      labelText: "FROM",
      yearId: "releaseYearFrom",
      monthId: "releaseMonthFrom",
      clearLabel: "CLEAR",
      onClear: () => {
        this.setYearControlValue(this.dom.releaseYearFromControl, "__all__", { silent: true });
        this.setCycleButtonValue(this.dom.releaseMonthFrom, "__all__", { silent: true });
        this.resetCurrentPage();
        this.processAndRender();
      }
    });
    const toBlock = buildDateBlock({
      labelText: "TO",
      yearId: "releaseYearTo",
      monthId: "releaseMonthTo",
      clearLabel: "CLEAR",
      onClear: () => {
        this.setYearControlValue(this.dom.releaseYearToControl, "__all__", { silent: true });
        this.setCycleButtonValue(this.dom.releaseMonthTo, "__all__", { silent: true });
        this.resetCurrentPage();
        this.processAndRender();
      }
    });

    dateRange.appendChild(fromBlock.block);
    dateRange.appendChild(toBlock.block);
    searchSection.appendChild(dateRange);

    searchInput.addEventListener("blur", () => this.deferHideSuggestions(searchSuggestions));
    this.dom.searchInput = searchInput;
    this.dom.searchSuggestions = searchSuggestions;
    this.dom.releaseYearFrom = fromBlock.yearControl.input;
    this.dom.releaseMonthFrom = fromBlock.monthButton;
    this.dom.releaseYearTo = toBlock.yearControl.input;
    this.dom.releaseMonthTo = toBlock.monthButton;
    this.dom.releaseYearFromControl = fromBlock.yearControl;
    this.dom.releaseYearToControl = toBlock.yearControl;
    return searchSection;
  }

  createSelectorSection() {
    const selectorSection = document.createElement("div");
    selectorSection.className = "filter-section";

    const selectorGrid = document.createElement("div");
    selectorGrid.className = "filter-grid";

    SELECTOR_VALUES.forEach((value) => {
      const label = SELECTOR_LABELS[value];
      const dot = document.createElement("span");
      dot.className = "filter-chip__selector-dot";
      dot.style.setProperty("--selector-dot-color", getSelectorStyle(value).borderColor);
      selectorGrid.appendChild(
        this.createFilterChip({
          value,
          label,
          prefix: dot,
          selectionSet: this.uiState.selectedSelectors,
          onChange: () => this.processAndRender()
        })
      );
    });

    const favoritesChip = document.createElement("label");
    favoritesChip.className = "filter-chip filter-chip--selection";
    const favoritesText = document.createElement("span");
    favoritesText.textContent = "POKAŻ ULUBIONE ALBUMY";
    const favoritesInput = document.createElement("input");
    favoritesInput.type = "checkbox";
    favoritesInput.value = "";
    favoritesInput.checked = this.uiState.showFavorites;
    favoritesInput.addEventListener("change", () => {
      this.uiState.showFavorites = favoritesInput.checked;
      this.resetCurrentPage();
      this.processAndRender();
    });
    favoritesChip.appendChild(favoritesText);
    favoritesChip.appendChild(favoritesInput);
    selectorGrid.appendChild(favoritesChip);
    this.dom.showFavoritesInput = favoritesInput;

    const selectorActions = this.createActionsRow([
      {
        label: "ALL",
        handler: () => this.applyBulkSelection(selectorGrid, this.uiState.selectedSelectors, true)
      },
      {
        label: "NONE",
        handler: () => this.applyBulkSelection(selectorGrid, this.uiState.selectedSelectors, false)
      }
    ]);

    selectorSection.appendChild(selectorGrid);
    selectorSection.appendChild(selectorActions);
    return selectorSection;
  }

  createLabelsSection() {
    const labelsSection = document.createElement("div");
    labelsSection.className = "filter-section";

    const labelsGrid = document.createElement("div");
    labelsGrid.className = "filter-grid";
    this.populateLabelsGrid(labelsGrid);
    
    const labelActions = this.createActionsRow([
      {
        label: "ALL",
        handler: () => this.applyBulkSelection(labelsGrid, this.uiState.selectedLabels, true)
      },
      {
        label: "NONE",
        handler: () => this.applyBulkSelection(labelsGrid, this.uiState.selectedLabels, false)
      }
    ]);

    labelsSection.appendChild(labelsGrid);
    labelsSection.appendChild(labelActions);
    this.dom.labelsGrid = labelsGrid;
    return labelsSection;
  }

  refreshLabelsGrid() {
    if (this.dom.labelsGrid) {
      this.populateLabelsGrid(this.dom.labelsGrid);
    }
  }

  getLabelNameFromHierarchy(entry) {
    const parts = String(entry || "").split(" - ");
    parts.shift();
    return parts.join(" - ").trim();
  }

  populateLabelsGrid(labelsGrid) {
    if (!labelsGrid) return;
    labelsGrid.innerHTML = "";
    LABEL_HIERARCHY.forEach((entry) => {
      const name = this.getLabelNameFromHierarchy(entry);
      if (!name) return;
      labelsGrid.appendChild(
        this.createFilterChip({
          value: name,
          label: name,
          selectionSet: this.uiState.selectedLabels,
          onChange: () => this.processAndRender()
        })
      );
    });
  }

  createOperationsSection() {
    const wrapper = document.createElement("div");
    wrapper.className = "filter-ops";
    this.dom.operationsScopeInputs = {};

    const opsButtons = document.createElement("div");
    opsButtons.className = "ops-button-grid";
    const makeOpButton = (id, label) => {
      const btn = document.createElement("button");
      btn.id = id;
      btn.type = "button";
      btn.textContent = label;
      btn.className = "option-chip ops-button";
      opsButtons.appendChild(btn);
      return btn;
    };

    this.dom.importDbBtn = makeOpButton("importDbBtn", "IMPORT DB");
    this.dom.updateDbBtn = makeOpButton("updateDbBtn", "UPDATE DB");
    this.dom.exportDbBtn = makeOpButton("exportDbBtn", "EXPORT DB");
    this.dom.importJsonBtn = makeOpButton("importJsonBtn", "IMPORT JSON");
    this.dom.qobuzScrapeBtn = makeOpButton("qobuzScrapeBtn", "QOBUZ SCRAPE");
    this.dom.downloadDbBtn = makeOpButton("downloadDbBtn", "SAVE XLSX");
    this.dom.downloadTxtBtn = makeOpButton("downloadTxtBtn", "SAVE TXT");
    const placeholder = document.createElement("div");
    placeholder.className = "ops-button ops-button--placeholder";
    opsButtons.appendChild(placeholder);

    wrapper.appendChild(opsButtons);

    const collectionSection = document.createElement("div");
    collectionSection.className = "filter-section";
    collectionSection.appendChild(this.createSectionTitle("COLLECTIONS"));

    const collectionRow = document.createElement("div");
    collectionRow.className = "options-select-row";
    const collectionLabel = document.createElement("div");
    collectionLabel.className = "options-select-label";
    collectionLabel.textContent = "Kolekcja";
    const collectionSelectWrap = document.createElement("div");
    collectionSelectWrap.className = "menu-select";
    const collectionSelect = document.createElement("select");
    collectionSelect.id = "collectionSelect";
    collectionSelect.title = "Wybierz kolekcję";
    collectionSelectWrap.appendChild(collectionSelect);
    collectionRow.appendChild(collectionLabel);
    collectionRow.appendChild(collectionSelectWrap);
    collectionSection.appendChild(collectionRow);

    this.dom.collectionSelect = collectionSelect;
    this.rebuildCollectionSelect();

    const scopeSection = document.createElement("div");
    scopeSection.className = "filter-section";
    scopeSection.appendChild(this.createSectionTitle("OPERACJE NA"));
    const scopeRow = document.createElement("div");
    scopeRow.className = "ops-scope";
    const scopeOptions = [
      { value: "folders", label: "FOLDERS" },
      { value: "containers", label: "CONTAINERS" },
      { value: "collections", label: "COLLECTIONS" }
    ];
    scopeOptions.forEach(({ value, label }) => {
      const optionLabel = document.createElement("label");
      optionLabel.className = "ops-scope__option";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "opsScope";
      input.value = value;
      input.checked = this.uiState.operationsScope === value;
      optionLabel.appendChild(input);
      const text = document.createElement("span");
      text.textContent = label;
      optionLabel.appendChild(text);
      scopeRow.appendChild(optionLabel);
      this.dom.operationsScopeInputs[value] = input;
    });
    scopeSection.appendChild(scopeRow);

    const actionGrid = document.createElement("div");
    actionGrid.className = "option-grid";
    const makeActionBtn = (id, label) => {
      const btn = document.createElement("button");
      btn.id = id;
      btn.type = "button";
      btn.className = "option-chip";
      btn.textContent = label;
      actionGrid.appendChild(btn);
      return btn;
    };
    this.dom.addEntityBtn = makeActionBtn("addEntityBtn", "ADD");
    this.dom.editEntityBtn = makeActionBtn("editEntityBtn", "EDIT");
    this.dom.deleteEntityBtn = makeActionBtn("deleteEntityBtn", "DELETE");
    scopeSection.appendChild(actionGrid);

    wrapper.appendChild(collectionSection);
    wrapper.appendChild(scopeSection);
    return wrapper;
  }

  createPathsSection() {
    const wrapper = document.createElement("div");
    wrapper.className = "filter-section";

    const dataModeGrid = document.createElement("div");
    dataModeGrid.className = "data-mode-grid";
    const switchConfigs = [
      { key: "importDb", label: "IMPORT DB" },
      { key: "importJson", label: "IMPORT JSON" },
      { key: "updateDb", label: "UPDATE DB" },
      { key: "exportDb", label: "EXPORT DB" },
      { key: "download", label: "SAVE XLSX / TXT" }
    ];

    switchConfigs.forEach(({ key, label }) => {
      const row = document.createElement("div");
      row.className = "data-mode-row";

      const title = document.createElement("div");
      title.className = "data-mode-title";
      title.textContent = label;

      const dataSwitch = this.createSwitch({
        id: `${key}ModeToggle`,
        leftLabel: "MANUAL",
        rightLabel: "AUTO",
        defaultRight: this.getOperationMode(key) !== "MANUAL",
        compact: true
      });

      this.dom.dataModeToggles[key] = dataSwitch.input;
      this.dom.dataModeLabels[key] = { left: dataSwitch.leftLabel, right: dataSwitch.rightLabel };
      this.updateSwitchLabels(dataSwitch.input, dataSwitch.leftLabel, dataSwitch.rightLabel);

      const hint = document.createElement("div");
      hint.className = "data-mode-hint";
      this.dom.dataDirectoryHints[key] = hint;

      row.appendChild(title);
      row.appendChild(dataSwitch.wrapper);
      row.appendChild(hint);
      dataModeGrid.appendChild(row);
    });

    wrapper.appendChild(dataModeGrid);

    return wrapper;
  }

  createTimeSection() {
    const wrapper = document.createElement("div");
    wrapper.className = "filter-section filter-time";
    wrapper.appendChild(this.createSectionTitle("TIME"));

    const heardRow = document.createElement("div");
    heardRow.className = "heard-filter";
    const heardLabel = document.createElement("span");
    heardLabel.className = "heard-filter__label";
    heardLabel.textContent = "Filtr HEARD";

    const heardControls = document.createElement("div");
    heardControls.className = "heard-filter__controls";
    const buildHeardControl = ({ label, boundary, onShiftLeft, onShiftRight }) => {
      const wrapper = document.createElement("div");
      wrapper.className = "heard-filter__range";
      const rangeLabel = document.createElement("span");
      rangeLabel.className = "heard-filter__range-label";
      rangeLabel.textContent = label;
      const control = document.createElement("div");
      control.className = "heard-filter__range-control";
      const leftBtn = document.createElement("button");
      leftBtn.type = "button";
      leftBtn.className = "menu-chip pagination__btn filter-arrow-btn";
      const leftInner = document.createElement("span");
      leftInner.className = "menu-chip__inner";
      leftInner.textContent = "<<";
      leftBtn.appendChild(leftInner);
      leftBtn.addEventListener("click", onShiftLeft);
      const heardValueWrap = document.createElement("div");
      heardValueWrap.className = "remix-percent__value";
      const heardValue = document.createElement("input");
      heardValue.type = "text";
      heardValue.inputMode = "numeric";
      heardValue.className = "remix-percent__input";
      heardValue.addEventListener("focus", () => heardValue.select());
      heardValue.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        this.applyHeardInput(boundary, heardValue.value);
        heardValue.blur();
      });
      heardValue.addEventListener("blur", () => this.applyHeardInput(boundary, heardValue.value));
      heardValueWrap.appendChild(heardValue);
      const rightBtn = document.createElement("button");
      rightBtn.type = "button";
      rightBtn.className = "menu-chip pagination__btn filter-arrow-btn";
      const rightInner = document.createElement("span");
      rightInner.className = "menu-chip__inner";
      rightInner.textContent = ">>";
      rightBtn.appendChild(rightInner);
      rightBtn.addEventListener("click", onShiftRight);
      control.appendChild(leftBtn);
      control.appendChild(heardValueWrap);
      control.appendChild(rightBtn);
      wrapper.appendChild(rangeLabel);
      wrapper.appendChild(control);
      return { wrapper, leftBtn, rightBtn, heardValue };
    };

    const heardMinControl = buildHeardControl({
      label: "Od",
      boundary: "min",
      onShiftLeft: () => this.shiftHeardRange("min", -1),
      onShiftRight: () => this.shiftHeardRange("min", 1)
    });
    const heardMaxControl = buildHeardControl({
      label: "Do",
      boundary: "max",
      onShiftLeft: () => this.shiftHeardRange("max", -1),
      onShiftRight: () => this.shiftHeardRange("max", 1)
    });

    this.dom.heardMinLeftBtn = heardMinControl.leftBtn;
    this.dom.heardMinRightBtn = heardMinControl.rightBtn;
    this.dom.heardMinDisplay = heardMinControl.heardValue;
    this.dom.heardMaxLeftBtn = heardMaxControl.leftBtn;
    this.dom.heardMaxRightBtn = heardMaxControl.rightBtn;
    this.dom.heardMaxDisplay = heardMaxControl.heardValue;

    heardControls.appendChild(heardMinControl.wrapper);
    heardControls.appendChild(heardMaxControl.wrapper);

    heardRow.appendChild(heardLabel);
    heardRow.appendChild(heardControls);

    const rangeRow = document.createElement("div");
    rangeRow.className = "heard-filter";
    const rangeLabel = document.createElement("span");
    rangeLabel.className = "heard-filter__label";
    rangeLabel.textContent = "Zakres czasu trwania (min)";

    const rangeControls = document.createElement("div");
    rangeControls.className = "heard-filter__controls";
    const buildDurationControl = ({ label, placeholder }) => {
      const wrapper = document.createElement("div");
      wrapper.className = "heard-filter__range";
      const rangeLabel = document.createElement("span");
      rangeLabel.className = "heard-filter__range-label";
      rangeLabel.textContent = label;
      const control = document.createElement("div");
      control.className = "heard-filter__range-control";
      const leftBtn = document.createElement("button");
      leftBtn.type = "button";
      leftBtn.className = "menu-chip pagination__btn filter-arrow-btn";
      const leftInner = document.createElement("span");
      leftInner.className = "menu-chip__inner";
      leftInner.textContent = "<<";
      leftBtn.appendChild(leftInner);
      const valueWrap = document.createElement("div");
      valueWrap.className = "remix-percent__value";
      const input = document.createElement("input");
      input.type = "text";
      input.inputMode = "numeric";
      input.className = "remix-percent__input";
      input.placeholder = placeholder;
      input.addEventListener("input", () => this.updateDurationRange());
      input.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        input.focus();
        input.select();
      });
      valueWrap.appendChild(input);
      const rightBtn = document.createElement("button");
      rightBtn.type = "button";
      rightBtn.className = "menu-chip pagination__btn filter-arrow-btn";
      const rightInner = document.createElement("span");
      rightInner.className = "menu-chip__inner";
      rightInner.textContent = ">>";
      rightBtn.appendChild(rightInner);
      control.appendChild(leftBtn);
      control.appendChild(valueWrap);
      control.appendChild(rightBtn);
      wrapper.appendChild(rangeLabel);
      wrapper.appendChild(control);
      return { wrapper, input, leftBtn, rightBtn };
    };

    const minDuration = buildDurationControl({
      label: "Od",
      placeholder: "np. 10"
    });
    minDuration.leftBtn.addEventListener("click", () => this.adjustDurationRangeInput(minDuration.input, -1));
    minDuration.rightBtn.addEventListener("click", () => this.adjustDurationRangeInput(minDuration.input, 1));
    const maxDuration = buildDurationControl({
      label: "Do",
      placeholder: "np. 60"
    });
    maxDuration.leftBtn.addEventListener("click", () => this.adjustDurationRangeInput(maxDuration.input, -1));
    maxDuration.rightBtn.addEventListener("click", () => this.adjustDurationRangeInput(maxDuration.input, 1));

    rangeControls.appendChild(minDuration.wrapper);
    rangeControls.appendChild(maxDuration.wrapper);
    rangeRow.appendChild(rangeLabel);
    rangeRow.appendChild(rangeControls);

    this.dom.durationRangeMinInput = minDuration.input;
    this.dom.durationRangeMaxInput = maxDuration.input;

    const sortTitle = document.createElement("div");
    sortTitle.className = "filter-section__subtitle";
    sortTitle.textContent = "Sortowanie czasu trwania";

    const sortButtons = document.createElement("div");
    sortButtons.className = "filter-time__sort";

    const buildSortChip = ({ label, mode }) => {
      const chip = document.createElement("label");
      chip.className = "filter-chip";
      const text = document.createElement("span");
      text.textContent = label;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = this.uiState.sortMode === mode;
      checkbox.addEventListener("change", () => {
        this.setTimeSortMode(mode);
      });
      chip.appendChild(text);
      chip.appendChild(checkbox);
      return { chip, checkbox };
    };

    const ascChip = buildSortChip({
      label: "SORTUJ OD NAJKRÓTSZYCH ALBUMÓW",
      mode: "duration_asc"
    });
    const descChip = buildSortChip({
      label: "SORTUJ OD NAJDŁUŻSZYCH ALBUMÓW",
      mode: "duration_desc"
    });
    const releaseDescChip = buildSortChip({
      label: "SORTUJ OD NAJNOWSZYCH ALBUMÓW",
      mode: "release_desc"
    });
    const releaseAscChip = buildSortChip({
      label: "SORTUJ OD NAJSTARSZYCH ALBUMÓW",
      mode: "release_asc"
    });

    this.dom.sortDurationAscBtn = ascChip.checkbox;
    this.dom.sortDurationDescBtn = descChip.checkbox;
    this.dom.sortReleaseDescBtn = releaseDescChip.checkbox;
    this.dom.sortReleaseAscBtn = releaseAscChip.checkbox;

    const releaseRow = document.createElement("div");
    releaseRow.className = "filter-grid filter-time__sort-row";
    releaseRow.appendChild(releaseDescChip.chip);
    releaseRow.appendChild(releaseAscChip.chip);

    const durationRow = document.createElement("div");
    durationRow.className = "filter-grid filter-time__sort-row";
    durationRow.appendChild(ascChip.chip);
    durationRow.appendChild(descChip.chip);

    sortButtons.appendChild(releaseRow);
    sortButtons.appendChild(durationRow);
    
    const timeActions = this.createActionsRow([
      {
        label: "CLEAR",
        handler: () => this.resetTimeFiltersAndRender()
      }
    ]);

    wrapper.appendChild(heardRow);
    wrapper.appendChild(rangeRow);
    wrapper.appendChild(sortTitle);
    wrapper.appendChild(sortButtons);
    wrapper.appendChild(timeActions);
    return wrapper;
  }

  deferHideSuggestions(list) {
    if (!list) return;
    setTimeout(() => {
      this.hideSuggestions(list);
    }, 140);
  }

  hideSuggestions(list) {
    if (!list) return;
    list.innerHTML = "";
    list.hidden = true;
  }

  getAlbumSearchSuggestions(term) {
    const needle = String(term || "").trim().toLowerCase();
    if (!needle) return [];
    const suggestions = new Set();
    this.store.records.forEach((album) => {
      const title = String(album.title || "").trim();
      if (!title) return;
      if (!title.toLowerCase().startsWith(needle)) return;
      suggestions.add(title);
    });
    return Array.from(suggestions)
      .sort((a, b) => a.localeCompare(b, "pl"))
      .slice(0, 8);
  }

  getRemixFolderSuggestions(term) {
    const needle = String(term || "").trim().toLowerCase();
    if (!needle) return [];
    return Array.from(this.store.foldersList || [])
      .filter((name) => name && name !== "brak")
      .filter((name) => name.toLowerCase().includes(needle))
      .sort((a, b) => a.localeCompare(b, "pl"))
      .slice(0, 8);
  }

  updateSearchSuggestions() {
    const input = this.dom.searchInput;
    const list = this.dom.searchSuggestions;
    if (!input || !list) return;
    const term = input.value.trim();
    if (!term) {
      this.hideSuggestions(list);
      return;
    }
    const suggestions = this.getAlbumSearchSuggestions(term);
    list.innerHTML = "";
    if (!suggestions.length) {
      list.hidden = true;
      return;
    }
    suggestions.forEach((value) => {
      const item = document.createElement("li");
      item.className = "search-suggestions__item";
      item.textContent = value;
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        input.value = value;
        this.hideSuggestions(list);
        this.resetCurrentPage();
        this.processAndRender();
      });
      list.appendChild(item);
    });
    list.hidden = false;
  }

  updateRemixSearchSuggestions() {
    const input = this.dom.remixSearchInput;
    const list = this.dom.remixSearchSuggestions;
    if (!input || !list) return;
    const term = input.value.trim();
    if (!term) {
      this.hideSuggestions(list);
      return;
    }
    const suggestions = this.getRemixFolderSuggestions(term);
    list.innerHTML = "";
    if (!suggestions.length) {
      list.hidden = true;
      return;
    }
    suggestions.forEach((value) => {
      const item = document.createElement("li");
      item.className = "search-suggestions__item";
      item.textContent = value;
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        input.value = value;
        this.uiState.remixSearchTerm = value;
        this.hideSuggestions(list);
      });
      list.appendChild(item);
    });
    list.hidden = false;
  }

  getRemixSlotTargetCount(slot, total) {
    if (!total) return 0;
    if (slot.mode === "count") {
      const base = Number.isFinite(slot.count) ? slot.count : total;
      const clamped = Math.max(1, Math.min(total, Math.round(base)));
      slot.count = clamped;
      return clamped;
    }
    return this.getRemixAppliedCount(total, slot.percent);
  }

  getRemixLockedSet(folderName) {
    if (!folderName) return new Set();
    const map = this.uiState.remixLocked;
    if (!map.has(folderName)) {
      map.set(folderName, new Set());
    }
    return map.get(folderName);
  }

  getRemixLockedCount(folderName) {
    if (!folderName) return 0;
    return this.getRemixLockedSet(folderName).size;
  }

  refreshRemixSlotDisplays() {
    if (!this.dom.remixSlots.length) return;
    this.dom.remixSlots.forEach((slotDom, index) => {
      const slotIndex = this.getRemixSlotIndex(index);
      const slot = this.uiState.remixSlots[slotIndex];
      if (!slot || !slotDom) return;
      const isEnabled = slot.enabled !== false;
      if (slotDom.toggle) {
        slotDom.toggle.checked = isEnabled;
      }
      if (slotDom.row) {
        slotDom.row.classList.toggle("is-disabled", !isEnabled);
      }
      slotDom.label.textContent = `FOLDER ${slotIndex + 1}`;
      const folderName = slot.folder;
      slotDom.percentValueWrap?.setAttribute("data-mode", slot.mode || "percent");
      if (!folderName) {
        slotDom.value.textContent = "brak";
        slotDom.percentValue.value = slot.mode === "count" ? "0" : `${slot.percent}%`;
        return;
      }
      const total = this.getRemixFolderCount(folderName);
      const lockedCount = this.getRemixLockedCount(folderName);
      const target = this.getRemixSlotTargetCount(slot, total);
      const randomCount = Math.max(target - lockedCount, 0);
      const displayCounts =
        lockedCount > 0
          ? `${randomCount} + ${lockedCount} z ${total}`
          : `${target} z ${total}`;
      slotDom.value.textContent = `${folderName} (${displayCounts})`;
      slotDom.percentValue.value = slot.mode === "count" ? String(target) : `${slot.percent}%`;
    });
  }

  assignRemixFolder(index) {
    const searchValue = this.dom.remixSearchInput?.value || "";
    const match = this.findRemixFolderMatch(searchValue);
    if (!match) {
      this.showRemixStatus("Nie znaleziono folderu o podanej nazwie.", "warning");
      return;
    }
    this.uiState.remixSlots[index].folder = match;
    if (this.uiState.remixSlots[index].mode === "count") {
      this.uiState.remixSlots[index].count = this.getRemixFolderCount(match);
    }
    if (this.dom.remixSearchInput) {
      this.dom.remixSearchInput.value = "";
    }
    this.updateRemixSearchSuggestions();
    this.refreshRemixSlotDisplays();
    if (this.uiState.remixEnabled) {
      this.resetCurrentPage();
      this.processAndRender();
    }
  }

  unassignRemixFolder(index) {
    const slot = this.uiState.remixSlots[index];
    if (!slot) return;
    if (slot.folder) {
      this.uiState.remixLocked.delete(slot.folder);
    }
    slot.folder = "";
    slot.mode = "percent";
    slot.count = null;
    slot.percent = 100;
    slot.enabled = true;
    this.refreshRemixSlotDisplays();
    if (this.uiState.remixEnabled) {
      this.resetCurrentPage();
      this.processAndRender();
    }
  }

  clearRemixSlots() {
    this.uiState.remixSlots = this.createEmptyRemixSlots();
    this.uiState.remixLocked = new Map();
    this.refreshRemixSlotDisplays();
    if (this.uiState.remixEnabled) {
      this.resetCurrentPage();
      this.processAndRender();
    }
  }

  shiftRemixValue(index, delta) {
    const slot = this.uiState.remixSlots[index];
    if (!slot) return;
    if (slot.mode === "count") {
      const total = this.getRemixFolderCount(slot.folder);
      if (!total) return;
      const base = Number.isFinite(slot.count) ? slot.count : total;
      const next = Math.max(1, Math.min(total, base + delta));
      slot.count = next;
    } else {
      const next = Math.max(1, Math.min(100, (slot.percent || 100) + delta));
      slot.percent = next;
    }
    this.refreshRemixSlotDisplays();
    if (this.uiState.remixEnabled) {
      this.resetCurrentPage();
      this.processAndRender();
    }
  }

  applyRemixValueInput(index, rawValue) {
    const slot = this.uiState.remixSlots[index];
    if (!slot) return;
    const trimmed = String(rawValue || "").trim();
    if (!trimmed) {
      this.showStatusMessage("Wprowadzono nieprawidłową wartość.");
      this.refreshRemixSlotDisplays();
      return;
    }
    if (slot.mode === "count") {
      const total = this.getRemixFolderCount(slot.folder);
      const parsed = Number.parseInt(trimmed.replace(/[^\d-]/g, ""), 10);
      if (!total || Number.isNaN(parsed) || parsed < 1 || parsed > total) {
        this.showStatusMessage("Wprowadzono nieprawidłową wartość.");
        this.refreshRemixSlotDisplays();
        return;
      }
      slot.count = parsed;
    } else {
      const cleaned = trimmed.replace("%", "");
      const parsed = Number.parseInt(cleaned, 10);
      if (Number.isNaN(parsed) || parsed < 1 || parsed > 100) {
        this.showStatusMessage("Wprowadzono nieprawidłową wartość.");
        this.refreshRemixSlotDisplays();
        return;
      }
      slot.percent = parsed;
    }
    this.refreshRemixSlotDisplays();
    if (this.uiState.remixEnabled) {
      this.resetCurrentPage();
      this.processAndRender();
    }
  }

  toggleRemixSlotMode(index) {
    const slot = this.uiState.remixSlots[index];
    if (!slot) return;
    if (slot.mode === "count") {
      slot.mode = "percent";
    } else {
      slot.mode = "count";
      const total = this.getRemixFolderCount(slot.folder);
      slot.count = total || 0;
    }
    this.refreshRemixSlotDisplays();
    if (this.uiState.remixEnabled) {
      this.resetCurrentPage();
      this.processAndRender();
    }
  }

  findRemixFolderMatch(term) {
    const trimmed = String(term || "").trim();
    if (!trimmed) return null;
    const lowered = trimmed.toLowerCase();
    const folders = Array.from(this.store.foldersList || []);
    const match = folders.find((name) => name.toLowerCase() === lowered);
    return match && match !== "brak" ? match : null;
  }

  getRemixFolderCount(folderName) {
    return this.store.getAlbumsForFolder(folderName).length;
  }

  getRemixAppliedCount(total, percent) {
    if (!total) return 0;
    const computed = Math.round((total * percent) / 100);
    return Math.max(1, Math.min(total, computed));
  }

  shuffleArray(list) {
    const array = [...list];
    for (let i = array.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  buildRemixList() {
    const unique = new Map();
    this.uiState.remixSlots.forEach((slot, index) => {
      if (!this.isRemixSlotPageEnabled(index)) return;
      if (!slot.folder) return;
      if (slot.enabled === false) return;
      const allAlbums = this.store.getAlbumsForFolder(slot.folder);
      const total = allAlbums.length;
      if (!total) return;
      const lockedSet = this.getRemixLockedSet(slot.folder);
      const lockedAlbums = allAlbums.filter((album) => lockedSet.has(album?.id_albumu));
      const targetCount = this.getRemixSlotTargetCount(slot, total);
      const randomCount = Math.max(targetCount - lockedAlbums.length, 0);
      const available = allAlbums.filter((album) => !lockedSet.has(album?.id_albumu));
      const shuffled = this.shuffleArray(available);
      [...lockedAlbums, ...shuffled.slice(0, randomCount)].forEach((album) => {
        if (album?.id_albumu) {
          unique.set(album.id_albumu, { album, folder: slot.folder });
        }
      });
    });
    return this.shuffleArray(Array.from(unique.values()));
  }

  renderRemixList() {
    if (!this.uiState.remixEnabled) return;
    this.updateNavCounts();
    this.renderAlbumsPage();
    this.updateFilterTabIndicators();
  }

  replaceRemixEntry(entry) {
    if (!this.uiState.remixEnabled || !entry) return false;
    const album = entry.album || entry;
    const targetId = album?.id_albumu;
    if (!targetId) return false;
    const listIndex = this.uiState.remixList.findIndex((item) => {
      const itemAlbum = item.album || item;
      return itemAlbum?.id_albumu === targetId;
    });
    if (listIndex === -1) return false;

    const folder = entry.folder || this.getRemixFolderForAlbum(album);
    if (!folder || folder === "brak") {
      this.uiState.remixList.splice(listIndex, 1);
      return true;
    }

    const allAlbums = this.store.getAlbumsForFolder(folder);
    const existingIds = new Set(
      this.uiState.remixList
        .map((item) => (item.album || item)?.id_albumu)
        .filter(Boolean)
    );
    existingIds.delete(targetId);
    const lockedSet = this.getRemixLockedSet(folder);
    const lockedCandidates = allAlbums.filter(
      (item) => item?.id_albumu && lockedSet.has(item.id_albumu) && !existingIds.has(item.id_albumu)
    );
    const availableCandidates = allAlbums.filter(
      (item) => item?.id_albumu && !existingIds.has(item.id_albumu)
    );
    const candidates = lockedCandidates.length ? lockedCandidates : availableCandidates;
    if (!candidates.length) {
      this.uiState.remixList.splice(listIndex, 1);
      return true;
    }

    const replacement = this.shuffleArray(candidates)[0];
    this.uiState.remixList[listIndex] = { album: replacement, folder };
    return true;
  }

  attachHoldAction(button, action) {
    if (!button || typeof action !== "function") return;
    let holdTimeout = null;
    let holdInterval = null;
    let didHold = false;
    const clearHold = () => {
      if (holdTimeout) clearTimeout(holdTimeout);
      if (holdInterval) clearInterval(holdInterval);
      if (didHold) {
        button.dataset.suppressClick = "true";
      }
      holdTimeout = null;
      holdInterval = null;
      didHold = false;
      document.removeEventListener("mouseup", clearHold);
      document.removeEventListener("mouseleave", clearHold);
    };
    const startHold = (event) => {
      if (event.button !== 0) return;
      holdTimeout = setTimeout(() => {
        didHold = true;
        action();
        holdInterval = setInterval(action, 120);
      }, 280);
      document.addEventListener("mouseup", clearHold);
      document.addEventListener("mouseleave", clearHold);
    };
    button.addEventListener("mousedown", startHold);
    button.addEventListener("mouseup", clearHold);
    button.addEventListener("mouseleave", clearHold);
    button.addEventListener("blur", clearHold);
  }

  lockRemixAlbum(album, folderName) {
    if (!album?.id_albumu || !folderName) return;
    this.getRemixLockedSet(folderName).add(album.id_albumu);
    this.refreshRemixSlotDisplays();
  }

  unlockRemixAlbum(album, folderName) {
    if (!album?.id_albumu || !folderName) return;
    const set = this.getRemixLockedSet(folderName);
    set.delete(album.id_albumu);
    if (set.size === 0) {
      this.uiState.remixLocked.delete(folderName);
    }
    this.refreshRemixSlotDisplays();
  }

  getRemixFolderForAlbum(album) {
    if (!album) return null;
    const albumFolders = this.store.getAlbumFolderList(album);
    if (!albumFolders.length) return null;
    const remixFolders = this.uiState.remixSlots
      .filter((slot, index) => slot.enabled !== false && this.isRemixSlotPageEnabled(index))
      .map((slot) => slot.folder)
      .filter(Boolean);
    return albumFolders.find((folder) => remixFolders.includes(folder)) || albumFolders[0] || null;
  }

  toggleRemixSlotEnabled(index, enabled) {
    const slot = this.uiState.remixSlots[index];
    if (!slot) return;
    const next = Boolean(enabled);
    if (slot.enabled === next) return;
    slot.enabled = next;
    this.refreshRemixSlotDisplays();
    if (this.uiState.remixEnabled) {
      this.resetCurrentPage();
      this.processAndRender();
    }
  }

  setRemixEnabled(enabled, { silent = false, skipRender = false } = {}) {
    const next = Boolean(enabled);
    const stateChanged = this.uiState.remixEnabled !== next;
    this.uiState.remixEnabled = next;
    if (this.dom.remixToggleInput) {
      this.dom.remixToggleInput.checked = next;
      this.updateSwitchLabels(
        this.dom.remixToggleInput,
        this.dom.remixToggleLabels?.left,
        this.dom.remixToggleLabels?.right
      );
    }
    this.updateRemixModeUi();
    this.updateFilterTabIndicators();
    if (!silent && stateChanged) {
      this.showRemixStatus(
        next ? "Aktywowano tryb REMIX." : "Deaktywowano tryb REMIX.",
        next ? "on" : "off"
      );
    }
    if (!skipRender && stateChanged) {
      this.resetCurrentPage();
      this.processAndRender();
    }
  }

  updateRemixModeUi() {
    const disable = this.uiState.remixEnabled;
    if (this.dom.filterTabsContent) {
      this.dom.filterTabsContent.querySelectorAll(".filter-tab__panel").forEach((panel) => {
        if (panel.dataset.tab === "remix") {
          panel.classList.remove("is-disabled");
        } else {
          panel.classList.toggle("is-disabled", disable);
        }
      });
    }
    if (this.dom.containerSelect) {
      this.dom.containerSelect.disabled = disable;
    }
    if (this.dom.folderSelect) {
      this.dom.folderSelect.disabled = disable;
    }
  }

  showRemixStatus(message, variant = "on", duration = 3000) {
    const { fileStatus } = this.dom;
    if (!fileStatus || !message) return;
    if (this.uiState.operationInProgress) return;
    clearTimeout(this.uiState.statusTimeout);
    this.uiState.statusTimeout = null;
    fileStatus.classList.remove("status-success", "status-updated", "busy");
    fileStatus.classList.remove("status-error");
    fileStatus.classList.remove("status-remix-on", "status-remix-off", "status-remix-warning");
    const className =
      variant === "off" ? "status-remix-off" : variant === "warning" ? "status-remix-warning" : "status-remix-on";
    fileStatus.classList.add(className);
    fileStatus.classList.remove("hidden");
    fileStatus.textContent = message;
    this.uiState.statusTimeout = setTimeout(() => {
      fileStatus.classList.remove(className);
      this.refreshFileStatus();
    }, duration);
  }

  async bootstrapDataPaths() {
    try {
      this.uiState.appDirectory = await getAppDirectory();
    } catch (error) {
      console.warn("Nie udało się ustalić katalogu aplikacji:", error);
      }
    try {
      await this.loadFormatOptions();
    } catch (error) {
      console.warn("Nie udało się wczytać listy formatów:", error);
    } finally {
      this.updateAllDataDirectoryHints();
    }
  }

  parseFormatOptions(contents = "") {
    const options = [];
    const lookup = { byCode: new Map(), byLabel: new Map() };
    String(contents)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => {
        const parts = line.split(" - ");
        if (parts.length < 2) return;
        const code = parts.shift()?.trim() || "";
        const label = parts.join(" - ").trim();
        if (!code || !label) return;
        const entry = { code, label, full: `${code} - ${label}` };
        options.push(entry);
        lookup.byCode.set(code, label);
        lookup.byLabel.set(label, code);
      });
    return { options, lookup };
  }

  async loadFormatOptions() {
    const appDirectory = await this.ensureAppDirectory();
    if (!appDirectory) return;
    const filePath = buildPath(appDirectory, "format.txt");
    const contents = await readTextFile(filePath);
    const parsed = this.parseFormatOptions(contents);
    this.uiState.formatOptions = parsed.options;
    this.uiState.formatLookup = parsed.lookup;
  }

  resolveFormatLabel(value = "") {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const { byCode, byLabel } = this.uiState.formatLookup || {};
    if (byLabel?.has(raw)) return raw;
    if (byCode?.has(raw)) return byCode.get(raw) || "";
    const codeMatch = raw.match(/^(\d{1,3})\s*-\s*(.+)$/);
    if (codeMatch) {
      const code = codeMatch[1];
      const label = codeMatch[2].trim();
      if (byCode?.has(code)) return byCode.get(code) || label;
      return label;
    }
    return raw;
  }

  resolveFormatCode(label = "") {
    const { byLabel } = this.uiState.formatLookup || {};
    return byLabel?.get(label) || "";
  }

  getOperationMode(operationKey) {
    return this.uiState.dataPaths?.[operationKey]?.mode || "AUTO";
  }

  getOperationState(operationKey) {
    return this.uiState.dataPaths?.[operationKey] || { mode: "AUTO", manualDirectory: "" };
  }

  getDefaultDirectory(operationKey) {
    const segments = DATA_DIRECTORIES[operationKey] || [];
    const basePath = this.uiState.appDirectory || "";
    return buildPath(basePath, ...segments);
  }

  updateDataDirectoryHint(operationKey) {
    const hint = this.dom.dataDirectoryHints?.[operationKey];
    const toggle = this.dom.dataModeToggles?.[operationKey];
    const labels = this.dom.dataModeLabels?.[operationKey];
    if (!hint) return;

    const mode = this.getOperationMode(operationKey);
    const state = this.getOperationState(operationKey);
    const defaultPath = this.getDefaultDirectory(operationKey);
    const manualPath = state.manualDirectory;
    const defaultLabel = defaultPath || "brak";
    const manualLabel = manualPath || "brak";
    const currentLabel = mode === "AUTO" ? defaultLabel : manualLabel;
    hint.innerHTML = "";

    const currentRow = document.createElement("div");
    currentRow.className = "data-mode-hint__row";
    const currentSpan = document.createElement("span");
    currentSpan.textContent = currentLabel;
    currentRow.appendChild(currentSpan);

    hint.appendChild(currentRow);
    this.updateSwitchLabels(toggle, labels?.left, labels?.right);
  }

  updateAllDataDirectoryHints() {
    Object.keys(DATA_DIRECTORIES).forEach((operationKey) => this.updateDataDirectoryHint(operationKey));
  }

  async handleDataModeToggle(operationKey) {
    const toggle = this.dom.dataModeToggles?.[operationKey];
    const labels = this.dom.dataModeLabels?.[operationKey];
    const state = this.getOperationState(operationKey);
    const useAuto = toggle ? toggle.checked : true;
    state.mode = useAuto ? "AUTO" : "MANUAL";
    if (!useAuto) {
      const chosen = await this.pickManualDirectory(state.manualDirectory);
      if (!chosen) {
        state.mode = "AUTO";
        if (toggle) toggle.checked = true;
      } else {
        state.manualDirectory = chosen;
      }
    }
    this.updateSwitchLabels(toggle, labels?.left, labels?.right);
    this.updateDataDirectoryHint(operationKey);
  }

  async pickManualDirectory(defaultPath = "") {
    try {
      const selected = await selectDirectory({ defaultPath });
      if (selected) {
        return selected;
      }
    } catch (error) {
      this.showStatusMessage(error.message || error);
    }
    return null;
  }

  async getActiveDataDirectory(operationKey) {
    const state = this.getOperationState(operationKey);
    if (this.getOperationMode(operationKey) === "AUTO") {
      if (!this.uiState.appDirectory) {
        try {
          this.uiState.appDirectory = await getAppDirectory();
        } catch (error) {
          console.warn("Nie udało się pobrać ścieżki aplikacji:", error);
        }
      }
      return this.getDefaultDirectory(operationKey);
    }

    if (state.manualDirectory) return state.manualDirectory;
    const picked = await this.pickManualDirectory();
    if (picked) {
      state.manualDirectory = picked;
      this.updateDataDirectoryHint(operationKey);
      return picked;
    }
    this.showStatusMessage("Wybierz folder dla operacji importu/eksportu.");
    return null;
  }

  createSectionTitle(title) {
    const el = document.createElement("div");
    el.className = "filter-section__title";
    el.textContent = title;
    return el;
  }

  createActionsRow(actions = []) {
    const wrapper = document.createElement("div");
    wrapper.className = "filter-actions";
    actions.forEach(({ label, handler }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "option-chip option-chip--action";
      btn.textContent = label;
      btn.addEventListener("click", () => handler?.());
      wrapper.appendChild(btn);
    });
    return wrapper;
  }

  setCycleButtonValue(button, value, options) {
    if (!button) return;
    if (typeof button.setValue === "function") {
      button.setValue(value, options);
    } else {
      button.value = value;
    }
  }

  setYearControlValue(control, value, options) {
    if (!control || typeof control.setValue !== "function") return;
    control.setValue(value, options);
  }

  createSwitch({ id, leftLabel, rightLabel, defaultRight = true, compact = false } = {}) {
    const wrapper = document.createElement("div");
    wrapper.className = "toggle-wrapper";

    const left = document.createElement("span");
    left.className = "toggle-label";
    left.textContent = leftLabel;

    const label = document.createElement("label");
    label.className = `switch${compact ? " switch--compact" : ""}`;

    const input = document.createElement("input");
    input.type = "checkbox";
    if (id) input.id = id;
    input.checked = defaultRight;
    const slider = document.createElement("span");
    slider.className = "slider";
    label.appendChild(input);
    label.appendChild(slider);

    const right = document.createElement("span");
    right.className = "toggle-label";
    right.textContent = rightLabel;

    wrapper.appendChild(left);
    wrapper.appendChild(label);
    wrapper.appendChild(right);

    return { wrapper, input, leftLabel: left, rightLabel: right };
  }

  updateSwitchLabels(input, leftEl, rightEl) {
    if (!input || !leftEl || !rightEl) return;
    const rightActive = Boolean(input.checked);
    leftEl.classList.toggle("muted", rightActive);
    rightEl.classList.toggle("muted", !rightActive);
  }

  setRatingVisibility(nextValue) {
    const isVisible = Boolean(nextValue);
    this.uiState.showRatings = isVisible;
    document.body.classList.toggle("show-ratings", isVisible);
    const toggle = this.dom.ratingToggleInput;
    const labels = this.dom.ratingToggleLabels;
    if (toggle) {
      toggle.checked = isVisible;
      this.updateSwitchLabels(toggle, labels?.left, labels?.right);
    }
  }

  formatTimestampForFileName(date = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}_${pad(date.getHours())}-${pad(
      date.getMinutes()
    )}-${pad(date.getSeconds())}`;
  }

  buildTimestampedFileName(prefix, extension = "xlsx") {
    return `${prefix}_${this.formatTimestampForFileName()}.${extension}`;
  }

  buildFilterFolderName(date = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    return `FILTR_${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}-${pad(
      date.getHours()
    )}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  }

  async selectDataFile(defaultPath = "") {
    try {
      return await selectFile({
        defaultPath,
        filters: [{ name: "Arkusze Excel", extensions: ["xlsx"] }]
      });
    } catch (error) {
      this.showStatusMessage(error.message || error);
      return null;
    }
  }

  async selectJsonFile(defaultPath = "") {
    try {
      return await selectFile({
        defaultPath,
        filters: [{ name: "Pliki JSON", extensions: ["json"] }]
      });
    } catch (error) {
      this.showStatusMessage(error.message || error);
      return null;
    }
  }

  async resolveImportSource({ operationKey, prefix }) {
    const directory = await this.getActiveDataDirectory(operationKey);
    if (!directory) return null;

    const useManual = this.getOperationMode(operationKey) === "MANUAL";
    let chosenPath = null;
    if (useManual) {
      chosenPath = await this.selectDataFile(directory);
      if (!chosenPath) return null;
    }

    const resolved = await resolveImportFile({
      directory,
      filePath: chosenPath,
      prefix
    });

    return { directory, filePath: resolved.filePath, fileName: resolved.fileName };
  }

  createFilterChip({ value, label, selectionSet, onChange, prefix = null }) {
    const wrapper = document.createElement("label");
    wrapper.className = "filter-chip filter-chip--selection";

    const text = document.createElement("span");
    text.textContent = label;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = value;
    checkbox.checked = selectionSet.has(value);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectionSet.add(value);
      else selectionSet.delete(value);
      onChange?.();
    });
    
    if (prefix) wrapper.appendChild(prefix);
    wrapper.appendChild(text);
    wrapper.appendChild(checkbox);
    return wrapper;
  }

  applyBulkSelection(container, targetSet, shouldSelect) {
    const inputs = container.querySelectorAll("input[type=checkbox]");
    inputs.forEach((cb) => {
      cb.checked = shouldSelect;
      const value = cb.value;
      if (!value || value === "on") return;
      if (shouldSelect) targetSet.add(value);
      else targetSet.delete(value);
    });
    targetSet.delete("on");
    if (this.dom.showFavoritesInput && container.contains(this.dom.showFavoritesInput)) {
      this.uiState.showFavorites = this.dom.showFavoritesInput.checked;
    }
    this.processAndRender();
  }

  selectOnlyLabel(labelName) {
    const target = String(labelName || "").trim();
    if (!target || !LABEL_MAP.has(target)) return;
    this.uiState.selectedLabels.clear();
    this.uiState.selectedLabels.add(target);
    this.store.setLabelSelection(this.uiState.selectedLabels);
    const filterPanel = this.dom.filterPanel;
    if (filterPanel) {
      filterPanel.querySelectorAll('.filter-chip--selection input[type="checkbox"]').forEach((cb) => {
        if (cb.value === target) {
          cb.checked = true;
        } else if (LABEL_MAP.has(cb.value)) {
          cb.checked = false;
        }
      });
    }
    this.processAndRender();
  }

  updateHeardRangeDisplay() {
    const { min, max } = this.uiState.heardRange;
    if (this.dom.heardMinDisplay) {
      this.dom.heardMinDisplay.value = Number.isInteger(min) ? min.toString() : "A";
    }
    if (this.dom.heardMaxDisplay) {
      this.dom.heardMaxDisplay.value = Number.isInteger(max) ? max.toString() : "A";
    }
  }

  applyHeardInput(boundary, rawValue) {
    const trimmed = String(rawValue || "").trim();
    let nextValue = null;
    if (trimmed && trimmed.toUpperCase() !== "A") {
      const parsed = Number.parseInt(trimmed.replace(/[^\d-]/g, ""), 10);
      if (Number.isNaN(parsed) || parsed < 0 || parsed > 999) {
        this.showStatusMessage("Wprowadzono nieprawidłową wartość.");
        this.updateHeardRangeDisplay();
        return;
      }
      nextValue = parsed;
    }
    this.uiState.heardRange = {
      ...this.uiState.heardRange,
      [boundary]: nextValue
    };
    this.normalizeHeardRange();
    this.resetCurrentPage();
    this.updateHeardRangeDisplay();
    this.processAndRender();
  }

  computeNextHeardValue(current, direction) {
    let next = current;
    if (direction < 0) {
      if (current === null) next = 0;
      else if (current === 0) next = 0;
      else if (current === 1) next = null;
      else if (current > 1) next = current - 1;
    } else if (direction > 0) {
      if (current === 0) next = null;
      else if (current === null) next = 1;
      else if (current >= 1 && current < 999) next = current + 1;
      else next = 999;
    }
    return next;
  }

  normalizeHeardRange() {
    const { min, max } = this.uiState.heardRange;
    if (min !== null && max !== null && min > max) {
      this.uiState.heardRange = { min: max, max: min };
    }
  }

  shiftHeardRange(boundary, direction) {
    const current = Number.isInteger(this.uiState.heardRange[boundary]) ? this.uiState.heardRange[boundary] : null;
    const next = this.computeNextHeardValue(current, direction);
    if (next === current) return;
    this.uiState.heardRange = {
      ...this.uiState.heardRange,
      [boundary]: next
    };
    this.normalizeHeardRange();
    this.resetCurrentPage();
    this.updateHeardRangeDisplay();
    this.processAndRender();
  }

  resetHeardRange() {
    this.uiState.heardRange = { min: null, max: null };
    this.updateHeardRangeDisplay();
  }

  setTimeSortMode(mode) {
    const next = this.uiState.sortMode === mode ? "release_desc" : mode;
    if (this.uiState.sortMode !== next) {
      this.uiState.sortMode = next;
      this.store.setSortMode(next);
      this.resetCurrentPage();
      this.renderAlbumsPage();
    }
    this.updateTimeSortButtons();
    this.updateFilterTabIndicators();
  }

  updateTimeSortButtons() {
    const { sortDurationAscBtn, sortDurationDescBtn, sortReleaseAscBtn, sortReleaseDescBtn } = this.dom;
    const active = this.uiState.sortMode;
    if (sortDurationAscBtn) {
      sortDurationAscBtn.checked = active === "duration_asc";
    }
    if (sortDurationDescBtn) {
      sortDurationDescBtn.checked = active === "duration_desc";
    }
    if (sortReleaseDescBtn) {
      sortReleaseDescBtn.checked = active === "release_desc";
    }
    if (sortReleaseAscBtn) {
      sortReleaseAscBtn.checked = active === "release_asc";
    }
  }

  resetTimeFiltersAndRender() {
    const isHeardDefault = this.uiState.heardRange.min === null && this.uiState.heardRange.max === null;
    const isDurationDefault = this.uiState.durationRange.min === null && this.uiState.durationRange.max === null;
    const isSortDefault = this.uiState.sortMode === "release_desc";
    if (isHeardDefault && isDurationDefault && isSortDefault) return;
    this.resetHeardRange();
    this.uiState.durationRange = { min: null, max: null };
    this.uiState.sortMode = "release_desc";
    this.store.setSortMode("release_desc");
    if (this.dom.durationRangeMinInput) this.dom.durationRangeMinInput.value = "";
    if (this.dom.durationRangeMaxInput) this.dom.durationRangeMaxInput.value = "";
    this.updateTimeSortButtons();
    this.resetCurrentPage();
    this.processAndRender();
  }

  updateDurationRange() {
    const { durationRangeMinInput, durationRangeMaxInput } = this.dom;
    const parseValue = (input) => {
      if (!input) return null;
      const raw = input.value.trim();
      if (!raw) return null;
      const num = Number(raw);
      return Number.isFinite(num) && num >= 0 ? Math.floor(num) : null;
    };
    let minVal = parseValue(durationRangeMinInput);
    let maxVal = parseValue(durationRangeMaxInput);
    if (minVal !== null && maxVal !== null && minVal > maxVal) {
      [minVal, maxVal] = [maxVal, minVal];
      if (durationRangeMinInput) durationRangeMinInput.value = String(minVal);
      if (durationRangeMaxInput) durationRangeMaxInput.value = String(maxVal);
    }
    this.uiState.durationRange = { min: minVal, max: maxVal };
    this.resetCurrentPage();
    this.processAndRender();
  }

  adjustDurationRangeInput(input, delta) {
    if (!input) return;
    const current = Number.parseInt(input.value || "0", 10);
    const safeCurrent = Number.isNaN(current) ? 0 : current;
    const nextValue = Math.max(0, safeCurrent + delta);
    input.value = String(nextValue);
    this.updateDurationRange();
  }

  resetDurationRangeAndRender() {
    if (this.dom.durationRangeMinInput) this.dom.durationRangeMinInput.value = "";
    if (this.dom.durationRangeMaxInput) this.dom.durationRangeMaxInput.value = "";
    this.uiState.durationRange = { min: null, max: null };
    this.resetCurrentPage();
    this.processAndRender();
  }

  isLabelsDefault() {
    if (this.uiState.selectedLabels.size !== LABEL_MAP.size) return false;
    for (const label of LABEL_MAP.keys()) {
      if (!this.uiState.selectedLabels.has(label)) return false;
    }
    return true;
  }

  isSelectorDefault() {
    if (!this.uiState.showFavorites) return false;
    if (this.uiState.selectedSelectors.size !== SELECTOR_VALUES.length) return false;
    return SELECTOR_VALUES.every((value) => this.uiState.selectedSelectors.has(value));
  }

  isSearchDefault() {
    const { releaseMonthFrom, releaseYearFrom, releaseMonthTo, releaseYearTo, searchInput } = this.dom;
    if (searchInput?.value?.trim()) return false;
    const isAll = (select) => !select || select.value === "__all__";
    return (
      isAll(releaseYearFrom) &&
      isAll(releaseMonthFrom) &&
      isAll(releaseYearTo) &&
      isAll(releaseMonthTo) &&
      this.uiState.skipFolderFiltering &&
      this.uiState.foldersRefreshMode === "AUTO"
    );
  }

  isTimeDefault() {
    return (
      this.uiState.heardRange.min === null &&
      this.uiState.heardRange.max === null &&
      this.uiState.sortMode === "release_desc" &&
      this.uiState.durationRange.min === null &&
      this.uiState.durationRange.max === null
    );
  }

  isAnyFilterActive() {
    return (
      !this.isLabelsDefault() ||
      !this.isSelectorDefault() ||
      !this.isSearchDefault() ||
      !this.isTimeDefault()
    );
  }

  updateFilterTabIndicators() {
    const indicators = this.dom.filterTabIndicators;
    const state = {
      remix: this.uiState.remixEnabled,
      label: !this.isLabelsDefault(),
      selector: !this.isSelectorDefault(),
      search: !this.isSearchDefault(),
      time: !this.isTimeDefault()
    };
    if (indicators) {
      Object.entries(state).forEach(([key, active]) => {
        const dot = indicators.get(key);
        if (dot) dot.classList.toggle("active", active);
      });
    }
    const filterActive = this.uiState.remixEnabled || this.isAnyFilterActive();
    if (this.dom.filterBtnDot) {
      this.dom.filterBtnDot.classList.toggle("active", filterActive);
    }
    if (this.dom.filterClearBtn) {
      this.dom.filterClearBtn.classList.toggle("active", filterActive);
    }
  }

  clearAllFilters() {
  const { filterPanel, releaseMonthFrom, releaseMonthTo, searchInput } = this.dom;

    // NIE podmieniaj Setów (bo listenery chipów trzymają referencję do starych)
    this.uiState.selectedLabels.clear();
    for (const name of LABEL_MAP.keys()) this.uiState.selectedLabels.add(name);

    this.uiState.selectedSelectors.clear();
    for (const sel of SELECTOR_VALUES) this.uiState.selectedSelectors.add(sel);
    this.uiState.showFavorites = true;
    if (this.dom.showFavoritesInput) {
      this.dom.showFavoritesInput.checked = true;
    }

    this.resetHeardRange();
    this.uiState.sortMode = "release_desc";
    this.uiState.durationRange = { min: null, max: null };
    this.store.setSortMode("release_desc");
    this.updateTimeSortButtons();

    if (searchInput) searchInput.value = "";
    this.hideSuggestions(this.dom.searchSuggestions);
    this.setYearControlValue(this.dom.releaseYearFromControl, "__all__", { silent: true });
    this.setCycleButtonValue(releaseMonthFrom, "__all__", { silent: true });
    this.setYearControlValue(this.dom.releaseYearToControl, "__all__", { silent: true });
    this.setCycleButtonValue(releaseMonthTo, "__all__", { silent: true });
    if (this.dom.durationRangeMinInput) this.dom.durationRangeMinInput.value = "";
    if (this.dom.durationRangeMaxInput) this.dom.durationRangeMaxInput.value = "";
    this.uiState.skipFolderFiltering = true;
    if (this.dom.skipFolderFilteringInput) {
      this.dom.skipFolderFilteringInput.checked = true;
      this.updateSwitchLabels(
        this.dom.skipFolderFilteringInput,
        this.dom.skipFolderFilteringLabels?.left,
        this.dom.skipFolderFilteringLabels?.right
      );
    }
    this.toggleFoldersRefreshMode(true);
    if (this.dom.foldersRefreshModeInput) {
      this.dom.foldersRefreshModeInput.checked = true;
      this.updateSwitchLabels(
        this.dom.foldersRefreshModeInput,
        this.dom.foldersRefreshModeLabels?.left,
        this.dom.foldersRefreshModeLabels?.right
      );
    }
    this.setRemixEnabled(false, { silent: true, skipRender: true });
    this.setActiveFilterPreset("__none__", { silent: true });

    if (filterPanel) {
      filterPanel.querySelectorAll('.filter-chip--selection input[type="checkbox"]').forEach((cb) => {
        const shouldCheck =
          cb === this.dom.showFavoritesInput ||
          this.uiState.selectedSelectors.has(cb.value) ||
          this.uiState.selectedLabels.has(cb.value);
        cb.checked = shouldCheck;
      });
    }

    this.resetCurrentPage();
    this.processAndRender();
  }

  async loadFilterPresets() {
    try {
      const presets = await fetchFilterPresets();
      this.uiState.filterPresets = Array.isArray(presets) ? presets : [];
    } catch (error) {
      console.warn("Nie udało się wczytać zapisanych filtrów:", error);
      this.uiState.filterPresets = [];
    }
    this.updateFilterPresetOptions();
    this.applyStoredFilterPresetOnce();
  }

  updateFilterPresetOptions() {
    const select = this.dom.filterPresetSelect;
    if (!select) return;
    select.innerHTML = "";
    const defaultOption = document.createElement("option");
    defaultOption.value = "__none__";
    defaultOption.textContent = "brak filtrowania";
    defaultOption.title = "brak filtrowania";
    select.appendChild(defaultOption);
    this.uiState.filterPresets.forEach((preset) => {
      const option = document.createElement("option");
      option.value = preset.name;
      option.textContent = preset.name;
      option.title = preset.name;
      select.appendChild(option);
    });
    const available = new Set([
      "__none__",
      ...this.uiState.filterPresets.map((preset) => preset.name)
    ]);
    if (!available.has(this.uiState.activeFilterPreset)) {
      this.uiState.activeFilterPreset = "__none__";
    }
    this.setActiveFilterPreset(this.uiState.activeFilterPreset, { silent: true });
  }

  setActiveFilterPreset(name, { silent = false } = {}) {
    this.uiState.activeFilterPreset = name || "__none__";
    if (this.dom.filterPresetSelect) {
      this.dom.filterPresetSelect.value = this.uiState.activeFilterPreset;
      const selectedLabel =
        this.uiState.activeFilterPreset === "__none__" ? "brak filtrowania" : this.uiState.activeFilterPreset;
      this.dom.filterPresetSelect.title = selectedLabel;
    }
    const disablePresetActions = this.uiState.activeFilterPreset === "__none__";
    if (this.dom.filterPresetEditBtn) {
      this.dom.filterPresetEditBtn.disabled = disablePresetActions;
    }
    if (this.dom.filterPresetDeleteBtn) {
      this.dom.filterPresetDeleteBtn.disabled = disablePresetActions;
    }
    if (this.dom.filterPresetCopyBtn) {
      this.dom.filterPresetCopyBtn.disabled = disablePresetActions;
    }
    if (!silent) {
      this.updateFilterTabIndicators();
    }
  }

  readStoredFilterPreset() {
    try {
      return localStorage.getItem("qobuzActiveFilterPreset") || "__none__";
    } catch (error) {
      console.warn("Nie udało się odczytać zapisanego filtra:", error);
      return "__none__";
    }
  }

  persistActiveFilterPreset() {
    const value = this.uiState.activeFilterPreset || "__none__";
    this.uiState.storedFilterPreset = value;
    try {
      localStorage.setItem("qobuzActiveFilterPreset", value);
    } catch (error) {
      console.warn("Nie udało się zapisać aktywnego filtra:", error);
    }
  }

  readStoredRemixState() {
    try {
      const raw = localStorage.getItem("qobuzRemixState");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const slots = Array.isArray(parsed?.slots) ? parsed.slots : [];
      const normalizedSlots = Array.from({ length: this.remixTotalSlots }, (_, index) => {
        const slot = slots[index] || {};
          const mode = slot.mode === "count" ? "count" : "percent";
          const countValue = Number(slot.count);
          return {
            folder: typeof slot.folder === "string" ? slot.folder : "",
            percent: Number.isFinite(slot.percent) ? Math.min(100, Math.max(1, slot.percent)) : 100,
            mode,
            count: Number.isFinite(countValue) ? Math.max(0, Math.round(countValue)) : null,
            enabled: slot.enabled !== false
          };
        });
      return {
        enabled: parsed?.enabled === true,
        slots: normalizedSlots,
        pages: this.normalizeRemixPages(parsed?.pages)
      };
    } catch (error) {
      console.warn("Nie udało się odczytać trybu REMIX:", error);
      return null;
    }
  }

  persistRemixState() {
    const payload = {
      enabled: this.uiState.remixEnabled,
      slots: this.uiState.remixSlots.map((slot) => ({
        folder: slot.folder || "",
        percent: Number.isFinite(slot.percent) ? slot.percent : 100,
        mode: slot.mode === "count" ? "count" : "percent",
        count: Number.isFinite(slot.count) ? slot.count : null,
        enabled: slot.enabled !== false
      })),
      pages: Array.from(this.uiState.remixPagesEnabled || []).map((value) => value !== false)
    };
    try {
      localStorage.setItem("qobuzRemixState", JSON.stringify(payload));
    } catch (error) {
      console.warn("Nie udało się zapisać trybu REMIX:", error);
    }
  }

  readStoredSelections() {
    try {
      const raw = localStorage.getItem("qobuzStoredSelections");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const pageByCategory = parsed?.pageByCategory || {};
      return {
        collection: parsed?.collection || "__all__",
        container: parsed?.container || "__all__",
        folder: parsed?.folder || "__all__",
        currentCategory: parsed?.currentCategory || "DB",
        pageByCategory: {
          DB: Number(pageByCategory.DB) || 0,
          NR: Number(pageByCategory.NR) || 0,
          FD: Number(pageByCategory.FD) || 0
        }
      };
    } catch (error) {
      console.warn("Nie udało się odczytać zapisanych wyborów:", error);
      return null;
    }
  }

  readStoredRatingState() {
    try {
      const raw = localStorage.getItem("qobuzRatingVisibility");
      if (!raw) return false;
      return JSON.parse(raw) === true;
    } catch (error) {
      console.warn("Nie udało się odczytać zapisu RATING:", error);
      return false;
    }
  }

  persistRatingState() {
    try {
      localStorage.setItem("qobuzRatingVisibility", JSON.stringify(this.uiState.showRatings === true));
    } catch (error) {
      console.warn("Nie udało się zapisać ustawień RATING:", error);
    }
  }

  persistStoredSelections() {
    const payload = {
      collection: this.uiState.activeCollection || "__all__",
      container: this.dom.containerSelect?.value || "__all__",
      folder: this.dom.folderSelect?.value || "__all__",
      currentCategory: this.uiState.currentCategory || "DB",
      pageByCategory: this.uiState.pageByCategory || {}
    };
    this.uiState.storedSelections = payload;
    try {
      localStorage.setItem("qobuzStoredSelections", JSON.stringify(payload));
    } catch (error) {
      console.warn("Nie udało się zapisać wyborów:", error);
    }
  }

  applyStoredSelectionsOnce() {
    if (this.uiState.storedSelectionsApplied) return false;
    const stored = this.uiState.storedSelections;
    if (!stored) return false;
    this.uiState.storedSelectionsApplied = true;
    if (stored.pageByCategory) {
      this.uiState.pageByCategory = {
        DB: Number(stored.pageByCategory.DB) || 0,
        NR: Number(stored.pageByCategory.NR) || 0,
        FD: Number(stored.pageByCategory.FD) || 0
      };
    }
    if (stored.currentCategory) {
      this.uiState.currentCategory = stored.currentCategory;
      document.body.classList.remove(...Object.values(CATEGORY_CLASSES));
      const className = this.store.getCategoryClass(this.uiState.currentCategory);
      if (className) document.body.classList.add(className);
    }
    let collection = stored.collection || "__all__";
    if (collection !== "__all__" && !this.store.collectionsList.has(collection)) {
      collection = "__all__";
    }
    this.uiState.activeCollection = collection;
    this.rebuildCollectionSelect();

    this.rebuildContainerSelect();
    if (this.dom.containerSelect) {
      const desiredContainer = stored.container;
      const containerOption = Array.from(this.dom.containerSelect.options).some(
        (opt) => opt.value === desiredContainer
      );
      this.dom.containerSelect.value = containerOption ? desiredContainer : "__all__";
    }

    this.rebuildFolderSelect();
    if (this.dom.folderSelect) {
      const desiredFolder = stored.folder;
      const folderOption = Array.from(this.dom.folderSelect.options).some((opt) => opt.value === desiredFolder);
      this.dom.folderSelect.value = folderOption ? desiredFolder : "__all__";
    }
    this.updateNavActive(this.uiState.currentCategory);
    this.setCurrentPage(this.getStoredPage(this.uiState.currentCategory));
    return true;
  }

  applyStoredFilterPresetOnce() {
    if (this.uiState.storedFilterPresetApplied) return;
    this.uiState.storedFilterPresetApplied = true;
    const stored = this.uiState.storedFilterPreset || "__none__";
    if (stored === "__none__") {
      this.setActiveFilterPreset("__none__", { silent: true });
      return;
    }
    const preset = this.uiState.filterPresets.find((item) => item.name === stored);
    if (preset) {
      this.applyFilterPreset(preset);
    } else {
      this.setActiveFilterPreset("__none__", { silent: true });
    }
  }

  serializeRemixLocked() {
    const entries = [];
    this.uiState.remixLocked?.forEach((set, folder) => {
      if (!folder || !set || set.size === 0) return;
      const albums = Array.from(set).filter((value) => Number.isFinite(Number(value)));
      if (!albums.length) return;
      entries.push({ folder, albums });
    });
    return entries;
  }

  serializeCurrentFilters() {
    const { releaseMonthFrom, releaseYearFrom, releaseMonthTo, releaseYearTo, searchInput } = this.dom;
    return {
      labels: Array.from(this.uiState.selectedLabels),
      selectors: Array.from(this.uiState.selectedSelectors),
      searchTerm: searchInput?.value || "",
      releaseYearFrom: releaseYearFrom?.value || "__all__",
      releaseMonthFrom: releaseMonthFrom?.value || "__all__",
      releaseYearTo: releaseYearTo?.value || "__all__",
      releaseMonthTo: releaseMonthTo?.value || "__all__",
      heardMin: this.uiState.heardRange.min,
      heardMax: this.uiState.heardRange.max,
      durationMin: this.uiState.durationRange.min,
      durationMax: this.uiState.durationRange.max,
      sortMode: this.uiState.sortMode,
      showFavorites: this.uiState.showFavorites,
      containerFilter: this.dom.containerSelect?.value || "__all__",
      folderFilter: this.dom.folderSelect?.value || "__all__",
      currentPage: this.uiState.currentPage,
      skipFolderFiltering: this.uiState.skipFolderFiltering,
      foldersRefreshMode: this.uiState.foldersRefreshMode,
      remixEnabled: this.uiState.remixEnabled,
      remixPagesEnabled: Array.from(this.uiState.remixPagesEnabled || []),
      remixSlots: this.uiState.remixSlots.map((slot) => ({
        folder: slot.folder || "",
        percent: Number.isFinite(slot.percent) ? slot.percent : 100,
        mode: slot.mode === "count" ? "count" : "percent",
        count: Number.isFinite(slot.count) ? slot.count : null,
        enabled: slot.enabled !== false
      })),
      remixLocked: this.serializeRemixLocked()
    };
  }

  promptForPresetName({ title, defaultValue = "" }) {
    return new Promise((resolve) => {
      document.querySelectorAll(".modal-overlay").forEach((el) => el.remove());
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";

      const card = document.createElement("div");
      card.className = "modal-card";

      const heading = document.createElement("h4");
      heading.className = "modal-title";
      heading.textContent = title;

      const input = document.createElement("input");
      const maxLength = 30;
      input.type = "text";
      input.className = "modal-input";
      input.maxLength = maxLength;
      input.value = (defaultValue || "").slice(0, maxLength);
      input.placeholder = "np. moje_filtry1";
      input.autocomplete = "off";
      input.spellcheck = false;

      const actions = document.createElement("div");
      actions.className = "modal-actions";

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "modal-btn modal-btn--cancel";
      cancelBtn.textContent = "ANULUJ";

      const confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className = "modal-btn modal-btn--confirm";
      confirmBtn.textContent = "ZAPISZ";

      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);

      card.appendChild(heading);
      card.appendChild(input);
      card.appendChild(actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      const cleanup = (value) => {
        overlay.remove();
        resolve(value);
      };

      cancelBtn.addEventListener("click", () => cleanup(null));
      confirmBtn.addEventListener("click", () => cleanup(input.value));
      input.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          cleanup(input.value);
        }
      });

      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
    });
  }

  infoModal({ title = "Informacja", message = "", confirmText = "OK" } = {}) {
    return new Promise((resolve) => {
      document.querySelectorAll(".modal-overlay").forEach((el) => el.remove());

      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";

      const card = document.createElement("div");
      card.className = "modal-card";

      const heading = document.createElement("h4");
      heading.className = "modal-title";
      heading.textContent = title;

      const body = document.createElement("div");
      body.className = "modal-body";
      body.textContent = message;

      const actions = document.createElement("div");
      actions.className = "modal-actions";

      const confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className = "modal-btn modal-btn--confirm";
      confirmBtn.textContent = confirmText;

      actions.appendChild(confirmBtn);

      card.appendChild(heading);
      card.appendChild(body);
      card.appendChild(actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      const cleanup = () => {
        overlay.remove();
        resolve(true);
      };

      confirmBtn.addEventListener("click", cleanup);

      const onKeyDown = (event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          cleanup();
        }
      };
      overlay.addEventListener("keydown", onKeyDown);
      confirmBtn.addEventListener("keydown", onKeyDown);

      setTimeout(() => {
        confirmBtn.focus();
      }, 0);
    });
  }

  confirmModal({ title = "Potwierdź", message = "", confirmText = "OK", cancelText = "ANULUJ" } = {}) {
    return new Promise((resolve) => {
      document.querySelectorAll(".modal-overlay").forEach((el) => el.remove());

      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";

      const card = document.createElement("div");
      card.className = "modal-card";

      const heading = document.createElement("h4");
      heading.className = "modal-title";
      heading.textContent = title;

      const body = document.createElement("div");
      body.className = "modal-body";
      body.textContent = message;

      const actions = document.createElement("div");
      actions.className = "modal-actions";

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "modal-btn modal-btn--cancel";
      cancelBtn.textContent = cancelText;

      const confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className = "modal-btn modal-btn--confirm";
      confirmBtn.textContent = confirmText;

      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);

      card.appendChild(heading);
      card.appendChild(body);
      card.appendChild(actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      const cleanup = (value) => {
        overlay.remove();
        resolve(value);
      };

      cancelBtn.addEventListener("click", () => cleanup(false));
      confirmBtn.addEventListener("click", () => cleanup(true));

      // Klawiatura: ENTER=potwierdź
      const onKeyDown = (event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          cleanup(true);
        }
      };
      overlay.addEventListener("keydown", onKeyDown);
      cancelBtn.addEventListener("keydown", onKeyDown);
      confirmBtn.addEventListener("keydown", onKeyDown);

      setTimeout(() => {
        // Focus na przycisk POTWIERDŹ – szybciej się klika Enterem.
        confirmBtn.focus();
      }, 0);
    });
  }

  openJsonImportDialog({ directory, filePath, fileName } = {}) {
    return new Promise((resolve) => {
      document.querySelectorAll(".modal-overlay").forEach((el) => el.remove());

      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";

      const card = document.createElement("div");
      card.className = "modal-card";

      const heading = document.createElement("h4");
      heading.className = "modal-title";
      heading.textContent = "Import JSON";

      const body = document.createElement("div");
      body.className = "modal-body";

      const fileInfo = document.createElement("div");
      fileInfo.className = "modal-body modal-body--info";
      const updateFileInfo = () => {
        fileInfo.textContent = fileName
          ? `Plik do importu: ${fileName}\nFolder: ${directory || "-"}`
          : "Nie wybrano pliku JSON.";
      };
      updateFileInfo();

      body.textContent = "Wskaż plik JSON do importu i potwierdź operację.";

      const actions = document.createElement("div");
      actions.className = "modal-actions modal-actions--stack";

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "modal-btn modal-btn--cancel";
      cancelBtn.textContent = "ANULUJ";

      const chooseBtn = document.createElement("button");
      chooseBtn.type = "button";
      chooseBtn.className = "modal-btn";
      chooseBtn.textContent = "WYBIERZ";

      const confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className = "modal-btn modal-btn--confirm";
      confirmBtn.textContent = "ZATWIERDŹ";

      actions.appendChild(cancelBtn);
      actions.appendChild(chooseBtn);
      actions.appendChild(confirmBtn);

      card.appendChild(heading);
      card.appendChild(body);
      card.appendChild(fileInfo);
      card.appendChild(actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      const cleanup = (value) => {
        overlay.remove();
        resolve(value);
      };

      cancelBtn.addEventListener("click", () => cleanup(null));
      chooseBtn.addEventListener("click", async () => {
        const selected = await this.selectJsonFile(directory || "");
        if (!selected) return;
        filePath = selected;
        fileName = selected.split(/[\\/]/).pop();
        updateFileInfo();
      });
      confirmBtn.addEventListener("click", () => {
        if (!filePath) {
          this.showStatusMessage("Najpierw wybierz plik JSON.");
          return;
        }
        cleanup({ filePath, fileName });
      });

      setTimeout(() => {
        confirmBtn.focus();
      }, 0);
    });
  }

  openImportProgressModal({ title = "Import danych", message = "" } = {}) {
    document.querySelectorAll(".modal-overlay").forEach((el) => el.remove());

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const card = document.createElement("div");
    card.className = "modal-card modal-card--progress";

    const heading = document.createElement("h4");
    heading.className = "modal-title";
    heading.textContent = title;

    const body = document.createElement("div");
    body.className = "modal-progress";

    const progressBar = document.createElement("div");
    progressBar.className = "modal-progress-bar";
    const progressFill = document.createElement("div");
    progressFill.className = "modal-progress-fill";
    progressBar.appendChild(progressFill);

    const progressLabel = document.createElement("div");
    progressLabel.className = "modal-progress-label";
    progressLabel.textContent = message;

    body.appendChild(progressBar);
    body.appendChild(progressLabel);
    card.appendChild(heading);
    card.appendChild(body);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    return {
      update: ({ current = 0, total = 0, message: nextMessage } = {}) => {
        const percent = total ? Math.min(100, Math.round((current / total) * 100)) : 0;
        progressFill.style.width = `${percent}%`;
        if (nextMessage) progressLabel.textContent = nextMessage;
      },
      close: () => overlay.remove()
    };
  }

  parseReleaseDateInput(value) {
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

  formatReleaseDateParts(value) {
    const timestamp = this.parseReleaseDateInput(value);
    if (!timestamp) {
      return { day: "", month: "", year: "" };
    }
    const date = new Date(timestamp * 1000);
    if (Number.isNaN(date.getTime())) {
      return { day: "", month: "", year: "" };
    }
    return {
      day: String(date.getDate()).padStart(2, "0"),
      month: String(date.getMonth() + 1).padStart(2, "0"),
      year: String(date.getFullYear())
    };
  }

  parseReleaseDateParts(day, month, year) {
    const dayValue = String(day || "").trim();
    const monthValue = String(month || "").trim();
    const yearValue = String(year || "").trim();
    if (!dayValue && !monthValue && !yearValue) return 0;
    const dayNum = Number.parseInt(dayValue, 10);
    const monthNum = Number.parseInt(monthValue, 10);
    const yearNum = Number.parseInt(yearValue, 10);
    if (
      !Number.isFinite(dayNum) ||
      !Number.isFinite(monthNum) ||
      !Number.isFinite(yearNum) ||
      yearNum < 1000 ||
      monthNum < 1 ||
      monthNum > 12 ||
      dayNum < 1 ||
      dayNum > 31
    ) {
      return 0;
    }
    const date = new Date(yearNum, monthNum - 1, dayNum);
    if (Number.isNaN(date.getTime())) return 0;
    if (
      date.getFullYear() !== yearNum ||
      date.getMonth() !== monthNum - 1 ||
      date.getDate() !== dayNum
    ) {
      return 0;
    }
    return Math.floor(date.getTime() / 1000);
  }

  formatDurationParts(value) {
    const total = Number(value);
    if (!Number.isFinite(total) || total <= 0) {
      return { hours: "", minutes: "", seconds: "" };
    }
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = Math.floor(total % 60);
    return {
      hours: String(hours).padStart(2, "0"),
      minutes: String(minutes).padStart(2, "0"),
      seconds: String(seconds).padStart(2, "0")
    };
  }

  parseDurationParts(hours, minutes, seconds) {
    const toNum = (value) => {
      const cleaned = String(value || "").trim();
      if (!cleaned) return 0;
      const parsed = Number.parseInt(cleaned, 10);
      return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    };
    const h = toNum(hours);
    const m = toNum(minutes);
    const s = toNum(seconds);
    if (!h && !m && !s) return 0;
    return h * 3600 + m * 60 + s;
  }

  buildRoonId(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 999999) return "";
    return String(Math.floor(numeric)).padStart(6, "0");
  }

  openEditAlbumDialog(album) {
    if (!album) return Promise.resolve(false);
    return new Promise((resolve) => {
      document.querySelectorAll(".modal-overlay").forEach((el) => el.remove());

      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";

      const card = document.createElement("div");
      card.className = "modal-card modal-card--wide";

      const heading = document.createElement("h4");
      heading.className = "modal-title";
      heading.textContent = "EDYCJA DANYCH";

      const form = document.createElement("div");
      form.className = "modal-form";

      const buildRow = (labelText, inputEl) => {
        const row = document.createElement("div");
        row.className = "modal-form-row";
        const label = document.createElement("label");
        label.className = "modal-form-label";
        label.textContent = labelText;
        row.appendChild(label);
        row.appendChild(inputEl);
        return row;
      };

      const createLockSpacer = () => {
        const spacer = document.createElement("span");
        spacer.className = "modal-lock-spacer";
        spacer.setAttribute("aria-hidden", "true");
        return spacer;
      };

      const createLockableInput = (value, { locked = true } = {}) => {
        const wrap = document.createElement("div");
        wrap.className = "modal-input-lock";
        const input = document.createElement("input");
        input.type = "text";
        input.className = "modal-input modal-input--row";
        input.value = value || "";

        const button = document.createElement("button");
        button.type = "button";
        button.className = "modal-lock-btn";
        button.setAttribute("aria-pressed", String(!locked));
        const icon = document.createElement("img");
        icon.alt = locked ? "Zablokowane" : "Odblokowane";
        button.appendChild(icon);

        const setLocked = (isLocked) => {
          input.readOnly = isLocked;
          input.classList.toggle("modal-input--locked", isLocked);
          icon.src = isLocked ? "icons/lock_icon_OFF.svg" : "icons/lock_icon_ON.svg";
          icon.alt = isLocked ? "Zablokowane" : "Odblokowane";
          button.setAttribute("aria-pressed", String(!isLocked));
          button.title = isLocked ? "Odblokuj pole" : "Zablokuj pole";
        };

        button.addEventListener("click", () => {
          setLocked(!input.readOnly);
          if (!input.readOnly) {
            input.focus();
            input.select();
          }
        });

        setLocked(locked);
        wrap.appendChild(input);
        wrap.appendChild(button);
        return { wrap, input, setLocked };
      };

      const createLockableSelect = (options = [], { locked = true, value = "" } = {}) => {
        const wrap = document.createElement("div");
        wrap.className = "modal-input-lock";
        const select = document.createElement("select");
        select.className = "modal-input modal-input--row";
        options.forEach(({ value: optionValue, label, selected }) => {
          const option = document.createElement("option");
          option.value = optionValue;
          option.textContent = label;
          if (selected) option.selected = true;
          select.appendChild(option);
        });
        if (value) select.value = value;

        const button = document.createElement("button");
        button.type = "button";
        button.className = "modal-lock-btn";
        button.setAttribute("aria-pressed", String(!locked));
        const icon = document.createElement("img");
        icon.alt = locked ? "Zablokowane" : "Odblokowane";
        button.appendChild(icon);

        const setLocked = (isLocked) => {
          select.disabled = isLocked;
          select.classList.toggle("modal-input--locked", isLocked);
          icon.src = isLocked ? "icons/lock_icon_OFF.svg" : "icons/lock_icon_ON.svg";
          icon.alt = isLocked ? "Zablokowane" : "Odblokowane";
          button.setAttribute("aria-pressed", String(!isLocked));
          button.title = isLocked ? "Odblokuj pole" : "Zablokuj pole";
        };

        button.addEventListener("click", () => {
          setLocked(!select.disabled);
          if (!select.disabled) {
            select.focus();
          }
        });

        setLocked(locked);
        wrap.appendChild(select);
        wrap.appendChild(button);
        return { wrap, select, setLocked };
      };

      const createReadOnlyInput = (value) => {
        const wrap = document.createElement("div");
        wrap.className = "modal-input-lock";
        const input = document.createElement("input");
        input.type = "text";
        input.className = "modal-input modal-input--row modal-input--locked modal-input--readonly";
        input.readOnly = true;
        input.value = value || "";
        wrap.appendChild(input);
        wrap.appendChild(createLockSpacer());
        return { wrap, input };
      };

      const buildSegmentedInput = ({ values = [], separator = ".", sizes = [] } = {}) => {
        const wrapper = document.createElement("div");
        wrapper.className = "modal-input-group";
        const inputs = values.map((value, index) => {
          const input = document.createElement("input");
          input.type = "text";
          input.inputMode = "numeric";
          input.className = "modal-input modal-input--segment";
          input.value = value || "";
          if (sizes[index]) input.maxLength = sizes[index];
          input.addEventListener("input", () => {
            const cleaned = input.value.replace(/\D/g, "");
            input.value = cleaned.slice(0, sizes[index] || cleaned.length);
          });
          wrapper.appendChild(input);
          if (index < values.length - 1) {
            const sep = document.createElement("span");
            sep.className = "modal-input-separator";
            sep.textContent = separator;
            wrapper.appendChild(sep);
          }
          return input;
        });
        return { wrapper, inputs };
      };

      const createLockableGroup = (group, { locked = true } = {}) => {
        const wrap = document.createElement("div");
        wrap.className = "modal-input-lock";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "modal-lock-btn";
        button.setAttribute("aria-pressed", String(!locked));
        const icon = document.createElement("img");
        icon.alt = locked ? "Zablokowane" : "Odblokowane";
        button.appendChild(icon);

      const setLocked = (isLocked) => {
          group.inputs.forEach((input) => {
            input.readOnly = isLocked;
            input.classList.toggle("modal-input--locked", isLocked);
          });
          icon.src = isLocked ? "icons/lock_icon_OFF.svg" : "icons/lock_icon_ON.svg";
          icon.alt = isLocked ? "Zablokowane" : "Odblokowane";
          button.setAttribute("aria-pressed", String(!isLocked));
          button.title = isLocked ? "Odblokuj pole" : "Zablokuj pole";
        };

      button.addEventListener("click", () => {
          const nextLocked = !group.inputs[0]?.readOnly;
          setLocked(nextLocked);
          if (!nextLocked) {
            group.inputs[0]?.focus();
            group.inputs[0]?.select();
          }
        });

      setLocked(locked);
        wrap.appendChild(group.wrapper);
        wrap.appendChild(button);
        return { wrap, setLocked };
      };

      const titleRaffaelloField = createLockableInput(album.title_raffaello || album.title || "", { locked: true });
      const artistRaffaelloField = createLockableInput(album.artist_raffaello || album.artist || "", { locked: true });
      const titleTidalField = createLockableInput(album.title_tidal || album.title || "", { locked: true });
      const artistTidalField = createLockableInput(album.artist_tidal || album.artist || "", { locked: true });
      const linkField = createLockableInput(album.link || "", { locked: true });
      const formatLabelValue = this.resolveFormatLabel(album.format || "");
      const formatOptions = [{ value: "", label: "00 - brak", selected: !formatLabelValue }];
      if (this.uiState.formatOptions.length) {
        this.uiState.formatOptions.forEach((entry) => {
          formatOptions.push({
            value: entry.full,
            label: entry.full,
            selected: entry.label === formatLabelValue
          });
        });
      }
      if (formatLabelValue && !formatOptions.some((option) => option.selected)) {
        formatOptions.push({ value: formatLabelValue, label: formatLabelValue, selected: true });
      }
      const formatField = createLockableSelect(formatOptions, { locked: true });
      const roonIdValue = String(album.roon_id || "").trim() || this.buildRoonId(album.id_albumu);
      const roonIdField = createReadOnlyInput(roonIdValue);
      const spotifyField = createLockableInput(album.spotify_link || "", { locked: true });
      const appleMusicField = createLockableInput(album.apple_music_link || "", { locked: true });
      const catalogNumberField = createLockableInput(album.catalog_number || "", { locked: true });
      const pictureField = createLockableInput(album.picture || "", { locked: true });

      const releaseOriginalValue = Number(album.release_original);
      const releaseBaseValue =
        Number.isFinite(releaseOriginalValue) && releaseOriginalValue > 0
          ? album.release_original
          : album.release_date || 0;
      const releaseParts = this.formatReleaseDateParts(releaseBaseValue);
      const releaseGroup = buildSegmentedInput({
        values: [releaseParts.day, releaseParts.month, releaseParts.year],
        separator: ".",
        sizes: [2, 2, 4]
      });
      const releaseField = createLockableGroup(releaseGroup, { locked: true });

      const durationParts = this.formatDurationParts(album.duration || 0);
      const durationGroup = buildSegmentedInput({
        values: [durationParts.hours, durationParts.minutes, durationParts.seconds],
        separator: ":",
        sizes: [2, 2, 2]
      });
      const durationField = createLockableGroup(durationGroup, { locked: true });

      const labelWrap = document.createElement("div");
      labelWrap.className = "modal-input-lock";
      const labelSelect = document.createElement("select");
      labelSelect.className = "modal-input modal-input--row";
      const labelNames = LABEL_HIERARCHY.map((entry) => this.getLabelNameFromHierarchy(entry)).filter(Boolean);
      labelNames.forEach((name) => {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        if (name === album.label) option.selected = true;
        labelSelect.appendChild(option);
      });
      if (!labelSelect.value) {
        const current = album.label || "";
        if (current) {
          const option = document.createElement("option");
          option.value = current;
          option.textContent = current;
          option.selected = true;
          labelSelect.appendChild(option);
        }
      }
      labelWrap.appendChild(labelSelect);
      labelWrap.appendChild(createLockSpacer());

      const bookletSwitch = this.createSwitch({
        leftLabel: "OFF",
        rightLabel: "ON",
        defaultRight: Boolean(album.booklet),
        compact: true
      });
      this.updateSwitchLabels(bookletSwitch.input, bookletSwitch.leftLabel, bookletSwitch.rightLabel);
      bookletSwitch.input.addEventListener("change", () => {
        this.updateSwitchLabels(bookletSwitch.input, bookletSwitch.leftLabel, bookletSwitch.rightLabel);
      });

      const cdBackSwitch = this.createSwitch({
        leftLabel: "OFF",
        rightLabel: "ON",
        defaultRight: Boolean(album.cd_back),
        compact: true
      });
      this.updateSwitchLabels(cdBackSwitch.input, cdBackSwitch.leftLabel, cdBackSwitch.rightLabel);
      cdBackSwitch.input.addEventListener("change", async () => {
        const wasEnabled = cdBackSwitch.input.dataset.prevChecked === "1";
        const isEnabled = cdBackSwitch.input.checked;
        this.updateSwitchLabels(cdBackSwitch.input, cdBackSwitch.leftLabel, cdBackSwitch.rightLabel);
        cdBackSwitch.input.dataset.prevChecked = isEnabled ? "1" : "";
        if (wasEnabled || !isEnabled) return;
        await this.ensureAppDirectory();
        const filePath = this.getCdBackFilePath(album);
        if (!filePath) return;
        try {
          const exists = await checkFileExists({ filePath });
          if (!exists) {
            this.showStatusMessage("Brak CD BACK dla wybranego albumu.");
          }
        } catch (error) {
          console.warn("Nie udało się sprawdzić pliku CD BACK:", error);
        }
      });
      cdBackSwitch.input.dataset.prevChecked = cdBackSwitch.input.checked ? "1" : "";

      const switchesRow = document.createElement("div");
      switchesRow.className = "modal-inline-switches";
      const bookletWrap = document.createElement("div");
      bookletWrap.className = "modal-inline-switches__item";
      bookletWrap.appendChild(buildRow("BOOKLET", bookletSwitch.wrapper));
      const cdBackWrap = document.createElement("div");
      cdBackWrap.className = "modal-inline-switches__item";
      cdBackWrap.appendChild(buildRow("CD BACK", cdBackSwitch.wrapper));
      switchesRow.appendChild(bookletWrap);
      switchesRow.appendChild(cdBackWrap);

      form.appendChild(buildRow("ROON ID", roonIdField.wrap));
      form.appendChild(buildRow("LABEL", labelWrap));
      form.appendChild(switchesRow);
      form.appendChild(buildRow("FORMAT", formatField.wrap));
      form.appendChild(buildRow("TITLE Raffaello", titleRaffaelloField.wrap));
      form.appendChild(buildRow("ARTIST Raffaello", artistRaffaelloField.wrap));
      form.appendChild(buildRow("TITLE Tidal", titleTidalField.wrap));
      form.appendChild(buildRow("ARTIST Tidal", artistTidalField.wrap));
      form.appendChild(buildRow("TIDAL LINK", linkField.wrap));
      form.appendChild(buildRow("PICTURE", pictureField.wrap));
      form.appendChild(buildRow("CATALOG NUMBER", catalogNumberField.wrap));
      form.appendChild(buildRow("SPOTIFY LINK", spotifyField.wrap));
      form.appendChild(buildRow("APPLE MUSIC LINK", appleMusicField.wrap));
      form.appendChild(buildRow("RELEASE DATE", releaseField.wrap));
      form.appendChild(buildRow("DURATION", durationField.wrap));

      const actions = document.createElement("div");
      actions.className = "modal-actions";

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "modal-btn modal-btn--cancel";
      cancelBtn.textContent = "ANULUJ";

      const confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className = "modal-btn modal-btn--confirm";
      confirmBtn.textContent = "ZAPISZ";

      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);

      card.appendChild(heading);
      card.appendChild(form);
      card.appendChild(actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      const cleanup = (saved) => {
        overlay.remove();
        resolve(saved);
      };

      const validateReleaseInput = () => {
        const values = releaseGroup.inputs.map((input) => input.value.trim());
        const hasAny = values.some((value) => value !== "");
        if (!hasAny) return { valid: true, value: 0 };
        if (values.some((value) => value !== "" && !/^\d+$/.test(value))) {
          return { valid: false, value: 0 };
        }
        const parsed = this.parseReleaseDateParts(
          releaseGroup.inputs[0]?.value,
          releaseGroup.inputs[1]?.value,
          releaseGroup.inputs[2]?.value
        );
        if (!parsed) return { valid: false, value: 0 };
        return { valid: true, value: parsed };
      };

      const validateDurationInput = () => {
        const values = durationGroup.inputs.map((input) => input.value.trim());
        const hasAny = values.some((value) => value !== "");
        if (!hasAny) return { valid: true, value: 0 };
        if (values.some((value) => value !== "" && !/^\d+$/.test(value))) {
          return { valid: false, value: 0 };
        }
        if (values.some((value) => value !== "" && Number(value) > 99)) {
          return { valid: false, value: 0 };
        }
        const parsed = this.parseDurationParts(
          durationGroup.inputs[0]?.value,
          durationGroup.inputs[1]?.value,
          durationGroup.inputs[2]?.value
        );
        return { valid: true, value: parsed };
      };

      cancelBtn.addEventListener("click", () => cleanup(false));
      confirmBtn.addEventListener("click", async () => {
        const releaseValidation = validateReleaseInput();
        const durationValidation = validateDurationInput();
        if (!releaseValidation.valid || !durationValidation.valid) {
          await this.infoModal({ message: "Wprowadzono nieprawidłową wartość." });
          return;
        }
        const nextRelease = releaseValidation.value;
        const nextDuration = durationValidation.value;
        const nextTitleRaffaello = titleRaffaelloField.input.value.trim();
        const nextArtistRaffaello = artistRaffaelloField.input.value.trim();
        const nextTitleTidal = titleTidalField.input.value.trim();
        const nextArtistTidal = artistTidalField.input.value.trim();
        const nextFormat = this.resolveFormatLabel(formatField.select.value.trim());
        const updates = {
          link: linkField.input.value.trim(),
          format: nextFormat,
          roon_id: roonIdValue,
          spotify_link: spotifyField.input.value.trim(),
          apple_music_link: appleMusicField.input.value.trim(),
          catalog_number: catalogNumberField.input.value.trim(),
          artist: nextArtistRaffaello,
          artist_raffaello: nextArtistRaffaello,
          artist_tidal: nextArtistTidal,
          title: nextTitleRaffaello,
          title_raffaello: nextTitleRaffaello,
          title_tidal: nextTitleTidal,
          duration: nextDuration,
          release_date: nextRelease,
          release_original: nextRelease || 0,
          picture: pictureField.input.value.trim(),
          label: labelSelect.value || album.label || "",
          booklet: bookletSwitch.input.checked ? 1 : 0,
          cd_back: cdBackSwitch.input.checked ? 1 : 0
        };
        const { changed } = this.store.updateAlbumData(album, updates);
        if (changed) {
          this.processAndRender();
          this.showStatusMessage("Zaktualizowano dane albumu.");
        }
        cleanup(changed);
      });

      const onKeyDown = (event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          confirmBtn.click();
        }
      };
      overlay.addEventListener("keydown", onKeyDown);
      confirmBtn.addEventListener("keydown", onKeyDown);
      cancelBtn.addEventListener("keydown", onKeyDown);

      card.setAttribute("tabindex", "-1");
      setTimeout(() => {
        card.focus();
        if (window.getSelection) {
          window.getSelection().removeAllRanges();
        }
      }, 0);
    });
  }

  getRemixPresetName(name) {
    const trimmed = String(name || "").trim();
    if (!trimmed) return "";
    if (!this.uiState.remixEnabled) return trimmed;
    const prefix = "RMX: ";
    if (trimmed.startsWith(prefix)) return trimmed;
    return `${prefix}${trimmed}`;
  }

  async handleSaveFilterPreset() {
    const activeName = this.uiState.activeFilterPreset;
    const payload = this.serializeCurrentFilters();
    if (activeName && activeName !== "__none__") {
      try {
        await saveFilterPreset(activeName, payload);
        await this.loadFilterPresets();
        this.setActiveFilterPreset(activeName);
        this.showTransientStatus(`${activeName} został zapisany ${formatStatusDate(new Date())}`);
        await this.createAutoFilterFolder();
      } catch (error) {
        this.showStatusMessage(error.message || "Nie udało się zapisać filtrów.");
      }
      return;
    }

    if (this.uiState.filterPresets.length >= 30) {
      this.showStatusMessage("Osiągnięto maksymalną ilość zapisanych filtrów.");
      return;
    }

    const name = await this.promptForPresetName({ title: "Wpisz nazwę zestawu filtrów" });
    const trimmedName = name?.trim();
    if (!trimmedName) return;
    const finalName = this.getRemixPresetName(trimmedName);
    if (finalName.length > 30) {
      this.showStatusMessage("Nazwa filtra może mieć maksymalnie 30 znaków.");
      return;
    }
    try {
      await saveFilterPreset(finalName, payload);
      await this.loadFilterPresets();
      this.setActiveFilterPreset(finalName);
      this.showTransientStatus(`${finalName} został zapisany ${formatStatusDate(new Date())}`);
      await this.createAutoFilterFolder();
    } catch (error) {
      this.showStatusMessage(error.message || "Nie udało się zapisać filtrów.");
    }
  }

  async handleCopyFilterPreset() {
    const currentName = this.uiState.activeFilterPreset;
    if (!currentName || currentName === "__none__") {
      this.showStatusMessage("Wybierz filtr z listy, aby go skopiować.");
      return;
    }
    if (/\(copy\)\s*$/i.test(currentName)) {
      this.showStatusMessage(
        "Nie można skopiować kopi filtrów. Wybierz inny filtr z listy, który nie jest kopią."
      );
      return;
    }
    const preset = this.uiState.filterPresets.find((item) => item.name === currentName);
    if (!preset) {
      this.showStatusMessage("Nie znaleziono wybranego filtra do skopiowania.");
      return;
    }
    const nextName = `${currentName} (copy)`;
    if (nextName.length > 30) {
      this.showStatusMessage("Nazwa filtra może mieć maksymalnie 30 znaków.");
      return;
    }
    const nameExists = this.uiState.filterPresets.some((item) => item.name === nextName);
    if (nameExists) {
      this.showStatusMessage("Filtr o takiej nazwie już istnieje.");
      return;
    }
    let payload = preset.payload;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch (error) {
        payload = {};
      }
    }
    try {
      await saveFilterPreset(nextName, payload);
      await this.loadFilterPresets();
      this.setActiveFilterPreset(nextName);
      this.showTransientStatus(`${nextName} został zapisany ${formatStatusDate(new Date())}`);
    } catch (error) {
      this.showStatusMessage(error.message || "Nie udało się skopiować filtra.");
    }
  }

  async createAutoFilterFolder() {
    if (!this.uiState.autoFilterFolder) return;
    const context = this.getFilteredExportContext();
    if (!context.list.length) {
      this.showStatusMessage("Brak albumów do zapisania w automatycznym folderze.");
      return;
    }
    const containerName = this.dom.containerSelect?.value;
    if (!containerName || containerName === "__all__") {
      this.showStatusMessage("Wybierz konkretny kontener, aby zapisać folder z filtrem.");
      return;
    }

    let collectionName = this.uiState.activeCollection || "__all__";
    if (collectionName === "__all__") {
      collectionName = this.store.containerMeta.get(containerName)?.collection || "brak";
    }
    this.store.ensureContainerEntry(containerName, collectionName);

    const baseName = this.buildFilterFolderName();
    let folderName = baseName;
    let counter = 1;
    while (this.store.foldersList.has(folderName)) {
      folderName = `${baseName}_${counter}`;
      counter += 1;
    }

    this.store.ensureFolderEntry(folderName, containerName);
    const { added } = this.store.addAlbumsToFolder(context.list, folderName);
    if (!added) {
      this.showStatusMessage("Nie dodano albumów do folderu filtrów.");
      return;
    }
    this.markFoldersPending();
    this.processAndRender();
    this.showTransientStatus(`☑ Utworzono folder: ${folderName}`);
  }

  handlePresetSelectionChange(event) {
    const selected = event.target.value;
    this.uiState.activeFilterPreset = selected;
    if (selected === "__none__") {
      this.clearAllFilters();
      return;
    }
    const preset = this.uiState.filterPresets.find((item) => item.name === selected);
    if (preset) {
      this.applyFilterPreset(preset);
    }
  }

  applyFilterPreset(preset) {
    let payload = preset.payload;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch (error) {
        console.warn("Nie udało się odczytać zapisanych filtrów:", error);
        return;
      }
    }
    if (!payload || typeof payload !== "object") return;

    const { filterPanel } = this.dom;
    const labels = Array.isArray(payload.labels) ? payload.labels : Array.from(LABEL_MAP.keys());
    const selectors = Array.isArray(payload.selectors) ? payload.selectors : [...SELECTOR_VALUES];

    this.uiState.selectedLabels.clear();
    labels.forEach((label) => this.uiState.selectedLabels.add(label));
    this.uiState.selectedSelectors.clear();
    selectors.forEach((selector) => this.uiState.selectedSelectors.add(selector));

    if (filterPanel) {
      filterPanel.querySelectorAll('.filter-chip--selection input[type="checkbox"]').forEach((cb) => {
        const shouldCheck =
          this.uiState.selectedSelectors.has(cb.value) || this.uiState.selectedLabels.has(cb.value);
        cb.checked = shouldCheck;
      });
    }

    if (this.dom.searchInput) {
      this.dom.searchInput.value = payload.searchTerm || "";
    }

    this.setYearControlValue(this.dom.releaseYearFromControl, payload.releaseYearFrom || "__all__", { silent: true });
    this.setCycleButtonValue(this.dom.releaseMonthFrom, payload.releaseMonthFrom || "__all__", { silent: true });
    this.setYearControlValue(this.dom.releaseYearToControl, payload.releaseYearTo || "__all__", { silent: true });
    this.setCycleButtonValue(this.dom.releaseMonthTo, payload.releaseMonthTo || "__all__", { silent: true });

    const parseNullableNumber = (value) => {
      if (value === null || value === undefined || value === "") return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const parseNullableInt = (value) => {
      const parsed = parseNullableNumber(value);
      return Number.isInteger(parsed) ? parsed : null;
    };
    const parsedHeardMin = parseNullableInt(payload.heardMin);
    const parsedHeardMax = parseNullableInt(payload.heardMax);
    this.uiState.heardRange = {
      min: parsedHeardMin,
      max: parsedHeardMax
    };
    this.normalizeHeardRange();
    this.updateHeardRangeDisplay();

    const parsedDurationMin = parseNullableNumber(payload.durationMin);
    const parsedDurationMax = parseNullableNumber(payload.durationMax);
    this.uiState.durationRange = {
      min: Number.isFinite(parsedDurationMin) ? parsedDurationMin : null,
      max: Number.isFinite(parsedDurationMax) ? parsedDurationMax : null
    };
    if (this.dom.durationRangeMinInput) {
      this.dom.durationRangeMinInput.value = this.uiState.durationRange.min ?? "";
    }
    if (this.dom.durationRangeMaxInput) {
      this.dom.durationRangeMaxInput.value = this.uiState.durationRange.max ?? "";
    }

    const allowedSort = new Set(["release_desc", "release_asc", "duration_asc", "duration_desc"]);
    this.uiState.sortMode = allowedSort.has(payload.sortMode) ? payload.sortMode : "release_desc";
    this.store.setSortMode(this.uiState.sortMode);
    this.updateTimeSortButtons();

    this.uiState.skipFolderFiltering = payload.skipFolderFiltering ?? true;
    if (this.dom.skipFolderFilteringInput) {
      this.dom.skipFolderFilteringInput.checked = this.uiState.skipFolderFiltering;
      this.updateSwitchLabels(
        this.dom.skipFolderFilteringInput,
        this.dom.skipFolderFilteringLabels?.left,
        this.dom.skipFolderFilteringLabels?.right
      );
    }

    this.uiState.showFavorites = payload.showFavorites ?? true;
    if (this.dom.showFavoritesInput) {
      this.dom.showFavoritesInput.checked = this.uiState.showFavorites;
    }

    const remixSlots = Array.isArray(payload.remixSlots) ? payload.remixSlots : [];
    this.uiState.remixSlots = Array.from({ length: this.remixTotalSlots }, (_, index) => {
      const slot = remixSlots[index] || {};
      const percentValue = Number(slot.percent);
      const countValue = Number(slot.count);
      return {
        folder: typeof slot.folder === "string" ? slot.folder : "",
        percent: Number.isFinite(percentValue) ? Math.min(100, Math.max(1, percentValue)) : 100,
        mode: slot.mode === "count" ? "count" : "percent",
        count: Number.isFinite(countValue) ? Math.max(0, Math.round(countValue)) : null,
        enabled: slot.enabled !== false
      };
    });
    const remixPages = Array.isArray(payload.remixPagesEnabled) ? payload.remixPagesEnabled : [];
    this.uiState.remixPagesEnabled = this.normalizeRemixPages(remixPages);
    const remixLockedPayload = Array.isArray(payload.remixLocked) ? payload.remixLocked : [];
    const remixLocked = new Map();
    remixLockedPayload.forEach((entry) => {
      const folder = typeof entry?.folder === "string" ? entry.folder : "";
      if (!folder) return;
      const albums = Array.isArray(entry?.albums) ? entry.albums : [];
      const validIds = albums
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0);
      if (!validIds.length) return;
      remixLocked.set(folder, new Set(validIds));
    });
    this.uiState.remixLocked = remixLocked;
    this.refreshRemixSlotDisplays();
    this.updateRemixPageButtons();
    this.setRemixEnabled(payload.remixEnabled === true, { silent: true, skipRender: true });
    this.updateRemixSearchSuggestions();

    const refreshMode = payload.foldersRefreshMode === "MANUAL" ? "MANUAL" : "AUTO";
    this.toggleFoldersRefreshMode(refreshMode === "AUTO");
    if (this.dom.foldersRefreshModeInput) {
      this.dom.foldersRefreshModeInput.checked = refreshMode === "AUTO";
      this.updateSwitchLabels(
        this.dom.foldersRefreshModeInput,
        this.dom.foldersRefreshModeLabels?.left,
        this.dom.foldersRefreshModeLabels?.right
      );
    }

    if (this.dom.containerSelect) {
      this.dom.containerSelect.value = payload.containerFilter || "__all__";
    }
    if (this.dom.folderSelect) {
      this.dom.folderSelect.value = payload.folderFilter || "__all__";
    }

    this.setActiveFilterPreset(preset.name, { silent: true });
    const parsedPage = Number(payload.currentPage);
    if (Number.isInteger(parsedPage) && parsedPage >= 0) {
      this.setCurrentPage(parsedPage);
    } else {
      this.resetCurrentPage();
    }
    this.processAndRender();
  }

  async handlePresetRename() {
    const currentName = this.uiState.activeFilterPreset;
    if (!currentName || currentName === "__none__") return;
    const nextName = await this.promptForPresetName({
      title: "Podaj nową nazwę zestawu filtrów",
      defaultValue: currentName
    });
    const trimmedNext = nextName?.trim();
    if (!trimmedNext || trimmedNext === currentName) return;
    if (trimmedNext.length > 30) {
      this.showStatusMessage("Nazwa filtra może mieć maksymalnie 30 znaków.");
      return;
    }
    try {
      await renameFilterPreset(currentName, trimmedNext);
      await this.loadFilterPresets();
      this.setActiveFilterPreset(trimmedNext);
      this.showTransientStatus(
        `${trimmedNext} zapisano edycję nazwy filtrów ${formatStatusDate(new Date())}`
      );
    } catch (error) {
      this.showStatusMessage(error.message || "Nie udało się zmienić nazwy filtrów.");
    }
  }

  async handlePresetDelete() {
    const currentName = this.uiState.activeFilterPreset;
    if (!currentName || currentName === "__none__") return;

    // UWAGA: nie używamy native `confirm()` w Electronie, bo potrafi rozwalić focus/klawiaturę
    // (objaw: w modalu da się tylko backspace, a pisanie wraca dopiero po wciśnięciu ALT).
    // Usuwamy filtr od razu – zgodnie z założeniem UI: DELETE = DELETE.
    try {
      await deleteFilterPreset(currentName);
      await this.loadFilterPresets();
      this.setActiveFilterPreset("__none__");
      this.showTransientStatus(`${currentName} został usunięty ${formatStatusDate(new Date())}`);
    } catch (error) {
      this.showStatusMessage(error.message || "Nie udało się usunąć filtrów.");
    }
  }

  async loadInitialData() {
  try {
      this.startOperation("🔌 Łączenie z SQLite / bazą danych i wczytywanie danych...");
      this.startProgress("Wczytywanie danych z SQLite / bazy danych...");
      const response = await this.reloadFromDatabase(false);
      if (response?.records) {
        this.finishProgress(`🔄 Wczytano ${response.records.length} rekordów z SQLite / bazy danych.`);
      } else {
        this.finishProgress("🔄 Wczytano dane z SQLite / bazy danych.");
      }
      this.uiState.autoDataLoaded = true;
    } catch (error) {
      console.warn("Nie udało się pobrać danych z API:", error);
      if (!this.uiState.loadRetryTimer) {
        this.uiState.loadRetryTimer = setTimeout(() => {
          this.uiState.loadRetryTimer = null;
          this.loadInitialData();
        }, 6000);
      }
      this.stopProgress();
    } finally {
      this.finishOperation();
    }
  }

  async reloadFromDatabase(showFeedback = true) {
    const response = await fetchWorkbook();
    if (!response || !Array.isArray(response.records)) {
      throw new Error("API nie zwróciło poprawnej listy rekordów");
    }
    this.applyRecordsList(
      {
        records: response.records,
        collections: response.collections || [],
        containers: response.containers || [],
        folders: response.folders || [],
        albumFolders: response.albumFolders || [],
        labelsHierarchy: response.labelsHierarchy || []
      },
      {
        sheetName: response.sheet_name,
        fileName: response.file_name,
        timestamp: response.updated_at || Date.now()
      }
    );
    if (Array.isArray(response.missingLabels) && response.missingLabels.length) {
      const lines = response.missingLabels.map(
        (label) => `⚠️ Brakuje w labels.txt wytwórni: ${label}`
      );
      await this.infoModal({
        title: "Brakujące wytwórnie",
        message: lines.join("\n")
      });
    }
    this.uiState.autoDataLoaded = true;
    if (showFeedback) {
      this.uiState.pendingStatusMessage = `🔄 Odświeżono ${response.records.length} rekordów z SQLite / bazy danych.`;
    }
    return response;
  }

  applyRecordsList(payload, meta = {}) {
    const previousHierarchy = [...LABEL_HIERARCHY];
    this.store.loadFromPayload(payload, meta);
    const hierarchyChanged = previousHierarchy.join("|") !== LABEL_HIERARCHY.join("|");
    if (hierarchyChanged) {
      this.uiState.selectedLabels = this.store.getLabelSelection();
      this.refreshLabelsGrid();
      this.updateFilterTabIndicators();
    }
    const appliedStored = this.applyStoredSelectionsOnce();
    if (!appliedStored) {
      this.rebuildCollectionSelect();
      this.rebuildContainerSelect();
      this.rebuildFolderSelect();
    }
    if (meta.fileName || meta.lastModified || meta.timestamp) {
      this.store.setFileMeta({
        name: meta.fileName,
        timestamp: meta.lastModified ? new Date(meta.lastModified) : meta.timestamp
      });
      this.refreshFileStatus();
    }
    this.refreshRemixSlotDisplays();
    this.updateRemixSearchSuggestions();
    this.processAndRender();
  }

  scheduleProcessAndRender(delay = 150) {
   if (this.renderScheduled) return;
    this.renderScheduled = true;
    setTimeout(() => {
      this.renderScheduled = false;
      this.processAndRender();
    }, delay);
  }

  processAndRender() {
    const { releaseMonthFrom, releaseYearFrom, releaseMonthTo, releaseYearTo, searchInput } = this.dom;

    if (this.uiState.remixEnabled) {
      this.uiState.remixList = this.buildRemixList();
      this.updateNavCounts();
      this.renderAlbumsPage();
      this.updateFilterTabIndicators();
      return;
    }

    const buildRangeTimestamp = (yearSelect, monthSelect, isEnd) => {
      if (!yearSelect || yearSelect.value === "__all__") return null;
      const year = parseInt(yearSelect.value, 10);
      if (!Number.isInteger(year)) return null;
      const monthValue = monthSelect && monthSelect.value !== "__all__" ? parseInt(monthSelect.value, 10) : null;
      if (Number.isInteger(monthValue)) {
        if (isEnd) {
          return Math.floor(new Date(year, monthValue, 0, 23, 59, 59).getTime() / 1000);
        }
        return Math.floor(new Date(year, monthValue - 1, 1).getTime() / 1000);
      }
      if (isEnd) {
        return Math.floor(new Date(year, 11, 31, 23, 59, 59).getTime() / 1000);
      }
      return Math.floor(new Date(year, 0, 1).getTime() / 1000);
    };

    let releaseStartTs = buildRangeTimestamp(releaseYearFrom, releaseMonthFrom, false);
    let releaseEndTs = buildRangeTimestamp(releaseYearTo, releaseMonthTo, true);
    if (releaseStartTs !== null && releaseEndTs !== null && releaseStartTs > releaseEndTs) {
      [releaseStartTs, releaseEndTs] = [releaseEndTs, releaseStartTs];
    }
    const filters = {
      releaseStartTs,
      releaseEndTs,
      searchTerm: searchInput?.value || "",
      labels: this.uiState.selectedLabels,
      selectors: this.uiState.selectedSelectors,
      heardMin: this.uiState.heardRange.min,
      heardMax: this.uiState.heardRange.max,
      durationMin: this.uiState.durationRange.min,
      durationMax: this.uiState.durationRange.max,
      showFavorites: this.uiState.showFavorites
    };
    this.store.setLabelSelection(this.uiState.selectedLabels);
    this.store.setSelectorSelection(this.uiState.selectedSelectors);
    this.store.setSortMode(this.uiState.sortMode);
    const filtersChanged = this.store.applyFilters(filters);
    const skipToggleChanged = this.uiState.lastSkipFolderFiltering !== this.uiState.skipFolderFiltering;
    if (filtersChanged || this.store.indexesDirty || skipToggleChanged) {
      this.store.rebuildCategories();
    }
    if (this.uiState.skipFolderFiltering) {
      this.store.rebuildFolderView({ ignoreFilters: true });
    }
    this.uiState.lastSkipFolderFiltering = this.uiState.skipFolderFiltering;
    this.updateNavCounts();
    this.rebuildContainerSelect();
    this.rebuildFolderSelect();
    if (this.uiState.currentCategory !== "FD" || !this.uiState.foldersNeedRefresh) {
      this.renderAlbumsPage();
    }
    this.updateFilterTabIndicators();
  }

  updateNavCounts() {
    const { countDB, newCounter, originalCounter, copyCounter } = this.dom;
    if (countDB) {
      const count = this.uiState.remixEnabled ? this.uiState.remixList.length : this.store.categorized.DB.length;
      countDB.textContent = `(${count})`;
    }
    const newCount = this.store.categorized.NR.length;
    const updateCount = this.store.categorized.DB.reduce(
      (acc, album) => acc + (this.isUpdateBadgeActive(album) ? 1 : 0),
      0
    );
    if (newCounter) {
      if (newCount && updateCount) {
        newCounter.textContent = `NEW / UPDATE ${newCount + updateCount}`;
      } else if (newCount) {
        newCounter.textContent = `NEW ${newCount}`;
      } else if (updateCount) {
        newCounter.textContent = `UPDATE ${updateCount}`;
      } else {
        newCounter.textContent = "NEW / UPDATE 0";
      }
    }
    const assignmentCounts = this.store.getAssignmentCounts();
    if (originalCounter) originalCounter.textContent = `Z ${assignmentCounts.assigned}`;
    if (copyCounter) copyCounter.textContent = `B ${assignmentCounts.unassigned}`;
  }

  renderCategory(category) {
    this.uiState.pageByCategory[this.uiState.currentCategory] = this.uiState.currentPage;
    this.uiState.currentCategory = category;
    this.setCurrentPage(this.getStoredPage(category));
    document.body.classList.remove(...Object.values(CATEGORY_CLASSES));
    const className = this.store.getCategoryClass(category);
    if (className) document.body.classList.add(className);
    this.updateNavActive(category);
    if (category === "FD" && this.uiState.foldersNeedRefresh) {
      return;
    }
    this.renderAlbumsPage();
  }

  updateNavActive(category) {
    this.dom.navItems.forEach((item) => {
      item.classList.toggle("active", item.dataset.page === category);
    });
  }

  renderAlbumsPage() {
    const {
      folderSelect,
      containerSelect,
      albumsContainer,
      pagination
    } = this.dom;
    const folderFilter = folderSelect?.value;
    const containerFilter = containerSelect?.value;
    const pagePayload = this.uiState.remixEnabled
      ? this.getPagedList(this.uiState.remixList, this.uiState.currentPage)
      : this.store.getPagedCategory(this.uiState.currentCategory, this.uiState.currentPage, {
          folderFilter,
          containerFilter
        });
    const { pageItems, totalPages, currentPage } = pagePayload;

    this.setCurrentPage(currentPage);
    if (albumsContainer) {
      albumsContainer.innerHTML = "";
      pageItems.forEach((album) => {
        const card = this.createAlbumCard(album);
        albumsContainer.appendChild(card);
      });
    }

    this.renderPagination(totalPages, currentPage);
  }

  getPagedList(list, page) {
    const total = list.length;
    const totalPages = total ? Math.ceil(total / ALBUMS_PER_PAGE) : 0;
    const safePage = totalPages === 0 ? 0 : Math.min(Math.max(page, 0), totalPages - 1);
    const start = safePage * ALBUMS_PER_PAGE;
    const end = start + ALBUMS_PER_PAGE;
    return {
      pageItems: list.slice(start, end),
      total,
      totalPages,
      currentPage: safePage
    };
  }

  buildPaginationPages(totalPages, currentPage) {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, idx) => idx);
    }

    const pages = [];
    const firstPage = 0;
    const lastPage = totalPages - 1;
    const windowStart = Math.max(currentPage - 2, 1);
    const windowEnd = Math.min(currentPage + 2, lastPage - 1);

    pages.push(firstPage);

    if (windowStart > 1) {
      pages.push("ellipsis");
    } else {
      for (let i = 1; i < windowStart; i += 1) {
        pages.push(i);
      }
    }

    for (let i = windowStart; i <= windowEnd; i += 1) {
      pages.push(i);
    }

    if (windowEnd < lastPage - 1) {
      pages.push("ellipsis");
    } else {
      for (let i = windowEnd + 1; i < lastPage; i += 1) {
        pages.push(i);
      }
    }

    pages.push(lastPage);
    return pages;
  }

  renderPagination(totalPages, currentPage) {
    const { pagination, pageInfo } = this.dom;
    if (!pagination) return;

    if (pageInfo) {
      pageInfo.textContent = totalPages
        ? `Strona ${currentPage + 1} z ${totalPages}`
        : "Strona 0 z 0";
    }

    pagination.dataset.actpage = totalPages ? currentPage + 1 : 0;
    pagination.dataset.totalpages = String(totalPages);

    const fragment = document.createDocumentFragment();
    const createButton = ({ label, page, disabled = false }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "menu-chip pagination__btn";
      btn.dataset.page = String(page);
      const span = document.createElement("span");
      span.className = "menu-chip__inner";
      span.textContent = label;
      btn.appendChild(span);
      if (disabled) btn.disabled = true;
      return btn;
    };

    fragment.appendChild(
      createButton({ label: "<<", page: "first", disabled: currentPage <= 0 || totalPages === 0 })
    );
    fragment.appendChild(
      createButton({ label: "< PREV", page: "prev", disabled: currentPage <= 0 || totalPages === 0 })
    );

    const center = document.createElement("div");
    center.className = "pagination__center";
    const count = document.createElement("span");
    count.className = "pagination__count";
    const countText = totalPages ? `${currentPage + 1} z ${totalPages}` : "0 z 0";
    const countValue = document.createElement("span");
    countValue.textContent = countText;
    count.appendChild(countValue);
    const totalDigits = String(Math.max(totalPages, 1)).length;
    count.style.setProperty("--page-digits", String(totalDigits));

    const selectWrap = document.createElement("div");
    selectWrap.className = "menu-select pagination__select";
    const select = document.createElement("select");
    select.className = "pagination__pages";
    select.disabled = totalPages <= 1;
    if (totalPages === 0) {
      select.appendChild(new Option("0", "0"));
    } else {
      for (let i = 0; i < totalPages; i += 1) {
        const option = new Option(`Strona ${i + 1}`, String(i));
        select.appendChild(option);
      }
      select.value = String(currentPage);
    }
    selectWrap.appendChild(select);

    center.appendChild(count);
    center.appendChild(selectWrap);
    fragment.appendChild(center);

    fragment.appendChild(
      createButton({
        label: "NEXT >",
        page: "next",
        disabled: currentPage >= totalPages - 1 || totalPages === 0
      })
    );
    fragment.appendChild(
      createButton({
        label: ">>",
        page: "last",
        disabled: currentPage >= totalPages - 1 || totalPages === 0
      })
    );

    pagination.innerHTML = "";
    if (pageInfo) {
      pagination.appendChild(pageInfo);
    }
    pagination.appendChild(fragment);
  }

  buildAlbumEmbedLink(link) {
    if (!link) return "";
    try {
      const url = new URL(link);
      const host = url.hostname.replace(/^www\./, "");
      const path = url.pathname.replace(/\/+$/, "");
      if (host === "tidal.com") {
        const match = path.match(/\/(?:browse\/)?album\/(\d+)/i);
        if (match) {
          return `https://embed.tidal.com/albums/${match[1]}`;
        }
      }
    } catch (error) {
      return link;
    }
    return link;
  }

  buildTidalProtocolLink(link) {
    if (!link) return "";
    try {
      const url = new URL(link);
      const host = url.hostname.replace(/^www\./, "");
      const path = url.pathname.replace(/\/+$/, "");
      if (host === "tidal.com") {
        const match = path.match(/\/(?:browse\/)?album\/(\d+)/i);
        if (match) {
          return `tidal://browse/album/${match[1]}`;
        }
      }
    } catch (error) {
      return "";
    }
    return "";
  }

  isOnline() {
    return typeof navigator === "undefined" ? true : navigator.onLine !== false;
  }

  showErrorStatusMessage(message, duration = 3000) {
    const { fileStatus } = this.dom;
    if (!fileStatus || !message) return;
    if (this.uiState.operationInProgress) {
      this.uiState.pendingStatusMessage = message;
      return;
    }
    clearTimeout(this.uiState.statusTimeout);
    this.uiState.statusTimeout = null;
    fileStatus.classList.remove("status-success", "status-updated", "busy");
    fileStatus.classList.remove("status-remix-on", "status-remix-off", "status-remix-warning");
    fileStatus.classList.add("status-error");
    fileStatus.classList.remove("hidden");
    fileStatus.textContent = message;
    this.uiState.statusTimeout = setTimeout(() => {
      fileStatus.classList.remove("status-error");
      this.refreshFileStatus();
    }, duration);
  }

  showOfflineMessage() {
    this.showErrorStatusMessage("Nie można otworzyć wybranego albumu. Brak połączenia z Internetem.");
  }

  async ensureAppDirectory() {
    if (this.uiState.appDirectory) return this.uiState.appDirectory;
    try {
      this.uiState.appDirectory = await getAppDirectory();
    } catch (error) {
      console.warn("Nie udało się ustalić katalogu aplikacji:", error);
    }
    return this.uiState.appDirectory;
  }

  getLocalImageUrl(folderName, fileName) {
    if (!folderName || !fileName) return "";
    const basePath = this.uiState.appDirectory || "";
    if (!basePath) {
      return `${folderName}/${fileName}`;
    }
    const resolvedPath = buildPath(basePath, folderName, fileName);
    const normalized = resolvedPath.replace(/\\/g, "/");
    const prefix = normalized.startsWith("/") ? "file://" : "file:///";
    return encodeURI(`${prefix}${normalized}`);
  }

  getCdBackTemplateFileName(album) {
    const formatLabel = this.resolveFormatLabel(album?.format || "");
    const rawFormatCode = this.resolveFormatCode(formatLabel);
    const normalizedCode = String(rawFormatCode || "00").padStart(2, "0");
    return `cd_back_format_${normalizedCode}.jpg`;
  }

  getCdBackFileName(album) {
    const id = Number(album?.id_albumu);
    if (!Number.isFinite(id) || id <= 0) return "";
    return `back_${id}.jpg`;
  }

  getCdBackFilePath(album) {
    if (!this.uiState.appDirectory) return "";
    const fileName = this.getCdBackFileName(album);
    if (!fileName) return "";
    return buildPath(this.uiState.appDirectory, "FILES/CD_BACK", fileName);
  }

  getCdBackImageSources(album) {
    const templateFile = this.getCdBackTemplateFileName(album);
    const templateUrl = this.getLocalImageUrl("CD_TEMPLATE", templateFile);
    const backFile = this.getCdBackFileName(album);
    const backUrl = backFile ? this.getLocalImageUrl("FILES/CD_BACK", backFile) : "";
    const forceBack = this.uiState.cdBackGlobalEnabled;
    const usesBack = forceBack ? Boolean(backUrl) : Number(album?.cd_back) > 0 && Boolean(backUrl);
    return {
      preferred: usesBack ? backUrl : templateUrl,
      template: templateUrl,
      usesBack
    };
  }

  getBookletFileName(album) {
    const id = Number(album?.id_albumu);
    if (!Number.isFinite(id) || id <= 0) return "";
    return `booklet_${id}.pdf`;
  }

  getBookletFilePath(album) {
    if (!this.uiState.appDirectory) return "";
    const fileName = this.getBookletFileName(album);
    if (!fileName) return "";
    return buildPath(this.uiState.appDirectory, "BOOKLET", fileName);
  }

  getAlbumCoverUrl(album, { size = "mini" } = {}) {
    const id = Number(album?.id_albumu);
    const folderName = size === "max" ? "pic_max" : "pic_mini";
    const prefix = size === "max" ? "max" : "mini";
    const fallback = `${prefix}_default.jpg`;
    const fileName = Number.isFinite(id) && id > 0 ? `${prefix}_${id}.jpg` : fallback;
    return {
      src: this.getLocalImageUrl(folderName, fileName),
      fallback: this.getLocalImageUrl(folderName, fallback)
    };
  }

  ensureCoverPreview() {
    if (this.dom.coverPreview) return;
    const overlay = document.createElement("div");
    overlay.className = "cover-preview";
    const image = document.createElement("img");
    image.className = "cover-preview__image";
    overlay.appendChild(image);
    const close = (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.hideCoverPreview();
    };
    overlay.addEventListener("click", close);
    overlay.addEventListener("contextmenu", close);
    document.body.appendChild(overlay);
    this.dom.coverPreview = overlay;
    this.dom.coverPreviewImage = image;
  }

  ensureBookletPreview() {
    if (this.dom.bookletPreview) return;
    const overlay = document.createElement("div");
    overlay.className = "booklet-preview";
    const content = document.createElement("div");
    content.className = "booklet-preview__content";
    const frame = document.createElement("iframe");
    frame.className = "booklet-preview__frame";
    frame.setAttribute("title", "Booklet");
    frame.setAttribute("loading", "lazy");
    content.appendChild(frame);
    overlay.appendChild(content);
    const close = (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.hideBookletPreview();
    };
    overlay.addEventListener("click", close);
    overlay.addEventListener("contextmenu", close);
    content.addEventListener("click", (event) => event.stopPropagation());
    document.body.appendChild(overlay);
    this.dom.bookletPreview = overlay;
    this.dom.bookletPreviewFrame = frame;
  }

  showCoverPreview(album) {
    if (!album) return;
    this.ensureCoverPreview();
    const { coverPreview, coverPreviewImage } = this.dom;
    if (!coverPreview || !coverPreviewImage) return;
    const { src, fallback } = this.getAlbumCoverUrl(album, { size: "max" });
    coverPreviewImage.dataset.fallbackApplied = "";
    coverPreviewImage.dataset.fallbackSrc = fallback;
    coverPreviewImage.src = src;
    coverPreviewImage.onerror = () => {
      if (coverPreviewImage.dataset.fallbackApplied) return;
      coverPreviewImage.dataset.fallbackApplied = "true";
      coverPreviewImage.src = fallback;
    };
    coverPreview.classList.add("is-visible");
  }

  showBookletPreview(url) {
    if (!url) return;
    this.ensureBookletPreview();
    const { bookletPreview, bookletPreviewFrame } = this.dom;
    if (!bookletPreview || !bookletPreviewFrame) return;
    bookletPreviewFrame.src = url;
    bookletPreview.classList.add("is-visible");
  }

  hideCoverPreview() {
    const { coverPreview, coverPreviewImage } = this.dom;
    if (!coverPreview) return;
    coverPreview.classList.remove("is-visible");
    if (coverPreviewImage) {
      coverPreviewImage.src = "";
    }
  }

  hideBookletPreview() {
    const { bookletPreview, bookletPreviewFrame } = this.dom;
    if (!bookletPreview) return;
    bookletPreview.classList.remove("is-visible");
    if (bookletPreviewFrame) {
      bookletPreviewFrame.src = "";
    }
  }

  async openBookletPreview(album) {
    if (!album) return;
    const fileName = this.getBookletFileName(album);
    if (!fileName) {
      this.showStatusMessage("Brak pliku Booklet dla wybranego albumu.");
      return;
    }
    await this.ensureAppDirectory();
    const filePath = this.getBookletFilePath(album);
    if (!filePath) {
      this.showStatusMessage("Brak pliku Booklet dla wybranego albumu.");
      return;
    }
    let exists = false;
    try {
      exists = await checkFileExists({ filePath });
    } catch (error) {
      this.showStatusMessage(error.message || "Nie udało się sprawdzić pliku Booklet.");
      return;
    }
    if (!exists) {
      this.showStatusMessage("Brak pliku Booklet dla wybranego albumu.");
      return;
    }
    const url = this.getLocalImageUrl("BOOKLET", fileName);
    this.showBookletPreview(url);
  }

  async openExternalLink(url, { requireOnline = false } = {}) {
    if (!url) return false;
    if (requireOnline && !this.isOnline()) {
      this.showOfflineMessage();
      return false;
    }
    if (window.electronAPI?.openExternal) {
      await window.electronAPI.openExternal(url);
    } else {
      window.open(url);
    }
    return true;
  }

  async openAlbumPictureSource(album) {
    const url = album?.picture;
    if (!url) {
      this.showStatusMessage("Brak źródłowego linku do okładki.");
      return;
    }
    await this.openExternalLink(url, { requireOnline: true });
  }

  isUpdateBadgeActive(album) {
    const updateTs = Number(album?.update_ts);
    if (!Number.isFinite(updateTs) || updateTs <= 0) return false;
    const ageMs = Date.now() - updateTs;
    return ageMs >= 0 && ageMs <= 24 * 60 * 60 * 1000;
  }

  getAlbumStatusType(album) {
    if (!album) return null;
    const releaseDate = Number(album.release_date) || 0;
    const todayStart = new Date(new Date().toDateString()).getTime() / 1000;
    if (releaseDate && releaseDate > todayStart) {
      return "coming-soon";
    }
    const isNewRelease = this.store.isNewRelease(album);
    const isUpdateImport = this.isUpdateBadgeActive(album);
    if (isUpdateImport && !isNewRelease) {
      return "update";
    }
    if (isNewRelease) {
      return "new";
    }
    return null;
  }

  getAlbumStatusType(album) {
    if (!album) return null;
    const releaseDate = Number(album.release_date) || 0;
    const todayStart = new Date(new Date().toDateString()).getTime() / 1000;
    if (releaseDate && releaseDate > todayStart) {
      return "coming-soon";
    }
    const isNewRelease = this.store.isNewRelease(album);
    const isUpdateImport = this.isUpdateBadgeActive(album);
    if (isUpdateImport && !isNewRelease) {
      return "update";
    }
    if (isNewRelease) {
      return "new";
    }
    return null;
  }



  createAlbumCard(entry) {
    const { folderSelect } = this.dom;
    const album = entry.album || entry;
    const card = document.createElement("a");
    card.href = this.buildAlbumEmbedLink(album.link) || "#";
    card.target = "_blank";
    card.className = "album-card";
    card.title = `${album.title} — ${album.artist}`;

    const favoriteCorner = document.createElement("span");
    favoriteCorner.className = "album-favorite-corner";
    if (album.favorite && this.uiState.showFavoriteCorners) {
      favoriteCorner.classList.add("active");
    }

    const lockedCorner = document.createElement("span");
    lockedCorner.className = "album-locked-corner";
    const remixFolder = entry.folder || this.getRemixFolderForAlbum(album);
    if (
      this.uiState.remixEnabled &&
      remixFolder &&
      this.getRemixLockedSet(remixFolder).has(album.id_albumu)
    ) {
      lockedCorner.classList.add("active");
    }

    const img = document.createElement("img");
    img.className = "album-cover";
    const { src: coverSrc, fallback: coverFallback } = this.getAlbumCoverUrl(album, { size: "mini" });
    const { preferred: cdBackSrc, template: cdBackTemplate, usesBack: cdBackUsesBack } = this.getCdBackImageSources(album);
    const applyMiniCover = () => {
      img.dataset.imageMode = "mini";
      img.dataset.fallbackApplied = "";
      img.onerror = () => {
        if (img.dataset.fallbackApplied) return;
        img.dataset.fallbackApplied = "true";
        img.src = coverFallback;
      };
      img.src = coverSrc;
    };
    const applyCdBackCover = () => {
      img.dataset.imageMode = "cd_back";
      img.dataset.fallbackApplied = "";
      img.onerror = () => {
        if (img.dataset.fallbackApplied) return;
        img.dataset.fallbackApplied = "true";
        if (!cdBackUsesBack) return;
        img.onerror = null;
        img.src = cdBackTemplate;
      };
      img.src = cdBackSrc;
    };
    applyMiniCover();
    if (album.selector === "X") img.classList.add("grayscale");

    const coverWrap = document.createElement("div");
    coverWrap.className = "album-cover-wrap";
    coverWrap.appendChild(img);

    const ratingValue = Number(album.rating) || 0;
    if (ratingValue > 0) {
      const ratingBadge = document.createElement("img");
      ratingBadge.className = "album-rating-overlay";
      ratingBadge.src = `icons/${ratingValue}_STARS.svg`;
      ratingBadge.alt = `${ratingValue} gwiazdek`;
      ratingBadge.setAttribute("aria-hidden", "true");
      coverWrap.appendChild(ratingBadge);
    }

    const info = document.createElement("div");
    info.className = "album-info";
    const titleRow = document.createElement("div");
    titleRow.className = "album-title";

    const hasBooklet = Number(album.booklet) > 0;
    if (hasBooklet) {
      const bookletBtn = document.createElement("button");
      bookletBtn.type = "button";
      bookletBtn.className = "album-booklet-btn";
      const bookletIcon = document.createElement("img");
      bookletIcon.src = "icons/booklet.svg";
      bookletIcon.alt = "Booklet";
      bookletBtn.appendChild(bookletIcon);
      bookletBtn.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await this.openBookletPreview(album);
      });
      titleRow.appendChild(bookletBtn);
    }

    const titleText = document.createElement("span");
    titleText.style.minWidth = "0";
    titleText.textContent = album.title;

    titleRow.appendChild(titleText);

    const artist = document.createElement("div");
    artist.className = "album-artist";
    artist.textContent = album.artist;

    const meta = document.createElement("div");
    meta.className = "album-meta";
    const dot = document.createElement("span");
    dot.className = "folder-dot";
    const folderList = this.store.getAlbumFolderList(album);
    const selectedFolder = folderSelect?.value;
    const hasSelectedFolder = selectedFolder && selectedFolder !== "__all__";
    const isAssigned = hasSelectedFolder ? folderList.includes(selectedFolder) : folderList.length > 0;
    dot.classList.add(isAssigned ? "assigned" : "unassigned");
    if (hasSelectedFolder) {
      dot.title = isAssigned ? `Folder: ${selectedFolder}` : `Brak w folderze: ${selectedFolder}`;
    } else {
      dot.title = isAssigned ? `Foldery: ${folderList.join(", ")}` : "Brak folderu";
    }
    meta.appendChild(dot);

     const metaParts = [];
    if (album.release_date) {
      const d = new Date(album.release_date * 1000);
      const dateStr = `${d.getDate().toString().padStart(2, "0")}.${(d.getMonth() + 1)
        .toString()
        .padStart(2, "0")}.${d.getFullYear()}`;
      metaParts.push(dateStr);
    }
    const dur = formatDuration(album.duration);
    if (dur !== "brak") metaParts.push(dur);
    metaParts.push(String(album.heard ?? 0));

    metaParts.forEach((part, idx) => {
      if (idx > 0) {
        const sep = document.createElement("span");
        sep.textContent = " • ";
        meta.appendChild(sep);
      }
      const span = document.createElement("span");
      span.textContent = part;
      meta.appendChild(span);
    });

    info.appendChild(titleRow);
    info.appendChild(artist);
    info.appendChild(meta);
    const formatLabel = this.resolveFormatLabel(album.format || "");
    if (formatLabel) {
      const formatRow = document.createElement("div");
      formatRow.className = "album-format";
      const formatCode = this.resolveFormatCode(formatLabel);
      if (formatCode) {
        const formatIconBtn = document.createElement("button");
        formatIconBtn.type = "button";
        formatIconBtn.className = "album-format__icon";
        const formatIcon = document.createElement("img");
        formatIcon.src = this.getLocalImageUrl("FORMAT", `format_${formatCode}.svg`);
        formatIcon.alt = "Format";
        formatIconBtn.appendChild(formatIcon);
        formatIconBtn.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          await this.copyRoonId(album);
        });
        formatRow.appendChild(formatIconBtn);
      }
      const formatText = document.createElement("span");
      formatText.className = "album-format__text";
      formatText.textContent = formatLabel;
      formatRow.appendChild(formatText);
      info.appendChild(formatRow);
    }

    const idBadge = document.createElement("span");
    idBadge.className = "album-id-badge";
    idBadge.textContent = `ID: ${album.id_albumu ?? "brak"}`;
    info.appendChild(idBadge);

    const code = LABEL_MAP.get(album.label) || "00A";
    const icon = document.createElement("img");
    icon.className = "album-label-icon";
    icon.src = `LABELS/${code}.svg`;
    icon.alt = album.label;
    icon.title = album.label;
    icon.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.cycleSelector(album, img, card);
    });

    coverWrap.addEventListener("mouseenter", () => {
      if (!this.uiState.cdBackGlobalEnabled) return;
      applyCdBackCover();
      if (album.selector === "X") img.classList.remove("grayscale");
    });
    coverWrap.addEventListener("mouseleave", () => {
      applyMiniCover();
      if (album.selector === "X") img.classList.add("grayscale");
    });

    this.applySelectorColorToCard(card, album.selector);

    card.addEventListener("click", async (event) => {
      if (
        this.uiState.ratingKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.metaKey &&
        event.button === 0
      ) {
        event.preventDefault();
        event.stopPropagation();
        const nextRating = Math.min(5, Math.max(1, Number(this.uiState.ratingKey)));
        const { changed } = this.store.updateAlbumData(album, { rating: nextRating });
        this.setRatingVisibility(true);
        if (changed) {
          this.processAndRender();
        }
        return;
      }
      if (
        this.uiState.keyModifiers.picture &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.metaKey &&
        event.button === 0
      ) {
        event.preventDefault();
        event.stopPropagation();
        this.showCoverPreview(album);
        return;
      }
      if (
        this.uiState.keyModifiers.edit &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.metaKey &&
        event.button === 0
      ) {
        event.preventDefault();
        event.stopPropagation();
        await this.openEditAlbumDialog(album);
        return;
      }
      if (
        this.uiState.remixEnabled &&
        this.uiState.keyModifiers.lock &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.metaKey &&
        event.button === 0
      ) {
        event.preventDefault();
        event.stopPropagation();
        const folderName = entry.folder || this.getRemixFolderForAlbum(album);
        if (folderName) {
          this.lockRemixAlbum(album, folderName);
          lockedCorner.classList.add("active");
        }
        return;
      }
      if (
        this.uiState.keyModifiers.delete &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.metaKey &&
        event.button === 0
      ) {
        event.preventDefault();
        event.stopPropagation();
        await this.handleDeleteAlbum(album);
        return;
      }
      if (
        this.uiState.keyModifiers.favorite &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.metaKey &&
        event.button === 0
      ) {
        event.preventDefault();
        event.stopPropagation();
        this.store.setAlbumFavorite(album, true);
        this.processAndRender();
        return;
      }
      if (
        this.uiState.keyModifiers.copy &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.metaKey &&
        event.button === 0
      ) {
        event.preventDefault();
        event.stopPropagation();
        await this.copyAlbumDetails(album);
        return;
      }
      if (event.ctrlKey && !event.shiftKey && !event.metaKey && event.button === 0) {
        event.preventDefault();
        const { changed } = this.store.adjustHeard(album, 1);
        if (changed) {
          this.processAndRender();
        }
        return;
      }
      if (event.shiftKey && !event.ctrlKey && !event.metaKey && event.button === 0) {
        event.preventDefault();
        if (this.uiState.remixEnabled) {
          return;
        }
        if (this.uiState.operationInProgress) return;
        const target = folderSelect?.value;
        if (target && target !== "__all__") {
          const folderList = this.store.getAlbumFolderList(album);
          if (folderList.includes(target)) {
            const albumLabel = truncateForStatus(album.title || "album", 15);
            const folderLabel = truncateForStatus(target, 15);
            this.showStatusMessage(`Album ${albumLabel} znajduje się już w folderze ${folderLabel}.`);
            return;
          }
          const shouldAutoHeard = /^\d/.test(target);
          await this.performAlbumOperation("assign", () => {
            this.store.addAlbumToFolder(album, target);
            if (shouldAutoHeard) {
              this.store.updateSelector(album, "K");
              this.store.adjustHeard(album, 1);
            }
            this.markFoldersPending();
            // bez processAndRender – zajmie się tym performAlbumOperation + scheduler
          });
        } else {
          this.showStatusMessage('Wybierz konkretny folder z listy (nie "wszystkie").');
        }
        return;
      }
      if (
        !event.defaultPrevented &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.metaKey &&
        event.button === 0 &&
        album.link &&
        !this.isOnline()
      ) {
        event.preventDefault();
        this.showOfflineMessage();
      }
    });

    card.addEventListener("contextmenu", async (event) => {
      if (
        this.uiState.keyModifiers.copy &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        await this.copyAlbumTitle(album);
        return;
      }
      if (
        this.uiState.ratingKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        const { changed } = this.store.updateAlbumData(album, { rating: 0 });
        if (changed) {
          this.processAndRender();
        }
        return;
      }
      if (
        this.uiState.keyModifiers.picture &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        await this.openAlbumPictureSource(album);
        return;
      }
      if (
        this.uiState.remixEnabled &&
        this.uiState.keyModifiers.lock &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        const folderName = entry.folder || this.getRemixFolderForAlbum(album);
        if (folderName) {
          this.unlockRemixAlbum(album, folderName);
          lockedCorner.classList.remove("active");
        }
        return;
      }
      if (
        this.uiState.keyModifiers.favorite &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        this.store.setAlbumFavorite(album, false);
        this.processAndRender();
        return;
      }
      if (event.ctrlKey && !event.shiftKey && !event.metaKey) {
        event.preventDefault();
        const { changed } = this.store.adjustHeard(album, -1);
        if (changed) {
          this.processAndRender();
        }
        return;
      }
      if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        if (this.uiState.operationInProgress) return;
        if (this.uiState.remixEnabled) {
          const removalTarget = entry.folder || this.getRemixFolderForAlbum(album);
          if (removalTarget && removalTarget !== "brak") {
            await this.performAlbumOperation("remove", () => {
              this.store.removeAlbumFromFolder(album, removalTarget);
              this.unlockRemixAlbum(album, removalTarget);
              this.markFoldersPending();
            });
          }
        } else {
          const removalTarget =
            entry.folder ||
            (folderSelect?.value && folderSelect.value !== "__all__" ? folderSelect.value : null);
          if (removalTarget && removalTarget !== "brak") {
            await this.performAlbumOperation("remove", () => {
              this.store.removeAlbumFromFolder(album, removalTarget);
              this.markFoldersPending();
            });
          }
        }
        return;
      }

      const tidalProtocolLink = this.buildTidalProtocolLink(album.link);
      if (tidalProtocolLink) {
        event.preventDefault();
        if (!this.isOnline()) {
          this.showOfflineMessage();
          return;
        }
        const tidalRunning = await this.isTidalRunning();
        if (!tidalRunning) {
          this.showStatusMessage(
            "Aplikacja TIDAL nie jest uruchomiona na twoim komputerze. Uruchom najpierw aplikację TIDAL a następnie wybierz album, który ma zostać otwarty w tej aplikacji."
          );
          return;
        }
      }
      if (this.uiState.remixEnabled) {
        if (this.uiState.operationInProgress) return;
        event.preventDefault();
        const removalTarget = entry.folder || this.getRemixFolderForAlbum(album);
        let removalTriggered = false;
        if (removalTarget && removalTarget !== "brak") {
          removalTriggered = true;
          await this.performAlbumOperation(
            "remove",
            () => {
              this.store.removeAlbumFromFolder(album, removalTarget);
              this.unlockRemixAlbum(album, removalTarget);
              this.markFoldersPending();
            },
            { skipRender: true }
          );
          this.replaceRemixEntry(entry);
          this.renderRemixList();
        }
      } else if (tidalProtocolLink) {
        event.preventDefault();
      }

      this.applyReviewSelectorOnContext(album, img, card);
      if (tidalProtocolLink) {
        const opened = await this.openExternalLink(tidalProtocolLink, { requireOnline: true });
        if (opened && window.electronAPI?.maximizeTidalWindow) {
          setTimeout(() => {
            window.electronAPI.maximizeTidalWindow();
          }, 300);
        }
      }
    });

    const statusType = this.getAlbumStatusType(album);
    if (statusType) {
      const status = document.createElement("img");
      status.className = "album-status-label";
      if (statusType === "coming-soon") {
        status.src = "icons/etykieta_Coming_soon.svg";
        status.alt = "Coming soon";
      } else if (statusType === "update") {
        status.src = "icons/etykieta_UPDATE.svg";
        status.alt = "Update";
      } else {
        status.src = "icons/etykieta_NEW.svg";
        status.alt = "New";
      }
      coverWrap.appendChild(status);
    }
    card.appendChild(coverWrap);
    card.appendChild(info);
    card.appendChild(icon);
    card.appendChild(favoriteCorner);
    card.appendChild(lockedCorner);
    return card;
  }

  cycleSelector(album, image, card) {
    const current = album.selector || "N";
    const idx = SELECTOR_VALUES.indexOf(current);
    const next = SELECTOR_VALUES[(idx + 1) % SELECTOR_VALUES.length];
    album.selector = next;
    this.store.updateSelector(album, next);
    if (next === "X") image.classList.add("grayscale");
    else image.classList.remove("grayscale");
    this.applySelectorColorToCard(card, next);
  }

  applyReviewSelectorOnContext(album, image, card) {
    if (!album) return;
    const current = album.selector || "N";
    if (current === "K" || current === "O") return;
    album.selector = "O";
    this.store.updateSelector(album, "O");
    if (image) {
      image.classList.remove("grayscale");
    }
    this.applySelectorColorToCard(card, "O");
  }

  applySelectorColorToCard(card, selector) {
    if (!card) return;
    const { borderColor, hoverColor, infoBg } = getSelectorStyle(selector);
    card.style.setProperty("--card-border-color", borderColor);
    card.style.setProperty("--card-hover-color", hoverColor);
    card.style.setProperty("--album-info-bg", infoBg);
  }

  async isTidalRunning() {
    try {
      return await isProcessRunning("TIDAL.exe");
    } catch (error) {
      console.warn("Nie udało się sprawdzić procesu TIDAL:", error);
      return false;
    }
  }

  async copyToClipboard(text, { successMessage, errorMessage } = {}) {
    if (!text) {
      this.showStatusMessage("Brak danych do skopiowania.");
      return false;
    }
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "absolute";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      if (successMessage) {
        this.showStatusMessage(successMessage);
      }
      return true;
    } catch (error) {
      this.showStatusMessage(errorMessage || "Nie udało się skopiować danych albumu.");
      console.warn("Clipboard error:", error);
      return false;
    }
  }

  async copyAlbumDetails(album) {
    if (!album) return;
    const title = String(album.title || "").trim();
    const artist = String(album.artist || "").trim();
    const text = [title, artist].filter(Boolean).join(" ").trim();
    await this.copyToClipboard(text, {
      successMessage: "Skopiowano nazwę albumu i wykonawcę.",
      errorMessage: "Nie udało się skopiować danych albumu."
    });
  }

  async copyAlbumTitle(album) {
    if (!album) return;
    const title = String(album.title || "").trim();
    await this.copyToClipboard(title, {
      successMessage: "Skopiowano nazwę albumu.",
      errorMessage: "Nie udało się skopiować nazwy albumu."
    });
  }

  async copyRoonId(album) {
    const roonId = String(album?.roon_id || "").trim() || this.buildRoonId(album?.id_albumu);
    await this.copyToClipboard(roonId, {
      successMessage: "Skopiowano numer ROON ID.",
      errorMessage: "Nie udało się skopiować numeru ROON ID."
    });
  }

  async handleDeleteAlbum(album) {
    if (!album) return;
    if (this.uiState.operationInProgress) return;
    const title = album.title || "brak";
    const artist = album.artist || "brak";
    const albumId = album.id_albumu ?? "brak";
    const confirmed = await this.confirmModal({
      title: "Usuń album z bazy danych",
      message: `Czy na pewno usunąć album?\n${title} ${artist}\nID: ${albumId}`,
      confirmText: "USUŃ",
      cancelText: "ANULUJ"
    });
    if (!confirmed) return;
    try {
      await deleteAlbumAssets({ albumId });
    } catch (error) {
      console.warn("Nie udało się usunąć okładek albumu:", error);
    }
    const result = this.store.removeAlbumFromDatabase(album);
    if (result.changed) {
      this.markFoldersPending();
      this.processAndRender();
      this.showStatusMessage("Usunięto album z bazy danych.");
    }
  }

  rebuildContainerSelect() {
    const { containerSelect } = this.dom;
    if (!containerSelect) return;
    const selected = containerSelect.value;
    containerSelect.innerHTML = "";
    const counts = this.store.getContainerCounts();
    const collectionFilter = this.uiState.activeCollection;
    const containers =
      collectionFilter && collectionFilter !== "__all__"
        ? this.store.getContainersForCollection(collectionFilter)
        : Array.from(this.store.containersList);
    const sorted = containers.sort((a, b) => a.localeCompare(b, "pl"));
    const createOption = (value, label, color) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = `${label} (${counts[value] || 0})`;
      option.style.color = color;
      return option;
    };
    containerSelect.appendChild(createOption("__all__", "wszystkie kontenery", "#1e1e1e"));
    sorted.forEach((name) => {
      const color = name === "brak" ? "#7a7a7a" : "#1e1e1e";
      const option = createOption(name, truncateName(name, 32), color);
      option.title = name;
      containerSelect.appendChild(option);
    });
    if (selected && Array.from(containerSelect.options).some((opt) => opt.value === selected)) {
      containerSelect.value = selected;
    } else {
      containerSelect.value = "__all__";
    }
  }

  rebuildCollectionSelect() {
    const { collectionSelect } = this.dom;
    if (!collectionSelect) return;
    const current = this.uiState.activeCollection || "__all__";
    collectionSelect.innerHTML = "";
    const sorted = Array.from(this.store.collectionsList).sort((a, b) => a.localeCompare(b, "pl"));
    const createOption = (value, label, color) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.style.color = color;
      return option;
    };
    collectionSelect.appendChild(createOption("__all__", "wszystkie kolekcje", "#1e1e1e"));
    sorted.forEach((name) => {
      const color = name === "brak" ? "#7a7a7a" : "#1e1e1e";
      const option = createOption(name, truncateName(name, 32), color);
      option.title = name;
      collectionSelect.appendChild(option);
    });
    if (current && Array.from(collectionSelect.options).some((opt) => opt.value === current)) {
      collectionSelect.value = current;
    } else {
      collectionSelect.value = "__all__";
      this.uiState.activeCollection = "__all__";
    }
  }

  rebuildFolderSelect() {
    const { folderSelect, containerSelect } = this.dom;
    if (!folderSelect) return;
    const selected = folderSelect.value;
    folderSelect.innerHTML = "";
    const containerFilter = containerSelect?.value && containerSelect.value !== "__all__" ? containerSelect.value : null;
    const counts = this.store.getFolderCounts(containerFilter);
    const collectionFilter = this.uiState.activeCollection;
    const folderNames = containerFilter
      ? this.store.getFoldersForContainer(containerFilter)
      : collectionFilter && collectionFilter !== "__all__"
        ? this.store.getFoldersForCollection(collectionFilter)
        : Array.from(this.store.foldersList);
    const sorted = folderNames.sort((a, b) => a.localeCompare(b, "pl"));
    const createOption = (value, label, color) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = `${label} (${counts[value] || 0})`;
      option.style.color = color;
      return option;
    };
    folderSelect.appendChild(createOption("__all__", "wszystkie", "#1e1e1e"));
    sorted.forEach((name) => {
      const color = name === "brak" ? "#7a7a7a" : "#1e1e1e";
      const option = createOption(name, truncateName(name, 32), color);
      option.title = name;
      folderSelect.appendChild(option);
    });
    if (selected && Array.from(folderSelect.options).some((opt) => opt.value === selected)) {
      folderSelect.value = selected;
    } else {
      folderSelect.value = "__all__";
    }
  }

  markFoldersPending() {
    const { foldersRefreshBtn } = this.dom;
    this.uiState.foldersNeedRefresh = true;
    foldersRefreshBtn?.classList.add("needs-refresh");
    if (this.uiState.foldersRefreshMode === "AUTO" && !this.uiState.operationInProgress) {
      this.refreshFoldersView({ auto: true });
    }
  }

  clearFoldersPending() {
    const { foldersRefreshBtn } = this.dom;
    this.uiState.foldersNeedRefresh = false;
    foldersRefreshBtn?.classList.remove("needs-refresh");
  }

  toggleFoldersRefreshMode(forceAuto = null) {
    if (typeof forceAuto === "boolean") {
      this.uiState.foldersRefreshMode = forceAuto ? "AUTO" : "MANUAL";
    } else {
      this.uiState.foldersRefreshMode = this.uiState.foldersRefreshMode === "AUTO" ? "MANUAL" : "AUTO";
    }
    if (this.uiState.foldersRefreshMode === "AUTO" && this.uiState.foldersNeedRefresh) {
      this.refreshFoldersView({ auto: true });
    }
  }

  async refreshFoldersView({ auto = false } = {}) {
    if (!this.uiState.foldersNeedRefresh && !auto) return;
    if (this.uiState.operationInProgress) return;
    this.clearFoldersPending();
    this.startOperation("🔁 Przeliczanie folderów i kontenerów...");
    try {
      this.processAndRender();
    } finally {
      this.finishOperation();
    }
  }

  startProgress(label = "") {
    const { progressContainer, progressFill, progressLabel } = this.dom;
    if (!progressContainer || !progressFill) return;
    clearInterval(this.progressInterval);
    this.progressValue = 0;
    progressFill.style.width = "0%";
    progressContainer.classList.remove("hidden");
    if (progressLabel) progressLabel.textContent = label;
    this.progressInterval = setInterval(() => {
      const increment = Math.random() * 12 + 4;
      this.progressValue = Math.min(this.progressValue + increment, 94);
      progressFill.style.width = `${this.progressValue}%`;
    }, 220);
  }

  finishProgress(message = "") {
    const { progressContainer, progressFill, progressLabel } = this.dom;
    if (!progressContainer || !progressFill) return;
    clearInterval(this.progressInterval);
    this.progressInterval = null;
    this.progressValue = 100;
    progressFill.style.width = "100%";
    if (progressLabel && message) progressLabel.textContent = message;
    setTimeout(() => {
      progressContainer.classList.add("hidden");
      progressFill.style.width = "0%";
    }, 450);
    if (message) {
      this.uiState.pendingStatusMessage = message;
    }
  }

  stopProgress() {
    const { progressContainer, progressFill } = this.dom;
    clearInterval(this.progressInterval);
    this.progressInterval = null;
    this.progressValue = 0;
    if (progressContainer) progressContainer.classList.add("hidden");
    if (progressFill) progressFill.style.width = "0%";
  }

  startOperation(message) {
    const { fileStatus } = this.dom;
    this.uiState.operationInProgress = true;
    if (fileStatus) {
      this.uiState.fileStatusBackup = fileStatus.textContent || "";
      fileStatus.classList.remove("hidden");
      fileStatus.textContent = message;
      fileStatus.classList.remove("status-success");
      fileStatus.classList.add("busy");
    }
  }

  finishOperation() {
    const { fileStatus } = this.dom;
    this.uiState.operationInProgress = false;
    if (fileStatus) {
      fileStatus.classList.remove("busy");
      if (this.uiState.pendingStatusMessage) {
        this.showTransientStatus(this.uiState.pendingStatusMessage);
        this.uiState.pendingStatusMessage = "";
      } else {
        this.refreshFileStatus();
        if (!fileStatus.textContent && this.uiState.fileStatusBackup) {
          fileStatus.textContent = this.uiState.fileStatusBackup;
        }
      }
    }
    this.uiState.fileStatusBackup = "";
    if (this.uiState.foldersRefreshMode === "AUTO" && this.uiState.foldersNeedRefresh) {
      this.refreshFoldersView({ auto: true });
    }
  }

  showStatusMessage(message, duration = 3000) {
    if (!message) return;
    if (this.uiState.operationInProgress) {
      this.uiState.pendingStatusMessage = message;
      return;
    }
    this.showTransientStatus(message, duration);
  }

  async performAlbumOperation(type, fn, { skipRender = false } = {}) {
    const message =
      type === "remove"
        ? "Trwa usuwanie albumu z folderu, proszę czekać..."
        : "Trwa przypisywanie albumu do folderu, proszę czekać...";
    try {
      this.startOperation(message);
      await Promise.resolve(fn());
      if (!skipRender) {
        this.scheduleProcessAndRender();
      }
    } catch (err) {
      this.showStatusMessage(err.message || err);
    } finally {
      this.finishOperation();
    }
  }

  async handleSave() {
  if (!this.store.records.length) {
    this.showStatusMessage("📂 Brak danych do zapisania! Najpierw pobierz dane z SQLite / bazy danych.");
    return;
  }

  try {
    this.startOperation("💾 Zapisuję dane do SQLite / bazy danych...");
    this.startProgress("Zapisywanie danych do SQLite / bazy danych...");

    const payload = {
      records: this.store.getSerializableRecords(),
      collections: this.store.getSerializableCollections(),
      containers: this.store.getSerializableContainers(),
      folders: this.store.getSerializableFolders(),
      albumFolders: this.store.getSerializableAlbumFolders(),
      sheetName: this.store.currentSheetName || "Sheet1"
    };
    const response = await updateWorkbook(payload);

    const message = response?.message || "✅ Zapisano dane w SQLite / bazie danych.";
    this.finishProgress(message);

    if (response?.updated_at) {
      this.store.setFileMeta({
        name: response.file_name || this.store.currentFileName,
        timestamp: response.updated_at || Date.now()
      });
      this.refreshFileStatus();
    }

    this.persistStoredSelections();
    this.persistActiveFilterPreset();
    this.persistRemixState();
    this.persistRatingState();
    this.flashFileUpdated();
  } catch (error) {
    this.showStatusMessage(`❌ Nie udało się zapisać danych: ${error.message}`);
    console.error("Błąd zapisu", error);
    this.stopProgress();
  } finally {
    this.finishOperation();
  }
  }

  async handleAppCloseRequest() {
    const confirmed = await this.confirmModal({
      title: "Zamknięcie aplikacji",
      message: "Czy chcesz zapisać wprowadzone zmiany przed zamknięciem aplikacji?",
      confirmText: "ZAPISZ",
      cancelText: "ANULUJ"
    });
    if (confirmed) {
      await this.handleSave();
    }
    if (window.electronAPI?.confirmAppClose) {
      window.electronAPI.confirmAppClose();
    }
  }

  async handleDatabaseBackup() {
    if (this.uiState.operationInProgress) return;
    let modalMessage = "";
    try {
      this.startOperation("🗄️ Tworzę kopię bazy danych SQLite...");

      const response = await backupDatabase();
      const fileName = response?.backupFileName || "music_database.sqlite";

      this.uiState.pendingStatusMessage = `✅ Zapisano backup bazy danych: ${fileName}.`;
      modalMessage = `✅ Backup bazy danych gotowy.\n📄 Plik: ${fileName}\n📂 Folder: ${response?.backupPath || ""}`;
    } catch (error) {
      this.showStatusMessage(`❌ Nie udało się wykonać backupu bazy danych: ${error.message}`);
      console.error(error);
    } finally {
      this.finishOperation();
    }
    if (modalMessage) {
      await this.infoModal({ title: "Backup bazy danych", message: modalMessage });
    }
  }

  async handleDatabaseCheck() {
    if (this.uiState.operationInProgress) return;
    let modalMessage = "";
    try {
      this.startOperation("🔎 Sprawdzam kompletność danych...");

      const collectionName =
        this.uiState.activeCollection && this.uiState.activeCollection !== "__all__"
          ? this.uiState.activeCollection
          : null;
      const response = await checkDatabaseRecords({ collectionName });
      const total = Number(response?.totalRecords ?? 0);
      const incomplete = Number(response?.incompleteRecords ?? 0);
      const missingCounts = response?.missingCounts || {};

      const summaryLines = [`✅ Sprawdzono ${total} albumów.`];
      if (incomplete) {
        summaryLines.push(`⚠️ Niekompletne dane: ${incomplete}`);
      } else {
        summaryLines.push("✅ Wszystkie dane są kompletne.");
      }

      Object.entries(missingCounts).forEach(([field, count]) => {
        const numeric = Number(count || 0);
        if (numeric) summaryLines.push(`🔸 Brak ${field}: ${numeric}`);
      });

      if (response?.errorContainerName) {
        summaryLines.push(`📂 Kontener błędów: ${response.errorContainerName}`);
        if (response?.errorFoldersCreated) {
          summaryLines.push(`📁 Utworzone foldery: ${response.errorFoldersCreated}`);
        }
        if (response?.errorAssignmentsInserted) {
          summaryLines.push(`🧩 Przypisania albumów: ${response.errorAssignmentsInserted}`);
        }
      }

      this.uiState.pendingStatusMessage = incomplete
        ? `⚠️ Wykryto niekompletne dane: ${incomplete}.`
        : "✅ Dane kompletne.";
      modalMessage = summaryLines.join("\n");
    } catch (error) {
      this.showStatusMessage(`❌ Nie udało się sprawdzić danych: ${error.message}`);
      console.error(error);
    } finally {
      this.finishOperation();
    }
    if (modalMessage) {
      await this.infoModal({ title: "Sprawdź dane", message: modalMessage });
    }
  }

  async exportToXlsx() {
    let modalMessage = "";
    try {
       this.startOperation("📤 Eksportuję dane z SQLite / bazy danych do XLSX...");

      const directory = await this.getActiveDataDirectory("exportDb");
      if (!directory) {
        this.finishOperation();
        return;
      }

      const response = await exportWorkbookToFile({ directory });
      const summary = response?.summary || "✅ Eksport zakończony.";
      const fileName = response?.fileName || response?.filePath?.split(/[/\\]/).pop();

      this.uiState.pendingStatusMessage = summary.split("\n")[0];
      modalMessage = `${summary}\n📄 Plik: ${fileName || "music_database.xlsx"}\n📂 Zapisano w: ${response?.filePath || directory}`;
    } catch (error) {
      this.showStatusMessage(`❌ Nie udało się wyeksportować danych: ${error.message}`);
      console.error(error);
    } finally {
      this.finishOperation();
    }
    if (modalMessage) {
      await this.infoModal({ title: "Eksport danych", message: modalMessage });
    }
  }

  async importFromXlsx() {
    let modalMessage = "";
    try {
      this.startOperation("📥 Importuję dane z XLSX do SQLite / bazy danych...");

      const source = await this.resolveImportSource({ operationKey: "importDb", prefix: DATA_PREFIXES.importDb });
      if (!source) {
        this.finishOperation();
        return;
      }
      const confirmed = await this.confirmModal({
        title: "Potwierdź import",
        message: `Czy na pewno wczytać plik ${source.fileName} do bazy?`,
        confirmText: "TAK",
        cancelText: "NIE"
      });
      if (!confirmed) {
        this.finishOperation();
        return;
      }

      const response = await importWorkbookFromFile({
        directory: source.directory,
        filePath: source.filePath,
        prefix: DATA_PREFIXES.importDb
      });
      const summary = response?.summary || "✅ Import zakończony.";
      this.uiState.updateDbLinks = new Set();

      await this.reloadFromDatabase(false);
      this.uiState.pendingStatusMessage = summary.split("\n")[0];
      modalMessage = `${summary}\n📄 Plik: ${source.fileName}\n📂 Folder: ${source.directory}`;
    } catch (error) {
      this.showStatusMessage(`❌ Nie udało się zaimportować danych: ${error.message}`);
      console.error(error);
    } finally {
      this.finishOperation();
    }
    if (modalMessage) {
      await this.infoModal({ title: "Import danych", message: modalMessage });
    }
  }

  async importNewsFromXlsx() {
    let modalMessage = "";
    let skipReload = false;
    try {
      this.startOperation("📥 Importuję nowe rekordy z XLSX do SQLite / bazy danych...");

      const source = await this.resolveImportSource({ operationKey: "updateDb", prefix: DATA_PREFIXES.updateDb });
      if (!source) {
        this.finishOperation();
        return;
      }
      const confirmed = await this.confirmModal({
        title: "Potwierdź import",
        message: `Czy na pewno wczytać plik ${source.fileName} do bazy?`,
        confirmText: "TAK",
        cancelText: "NIE"
      });
      if (!confirmed) {
        this.finishOperation();
        return;
      }

      const response = await importNewsWorkbookFromFile({
        directory: source.directory,
        filePath: source.filePath,
        prefix: DATA_PREFIXES.updateDb
      });
      const summary = response?.summary || "✅ Dodano nowe rekordy.";
      this.uiState.updateDbLinks = new Set(response?.insertedLinks || []);
      const duplicateFileName = response?.duplicatesFileName;
      const duplicateFilePath = response?.duplicatesFilePath;
      const duplicateNote = duplicateFileName
        ? `\n📄 Duplikaty zapisano w: ${duplicateFileName}\n📂 Folder: ${duplicateFilePath || source.directory}`
        : "";

      const inserted = Number(response?.total ?? 0);
      if (inserted === 0) {
        this.uiState.pendingStatusMessage = summary.split("\n")[0];
        modalMessage = `${summary}\nℹ️ Dodano 0: wszystko było duplikatem (TIDAL_LINK) albo wiersze nie miały TIDAL_LINK.\n📂 Użyto pliku: ${source.fileName}\n📁 Folder: ${source.directory}${duplicateNote}`;
        skipReload = true;
      }

      if (!skipReload) {
        await this.reloadFromDatabase(false);
        this.uiState.pendingStatusMessage = summary.split("\n")[0];
        modalMessage = `${summary}\n📄 Plik: ${source.fileName}\n📂 Folder: ${source.directory}${duplicateNote}`;
      }
    } catch (error) {
      this.showStatusMessage(`❌ Nie udało się zaimportować nowych danych: ${error.message}`);
      console.error(error);
    } finally {
      this.finishOperation();
    }
    if (modalMessage) {
      await this.infoModal({ title: "Import nowych danych", message: modalMessage });
    }
  }

  async importFromJson() {
    let modalMessage = "";
    let progressModal = null;
    let unsubscribe = () => {};
    try {

      const directory = await this.getActiveDataDirectory("importJson");
      if (!directory) {
        return;
      }

      let resolved = null;
      try {
        resolved = await resolveJsonFile({ directory });
      } catch (error) {
        resolved = null;
      }
      const selection = await this.openJsonImportDialog({
        directory,
        filePath: resolved?.filePath,
        fileName: resolved?.fileName
      });
      if (!selection) {
        return;
      }

      this.startOperation("📥 Importuję dane z JSON do SQLite / bazy danych...");

      const collectionName =
        this.uiState.activeCollection && this.uiState.activeCollection !== "__all__"
          ? this.uiState.activeCollection
          : null;
      progressModal = this.openImportProgressModal({
        title: "Import JSON",
        message: `Plik: ${selection.fileName}`
      });
      const progressHandler = (payload) => {
        progressModal.update(payload || {});
      };
      unsubscribe = onImportJsonProgress(progressHandler);

      const response = await importJsonFromFile({
        directory,
        filePath: selection.filePath,
        collectionName
      });
      unsubscribe();
      progressModal.close();
      const summary = response?.summary || "✅ Import JSON zakończony.";
      const fileName = response?.fileName || selection.fileName || "import.json";

      await this.reloadFromDatabase(false);
      this.selectOnlyLabel("unknown");
      this.uiState.pendingStatusMessage = summary.split("\n")[0];
      modalMessage = `${summary}\n📄 Plik: ${fileName}\n📂 Folder: ${directory}`;
    } catch (error) {
      this.showStatusMessage(`❌ Nie udało się zaimportować danych JSON: ${error.message}`);
      console.error(error);
      unsubscribe();
      if (progressModal) progressModal.close();
    } finally {
      this.finishOperation();
    }
    if (modalMessage) {
      await this.infoModal({ title: "Import JSON", message: modalMessage });
    }
  }

  async runQobuzScrape() {
    let progressModal = null;
    let unsubscribe = () => {};
    try {
      this.startOperation("🕸️ Uruchamiam Qobuz Scraper...");
      progressModal = this.openImportProgressModal({
        title: "Qobuz Scraper",
        message: "Starting..."
      });

      unsubscribe = onQobuzScrapeProgress((payload = {}) => {
        const current = Number(payload.current || 0);
        const total = Number(payload.total || 0);
        let mappedCurrent = current;
        let mappedTotal = total;
        if (typeof payload.percent === "number") {
          mappedCurrent = Math.max(0, Math.min(100, Math.round(payload.percent)));
          mappedTotal = 100;
        }
        progressModal.update({
          current: mappedCurrent,
          total: mappedTotal,
          message: payload.message || "Working..."
        });
      });

      const response = await runQobuzScraper({});
      console.log("[Qobuz Scraper] Result:", response);
      this.showStatusMessage("✅ Qobuz scrape done");
    } catch (error) {
      console.error("[Qobuz Scraper] Error:", error);
      this.showStatusMessage(`❌ Qobuz scrape error: ${error.message}`);
    } finally {
      unsubscribe();
      if (progressModal) progressModal.close();
      this.finishOperation();
    }
  }

  getCustomFolderCount() {
    let count = 0;
    this.store.foldersList.forEach((name) => {
      if (name !== "brak") count += 1;
    });
    return count;
  }

  getCustomContainerCount() {
    let count = 0;
    this.store.containersList.forEach((name) => {
      if (name !== "brak") count += 1;
    });
    return count;
  }

  getCustomCollectionCount() {
    let count = 0;
    this.store.collectionsList.forEach((name) => {
      if (name !== "brak") count += 1;
    });
    return count;
  }

  handleOperationsScopeChange(scope) {
    this.uiState.operationsScope = scope || "folders";
  }

  handleCollectionChange(value) {
    this.uiState.activeCollection = value || "__all__";
    this.rebuildContainerSelect();
    this.rebuildFolderSelect();
    this.markFoldersPending();
    this.processAndRender();
  }

  async handleEntityAction(action) {
    const scope = this.uiState.operationsScope || "folders";
    if (scope === "collections") {
      if (action === "add") return this.handleCreateCollection();
      if (action === "edit") return this.handleEditCollection();
      if (action === "delete") return this.handleDeleteCollection();
    } else if (scope === "containers") {
      if (action === "add") return this.handleCreateContainer();
      if (action === "edit") return this.handleEditContainer();
      if (action === "delete") return this.handleDeleteContainer();
    }
    if (action === "add") return this.handleCreateFolder();
    if (action === "edit") return this.handleEditFolder();
    if (action === "delete") return this.handleDeleteFolder();
  }

  async handleCreateFolder() {
    if (this.getCustomFolderCount() >= 1000) {
      this.showStatusMessage("Osiągnięto limit 1000 folderów. Usuń istniejący folder, aby dodać nowy.");
      return;
    }
    const suggestedContainer =
      this.dom.containerSelect?.value && this.dom.containerSelect.value !== "__all__"
        ? this.dom.containerSelect.value
        : "brak";
    const dialog = await this.openEntityDialog({
      mode: "folder",
      title: "Nowy folder",
      defaultContainer: suggestedContainer,
      collectionFilter: this.uiState.activeCollection
    });
    if (!dialog) return;
    const name = dialog.name;
    if (!this.isValidEntityName(name)) {
      this.showStatusMessage("Nieprawidłowa nazwa folderu. Dozwolone maks. 255 znaków (w tym spacje).");
      return;
    }
    if (this.store.foldersList.has(name)) {
      this.showStatusMessage("Folder o takiej nazwie już istnieje.");
      return;
    }
    const container = dialog.container || "brak";
    this.store.ensureFolderEntry(name, container);
    this.store.ensureContainerEntry(container).folders.add(name);
    this.rebuildFolderSelect();
    this.dom.folderSelect.value = name;
    this.markFoldersPending();   // tylko flaga
    this.showTransientStatus(`☑ Utworzono folder: ${name}`);
  }

  async handleEditFolder() {
    const selected = this.dom.folderSelect?.value;
    if (!selected || selected === "__all__") {
      this.showStatusMessage("Wybierz folder do edycji.");
      return;
    }
    const entry = this.store.ensureFolderEntry(selected, "brak");
    const dialog = await this.openEntityDialog({
      mode: "folder",
      title: `Edytuj folder: ${selected}`,
      defaultName: selected,
      defaultContainer: entry.container,
      collectionFilter: this.uiState.activeCollection
    });
    if (!dialog) return;
    if (!this.isValidEntityName(dialog.name)) {
      this.showStatusMessage("Nieprawidłowa nazwa folderu.");
      return;
    }
    if (dialog.name !== selected && this.store.foldersList.has(dialog.name)) {
      this.showStatusMessage("Folder o takiej nazwie już istnieje.");
      return;
    }
     this.renameFolder(selected, dialog.name, dialog.container);
    this.processAndRender();
    this.showStatusMessage("Zaktualizowano folder.");
  }

  async handleDeleteFolder() {
    const selected = this.dom.folderSelect?.value;
    if (!selected || selected === "__all__") {
      this.showStatusMessage("Wybierz folder do usunięcia.");
      return;
    }
    if (!(await this.confirmModal({ title: "Potwierdź", message: `Czy na pewno usunąć folder "${selected}"?`, confirmText: "TAK", cancelText: "NIE" }))) return;
    this.removeFolder(selected);
    this.processAndRender();
    this.showStatusMessage("Folder usunięty.");
  }

  async handleCreateContainer() {
    if (this.getCustomContainerCount() >= 1000) {
      this.showStatusMessage("Osiągnięto limit 1000 kontenerów. Usuń istniejący, aby dodać nowy.");
      return;
    }
    const suggestedCollection =
      this.uiState.activeCollection && this.uiState.activeCollection !== "__all__"
        ? this.uiState.activeCollection
        : "brak";
    const dialog = await this.openEntityDialog({
      mode: "container",
      title: "Nowy kontener",
      defaultCollection: suggestedCollection
    });
    if (!dialog) return;
    const name = dialog.name;
    if (!this.isValidEntityName(name)) {
      this.showStatusMessage("Nieprawidłowa nazwa kontenera. Dozwolone maks. 255 znaków (w tym spacje).");
      return;
    }
    if (this.store.containersList.has(name)) {
      this.showStatusMessage("Kontener o takiej nazwie już istnieje.");
      return;
    }
    this.store.ensureContainerEntry(name, dialog.collection || "brak");
    if (dialog.collection && dialog.collection !== this.uiState.activeCollection) {
      this.uiState.activeCollection = dialog.collection;
      this.rebuildCollectionSelect();
    }
    this.rebuildContainerSelect();
    this.dom.containerSelect.value = name;
    this.rebuildFolderSelect();
    this.dom.folderSelect.value = "__all__";
    this.markFoldersPending();
    this.showTransientStatus(`☑ Utworzono kontener: ${name}`);
  }

  async handleEditContainer() {
    const selected = this.dom.containerSelect?.value;
    if (!selected || selected === "__all__" || selected === "brak") {
      this.showStatusMessage("Wybierz kontener do edycji.");
      return;
    }
    const currentCollection = this.store.containerMeta.get(selected)?.collection || "brak";
    const dialog = await this.openEntityDialog({
      mode: "container",
      title: `Edytuj kontener: ${selected}`,
      defaultName: selected,
      defaultCollection: currentCollection
    });
    if (!dialog) return;
    if (!this.isValidEntityName(dialog.name)) {
      this.showStatusMessage("Nieprawidłowa nazwa kontenera.");
      return;
    }
    if (dialog.name !== selected && this.store.containersList.has(dialog.name)) {
      this.showStatusMessage("Kontener o takiej nazwie już istnieje.");
      return;
    }
    this.renameContainer(selected, dialog.name);
    const collectionUpdate = dialog.collection
      ? this.store.setContainerCollection(dialog.name, dialog.collection)
      : { changed: false };
    if (collectionUpdate.changed) {
      this.markFoldersPending();
    }
    if (dialog.collection && dialog.collection !== this.uiState.activeCollection) {
      this.uiState.activeCollection = dialog.collection;
      this.rebuildCollectionSelect();
      this.rebuildContainerSelect();
      this.rebuildFolderSelect();
    }
    this.processAndRender();
    this.showStatusMessage("Zaktualizowano kontener.");
  }

  async handleDeleteContainer() {
    const selected = this.dom.containerSelect?.value;
    if (!selected || selected === "__all__" || selected === "brak") {
      this.showStatusMessage("Wybierz kontener do usunięcia.");
      return;
    }
    if (!(await this.confirmModal({ title: "Potwierdź", message: `Czy na pewno usunąć kontener "${selected}"?`, confirmText: "TAK", cancelText: "NIE" }))) return;
    this.removeContainer(selected);
    this.processAndRender();
    this.showStatusMessage("Kontener usunięty.");
  }

  async handleCreateCollection() {
    if (this.getCustomCollectionCount() >= 1000) {
      this.showStatusMessage("Osiągnięto limit 1000 kolekcji. Usuń istniejącą kolekcję, aby dodać nową.");
      return;
    }
    const dialog = await this.openEntityDialog({
      mode: "collection",
      title: "Nowa kolekcja"
    });
    if (!dialog) return;
    const name = dialog.name;
    if (!this.isValidEntityName(name)) {
      this.showStatusMessage("Nieprawidłowa nazwa kolekcji. Dozwolone maks. 255 znaków (w tym spacje).");
      return;
    }
    if (this.store.collectionsList.has(name)) {
      this.showStatusMessage("Kolekcja o takiej nazwie już istnieje.");
      return;
    }
    this.store.ensureCollectionEntry(name);
    this.rebuildCollectionSelect();
    if (this.dom.collectionSelect) {
      this.dom.collectionSelect.value = name;
      this.uiState.activeCollection = name;
    }
    this.rebuildContainerSelect();
    this.rebuildFolderSelect();
    this.markFoldersPending();
    this.showTransientStatus(`☑ Utworzono kolekcję: ${name}`);
  }

  async handleEditCollection() {
    const selected = this.dom.collectionSelect?.value;
    if (!selected || selected === "__all__" || selected === "brak") {
      this.showStatusMessage("Wybierz kolekcję do edycji.");
      return;
    }
    const dialog = await this.openEntityDialog({
      mode: "collection",
      title: `Edytuj kolekcję: ${selected}`,
      defaultName: selected
    });
    if (!dialog) return;
    if (!this.isValidEntityName(dialog.name)) {
      this.showStatusMessage("Nieprawidłowa nazwa kolekcji.");
      return;
    }
    if (dialog.name !== selected && this.store.collectionsList.has(dialog.name)) {
      this.showStatusMessage("Kolekcja o takiej nazwie już istnieje.");
      return;
    }
    this.store.renameCollectionRecords(selected, dialog.name);
    this.rebuildCollectionSelect();
    if (this.dom.collectionSelect) {
      this.dom.collectionSelect.value = dialog.name;
      this.uiState.activeCollection = dialog.name;
    }
    this.rebuildContainerSelect();
    this.rebuildFolderSelect();
    this.markFoldersPending();
    this.processAndRender();
    this.showStatusMessage("Zaktualizowano kolekcję.");
  }

  async handleDeleteCollection() {
    const selected = this.dom.collectionSelect?.value;
    if (!selected || selected === "__all__" || selected === "brak") {
      this.showStatusMessage("Wybierz kolekcję do usunięcia.");
      return;
    }
    if (!(await this.confirmModal({ title: "Potwierdź", message: `Czy na pewno usunąć kolekcję "${selected}"?`, confirmText: "TAK", cancelText: "NIE" }))) return;
    this.store.clearCollectionAssignments(selected);
    this.uiState.activeCollection = "__all__";
    this.rebuildCollectionSelect();
    this.rebuildContainerSelect();
    this.rebuildFolderSelect();
    this.markFoldersPending();
    this.processAndRender();
    this.showStatusMessage("Kolekcja usunięta.");
  }

  getFilteredExportContext() {
    const { folderSelect, containerSelect } = this.dom;
    const category = this.uiState.currentCategory || "DB";
    const folderFilter = folderSelect?.value;
    const containerFilter = containerSelect?.value;
    const list = this.store.getFilteredCategoryList(category, { folderFilter, containerFilter });

    const slugify = (value, fallback = "wyniki") => {
      if (!value) return fallback;
      const cleaned = String(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/gi, "_")
        .replace(/^_+|_+$/g, "");
      return cleaned || fallback;
    };

    let scopeLabel = category;
    if (category === "FD") {
      if (folderFilter && folderFilter !== "__all__") scopeLabel = folderFilter;
      else if (containerFilter && containerFilter !== "__all__") scopeLabel = containerFilter;
      else scopeLabel = "folders";
    }

    const activeSelectors = Array.from(this.uiState.selectedSelectors || []).sort().join("");
    const selectorsLabel = activeSelectors && activeSelectors.length ? activeSelectors : "wszyscy";

    return { list, folderFilter, containerFilter, category, scopeLabel, selectorsLabel, slugify };
  }

  async exportFilteredSelection() {
    const context = this.getFilteredExportContext();

    if (!context.list.length) {
      this.showStatusMessage("Brak albumów do wyeksportowania dla wybranych filtrów.");
      return;
    }

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

    const data = context.list.map((rec) => {
      const album = rec.album || rec;
      const numericOriginal = Number(album.release_original);
      const releaseValue =
        Number.isFinite(numericOriginal) && numericOriginal > 0 ? album.release_original : album.release_date;
      return {
        ID_ALBUMU: album.id_albumu ?? "",
        SELECTOR: album.selector,
        HEARD: album.heard,
        FAVORITE: album.favorite ? 1 : 0,
        RATING: Number(album.rating) || 0,
        LABEL: album.label,
        TIDAL_LINK: album.link,
        FORMAT: album.format || "",
        ROON_ID: album.roon_id || this.buildRoonId(album.id_albumu),
        SPOTIFY_LINK: album.spotify_link || "",
        APPLE_MUSIC_LINK: album.apple_music_link || "",
        CATALOG_NUMBER: album.catalog_number || "",
        PICTURE: album.picture,
        ARTIST_RAFFAELLO: album.artist_raffaello ?? album.artist,
        ARTIST_TIDAL: album.artist_tidal ?? album.artist,
        TITLE_RAFFAELLO: album.title_raffaello ?? album.title,
        TITLE_TIDAL: album.title_tidal ?? album.title,
        DURATION: album.duration,
        RELEASE_DATE: releaseValue
      };
    });

    const sheet = window.XLSX.utils.json_to_sheet(data, { header: headers, skipHeader: false });
    const workbook = window.XLSX.utils.book_new();
    const safeSheet = context.slugify(context.scopeLabel).slice(0, 25) || "wyniki";
    window.XLSX.utils.book_append_sheet(workbook, sheet, safeSheet);

    const directory = await this.getActiveDataDirectory("download");
    if (!directory) return;

    const filename = this.buildTimestampedFileName(DATA_PREFIXES.importDb, "xlsx");
    try {
      const buffer = window.XLSX.write(workbook, { bookType: "xlsx", type: "array" });
      const filePath = await saveBinaryFile(filename, buffer, directory);
      await this.infoModal({
        title: "Eksport albumów",
        message: `✅ Wyeksportowano ${context.list.length} albumów.\n📂 ${filePath}`
      });
    } catch (error) {
      this.showStatusMessage(`❌ Nie udało się zapisać pliku XLSX: ${error.message}`);
    }
  }

  async exportFilteredLinks() {
    const context = this.getFilteredExportContext();
    const links = context.list.map((rec) => (rec.album || rec).link).filter(Boolean);
    
    if (!links.length) {
      this.showStatusMessage("Brak linków do zapisania dla wybranych filtrów.");
      return;
    }

    const directory = await this.getActiveDataDirectory("download");
    if (!directory) return;

    const filename = this.buildTimestampedFileName(DATA_PREFIXES.importDb, "txt");
    try {
      const filePath = await saveTextFile(filename, links.join("\n"), directory);
      await this.infoModal({
        title: "Eksport linków",
        message: `✅ Zapisano ${links.length} linków.\n📂 ${filePath}`
      });
    } catch (error) {
      this.showStatusMessage(`❌ Nie udało się zapisać pliku TXT: ${error.message}`);
    }
  }

  renameFolder(oldName, newName, container) {
    const result = this.store.renameFolderRecords(oldName, newName, container);
    if (result.changed) {
      this.markFoldersPending();
    }
    this.rebuildFolderSelect();
    this.dom.folderSelect.value = newName;
  }

  renameContainer(oldName, newName) {
    const result = this.store.renameContainerRecords(oldName, newName);
    if (result.changed) {
      this.markFoldersPending();
    }
    this.rebuildContainerSelect();
    this.dom.containerSelect.value = newName;
  }

  removeFolder(name) {
    const result = this.store.clearFolderAssignments(name);
    if (result.changed) {
      this.markFoldersPending();
    }
    this.rebuildFolderSelect();
    this.dom.folderSelect.value = "__all__";
  }

  removeContainer(name) {
    const result = this.store.clearContainerAssignments(name);
    if (result.changed) {
      this.markFoldersPending();
    }
    this.rebuildContainerSelect();
    this.dom.containerSelect.value = "__all__";
  }

  isValidEntityName(name) {
    if (typeof name !== "string") return false;
    const trimmed = name.trim();
    if (!trimmed) return false;
    if (trimmed.length > 255) return false;
    return true;
  }

  openEntityDialog({
    mode = "folder",
    title = "",
    defaultName = "",
    defaultContainer = "brak",
    defaultCollection = "brak",
    collectionFilter = "__all__"
  } = {}) {
    return new Promise((resolve) => {
      // Usuń ewentualne pozostałości poprzedniego dialogu, które mogłyby blokować focus
      document.querySelectorAll(".entity-dialog-backdrop").forEach((el) => el.remove());
      const backdrop = document.createElement("div");
      backdrop.className = "entity-dialog-backdrop";

      const dialog = document.createElement("div");
      dialog.className = "entity-dialog";
      const heading = document.createElement("h3");
      heading.textContent = title;
      dialog.appendChild(heading);

      const nameLabel = document.createElement("label");
      nameLabel.textContent =
        mode === "folder" ? "Nazwa folderu" : mode === "container" ? "Nazwa kontenera" : "Nazwa kolekcji";
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.value = defaultName || "";
      nameInput.placeholder =
        mode === "folder" ? "np. Moje ulubione" : mode === "container" ? "np. Kontener A" : "np. Kolekcja 1";
      dialog.appendChild(nameLabel);
      dialog.appendChild(nameInput);

      let containerSelectEl = null;
      let collectionSelectEl = null;
      if (mode === "folder") {
        const containerLabel = document.createElement("label");
        containerLabel.textContent = "Kontener";
        containerSelectEl = document.createElement("select");
        const containers =
          collectionFilter && collectionFilter !== "__all__"
            ? this.store.getContainersForCollection(collectionFilter)
            : Array.from(this.store.containersList);
        containers
          .sort((a, b) => a.localeCompare(b, "pl"))
          .forEach((container) => {
            const option = document.createElement("option");
            option.value = container;
            option.textContent = container;
            if (container === defaultContainer) option.selected = true;
            containerSelectEl.appendChild(option);
          });
        dialog.appendChild(containerLabel);
        dialog.appendChild(containerSelectEl);
        } else if (mode === "container") {
        const collectionLabel = document.createElement("label");
        collectionLabel.textContent = "Kolekcja";
        collectionSelectEl = document.createElement("select");
        Array.from(this.store.collectionsList)
          .sort((a, b) => a.localeCompare(b, "pl"))
          .forEach((collection) => {
            const option = document.createElement("option");
            option.value = collection;
            option.textContent = collection;
            if (collection === defaultCollection) option.selected = true;
            collectionSelectEl.appendChild(option);
          });
        dialog.appendChild(collectionLabel);
        dialog.appendChild(collectionSelectEl);
      }

      if (mode === "folder") {
        const info = document.createElement("small");
        info.textContent = "SHIFT + klik przypisuje album do wybranego folderu, SHIFT + PPM usuwa przypisanie.";
        dialog.appendChild(info);
      }

      const actions = document.createElement("div");
      actions.className = "entity-dialog-actions";
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "cancel";
      cancelBtn.textContent = "Anuluj";
      const confirmBtn = document.createElement("button");
      confirmBtn.className = "confirm";
      confirmBtn.textContent = "Zapisz";
      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);
      dialog.appendChild(actions);

      backdrop.appendChild(dialog);
      document.body.appendChild(backdrop);

      const close = (result) => {
        document.body.removeChild(backdrop);
        document.removeEventListener("keydown", onKeyDown);
        resolve(result);
      };

      const onKeyDown = (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          confirmBtn.click();
        }
      };

      cancelBtn.addEventListener("click", () => close(null));
      confirmBtn.addEventListener("click", () => {
        const nameValue = nameInput.value.trim();
        const containerValue = containerSelectEl ? containerSelectEl.value : undefined;
        const collectionValue = collectionSelectEl ? collectionSelectEl.value : undefined;
        close({ name: nameValue, container: containerValue, collection: collectionValue });
      });
      document.addEventListener("keydown", onKeyDown);
       // Użyj microtaska, by upewnić się, że focus trafia w pole nazwy natychmiast po wyrenderowaniu dialogu
      queueMicrotask(() => {
        nameInput.focus();
        nameInput.select();
      });
    });
  }

  showTransientStatus(message, duration = 3000) {
      const { fileStatus } = this.dom;
      if (!fileStatus || !message) return;
      if (this.uiState.operationInProgress) return;
      clearTimeout(this.uiState.statusTimeout);
      this.uiState.statusTimeout = null;
      fileStatus.classList.remove("status-updated");
      fileStatus.classList.remove("busy");
      fileStatus.classList.remove("status-error");
      fileStatus.classList.remove("status-remix-on");
      fileStatus.classList.remove("status-remix-off");
      fileStatus.classList.remove("status-remix-warning");
      fileStatus.classList.add("status-success");
      fileStatus.classList.remove("hidden");
      fileStatus.textContent = message;
      this.uiState.statusTimeout = setTimeout(() => {
        fileStatus.classList.remove("status-updated");
        fileStatus.classList.remove("status-success");
        this.refreshFileStatus();
      }, duration);
    }
  refreshFileStatus() {
    const { fileStatus } = this.dom;
    if (!fileStatus) return;
    if (this.uiState.operationInProgress) return;

    clearTimeout(this.uiState.statusTimeout);
    this.uiState.statusTimeout = null;
    fileStatus.classList.remove("status-updated");
    fileStatus.classList.remove("status-success");
    fileStatus.classList.remove("status-error");
    fileStatus.classList.remove("status-remix-on");
    fileStatus.classList.remove("status-remix-off");
    fileStatus.classList.remove("status-remix-warning");

    const name = this.store.currentFileName;
    const hideSqliteNotice =
      typeof name === "string" && name.includes("SQLite / baza danych – tabela");

    if (name && !hideSqliteNotice) {
      fileStatus.textContent = name;
      fileStatus.classList.remove("hidden");
      this.uiState.statusTimeout = setTimeout(() => {
        fileStatus.textContent = "";
        fileStatus.classList.add("hidden");
      }, 5000);
    } else {
      fileStatus.textContent = "";
      fileStatus.classList.add("hidden");
    }
  }

  flashFileUpdated() {
    const { fileStatus } = this.dom;
    if (!fileStatus) return;
    if (this.uiState.operationInProgress) return;
    clearTimeout(this.uiState.statusTimeout);
    fileStatus.classList.add("status-updated");
    fileStatus.classList.remove("hidden");
    fileStatus.textContent = "ZAKTUALIZOWANO";
    this.uiState.statusTimeout = setTimeout(() => {
      fileStatus.classList.remove("status-updated");
      this.refreshFileStatus();
    }, 2000);
  }

  clearFileStatus() {
    const { fileStatus } = this.dom;
    if (!fileStatus) return;
    clearTimeout(this.uiState.statusTimeout);
    this.uiState.statusTimeout = null;
    fileStatus.classList.remove("status-updated");
    fileStatus.classList.remove("status-success");
    fileStatus.classList.remove("busy");
    fileStatus.textContent = "";
    fileStatus.classList.add("hidden");
  }
}

export { UiController };
