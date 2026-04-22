const browserApi = typeof browser !== "undefined" ? browser : chrome;

const MAX_PAGE_TRANSLATION_RULES = 3;
const STATUS_MESSAGE_DURATION = 3200;

const elements = {
  sidebarTabs: Array.from(document.querySelectorAll(".sidebar-tab")),
  settingsPanels: Array.from(document.querySelectorAll(".settings-panel")),
  extensionVersion: document.getElementById("extensionVersion"),
  pageTranslationMode: document.getElementById("pageTranslationMode"),
  pageTranslationRulesField: document.getElementById("pageTranslationRulesField"),
  pageTranslationRules: document.getElementById("pageTranslationRules"),
  addPageTarget: document.getElementById("addPageTarget"),
  showOriginalOnTranslatedSelection: document.getElementById("showOriginalOnTranslatedSelection"),
  selectionTargetLanguage: document.getElementById("selectionTargetLanguage"),
  siteForm: document.getElementById("siteForm"),
  siteInput: document.getElementById("siteInput"),
  siteList: document.getElementById("siteList"),
  clearAll: document.getElementById("clearAll"),
  exportSettings: document.getElementById("exportSettings"),
  importSettings: document.getElementById("importSettings"),
  importFile: document.getElementById("importFile"),
  status: document.getElementById("status")
};

let state = {
  sites: [],
  autoTranslate: true,
  pageTranslationMode: TRANSLATOR_DEFAULT_SETTINGS.pageTranslationMode,
  pageTranslationRules: normalizePageTranslationRules(TRANSLATOR_DEFAULT_SETTINGS.pageTranslationRules),
  showOriginalOnTranslatedSelection: TRANSLATOR_DEFAULT_SETTINGS.showOriginalOnTranslatedSelection,
  selectionTargetLanguage: TRANSLATOR_DEFAULT_SETTINGS.selectionTargetLanguage
};
let statusTimeoutId = null;

initialize().catch((error) => {
  console.error("Failed to load options", error);
  setStatus("Could not load settings.");
});

async function initialize() {
  populateLanguageSelects();
  elements.extensionVersion.textContent = browserApi.runtime.getManifest().version;

  const stored = await browserApi.storage.sync.get(null);
  const pageTranslationRules = getStoredPageTranslationRules(stored);
  state = {
    sites: normalizeSites(Array.isArray(stored.sites) ? stored.sites : TRANSLATOR_DEFAULT_SETTINGS.sites),
    autoTranslate: stored.autoTranslate !== false,
    pageTranslationMode: normalizePageTranslationMode(stored.pageTranslationMode),
    pageTranslationRules,
    showOriginalOnTranslatedSelection: stored.showOriginalOnTranslatedSelection !== false,
    selectionTargetLanguage: normalizeLanguage(
      stored.selectionTargetLanguage,
      getPrimaryTargetLanguage(pageTranslationRules)
    )
  };

  elements.pageTranslationMode.value = state.pageTranslationMode;
  elements.showOriginalOnTranslatedSelection.checked = state.showOriginalOnTranslatedSelection;
  elements.selectionTargetLanguage.value = state.selectionTargetLanguage;
  renderPageTranslationRules();
  renderSites();
  bindEvents();
}

function bindEvents() {
  elements.sidebarTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      setActiveTab(tab.dataset.tab);
    });
  });

  elements.pageTranslationMode.addEventListener("change", async () => {
    state.pageTranslationMode = normalizePageTranslationMode(elements.pageTranslationMode.value);
    renderPageTranslationRules();
    await saveState();
    renderSites();
    setStatus(`Page translation mode set to ${getPageTranslationModeLabel(state.pageTranslationMode)}.`);
  });

  elements.addPageTarget.addEventListener("click", async () => {
    if (state.pageTranslationRules.length >= MAX_PAGE_TRANSLATION_RULES) {
      setStatus("You can add up to 3 page translation rows.");
      return;
    }

    state.pageTranslationRules = [...state.pageTranslationRules, getNextPageTranslationRule(state.pageTranslationRules)];
    renderPageTranslationRules();
    await saveState();
    renderSites();
    setStatus(`Added page target. ${getPageTargetSummary()}.`);
  });

  elements.selectionTargetLanguage.addEventListener("change", async () => {
    state.selectionTargetLanguage = normalizeLanguage(
      elements.selectionTargetLanguage.value,
      TRANSLATOR_DEFAULT_SETTINGS.selectionTargetLanguage
    );
    await saveState();
    setStatus(`Highlight translation target set to ${getLanguageLabel(state.selectionTargetLanguage)}.`);
  });

  elements.showOriginalOnTranslatedSelection.addEventListener("change", async () => {
    state.showOriginalOnTranslatedSelection = elements.showOriginalOnTranslatedSelection.checked;
    await saveState();
    setStatus(
      state.showOriginalOnTranslatedSelection
        ? "Ctrl + highlight will show original text on translated pages when available."
        : "Ctrl + highlight will always translate the selected text."
    );
  });

  elements.siteForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const normalized = normalizeSite(elements.siteInput.value);
    if (!normalized) {
      setStatus("Enter a valid hostname like example.kr.");
      return;
    }

    if (state.sites.some((site) => site.pattern === normalized)) {
      setStatus("That website is already in the list.");
      return;
    }

    state.sites.push(createSiteSettings(normalized));
    state.sites.sort((left, right) => left.pattern.localeCompare(right.pattern));
    await saveState();
    renderSites();
    elements.siteInput.value = "";
    setStatus(`Added ${normalized}.`);
  });

  elements.clearAll.addEventListener("click", async () => {
    if (!state.sites.length) {
      return;
    }

    const confirmed = window.confirm("Clear all saved websites?");
    if (!confirmed) {
      return;
    }

    state.sites = [];
    await saveState();
    renderSites();
    setStatus("Removed all websites.");
  });

  elements.exportSettings.addEventListener("click", async () => {
    const exportPayload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: getSerializableSettings()
    };

    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "quick-page-translator-settings.json";
    link.click();
    URL.revokeObjectURL(url);
    setStatus("Settings exported.");
  });

  elements.importSettings.addEventListener("click", () => {
    elements.importFile.click();
  });

  elements.importFile.addEventListener("change", async () => {
    const file = elements.importFile.files?.[0];
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const importedSettings = normalizeImportedSettings(parsed?.settings ?? parsed);
      state = importedSettings;
      syncFormFromState();
      await saveState();
      renderPageTranslationRules();
      renderSites();
      setStatus("Settings imported.");
    } catch (error) {
      console.error("Failed to import settings", error);
      setStatus("Could not import settings. Use a valid exported JSON file.");
    } finally {
      elements.importFile.value = "";
    }
  });
}

function renderPageTranslationRules() {
  updateGlobalPageTranslationVisibility();

  if (state.pageTranslationMode !== "specific-languages") {
    elements.pageTranslationRules.innerHTML = "";
    elements.addPageTarget.disabled = true;
    return;
  }

  renderRuleEditor(
    elements.pageTranslationRules,
    state.pageTranslationRules,
    async (nextRules) => {
      state.pageTranslationRules = normalizePageTranslationRules(nextRules);
      renderPageTranslationRules();
      await saveState();
      renderSites();
      setStatus(`Page translation set to ${getPageTargetSummary()}.`);
    }
  );
  elements.addPageTarget.disabled = state.pageTranslationRules.length >= MAX_PAGE_TRANSLATION_RULES;
}

function renderSites() {
  elements.siteList.innerHTML = "";

  if (!state.sites.length) {
    const emptyItem = document.createElement("li");
    emptyItem.className = "empty";
    emptyItem.textContent = "No websites added yet.";
    elements.siteList.appendChild(emptyItem);
    return;
  }

  state.sites.forEach((site) => {
    const item = document.createElement("li");
    item.className = "site-card";

    const header = document.createElement("div");
    header.className = "site-card-header";

    const meta = document.createElement("div");
    meta.className = "site-card-meta";

    const label = document.createElement("span");
    label.className = "site-pill";
    label.textContent = site.pattern;

    const mode = document.createElement("span");
    mode.className = "site-card-mode";
    mode.textContent = site.followGlobalPageTranslation
      ? "Follows global page translation"
      : getSiteModeSummary(site);

    meta.append(label, mode);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "secondary";
    removeButton.textContent = "Delete";
    removeButton.addEventListener("click", async () => {
      const confirmed = window.confirm(`Delete ${site.pattern} from saved websites?`);
      if (!confirmed) {
        return;
      }

      state.sites = state.sites.filter((entry) => entry.pattern !== site.pattern);
      await saveState();
      renderSites();
      setStatus(`Removed ${site.pattern}.`);
    });

    header.append(meta, removeButton);

    const settings = document.createElement("div");
    settings.className = "site-settings";

    const followRow = document.createElement("label");
    followRow.className = "toggle-row site-follow-row";
    const followText = document.createElement("span");
    followText.textContent = "Follow global page translation";
    const followSwitch = document.createElement("span");
    followSwitch.className = "switch";
    const followInput = document.createElement("input");
    followInput.type = "checkbox";
    followInput.checked = site.followGlobalPageTranslation;
    const followSlider = document.createElement("span");
    followSlider.className = "switch-slider";
    followSwitch.append(followInput, followSlider);
    followRow.append(followText, followSwitch);

    const modeField = document.createElement("label");
    modeField.className = "field field-wide";
    const modeLabel = document.createElement("span");
    modeLabel.textContent = "Page translation mode";
    const modeSelect = document.createElement("select");
    modeSelect.innerHTML = `
      <option value="specific-languages">Specific languages</option>
      <option value="entire-page">Entire web page</option>
    `;
    modeSelect.value = site.pageTranslationMode;
    modeField.append(modeLabel, modeSelect);

    const rulesField = document.createElement("div");
    rulesField.className = "field field-wide";
    const rulesLabel = document.createElement("span");
    rulesLabel.textContent = "Page translation targets";
    const rulesList = document.createElement("div");
    rulesList.className = "page-rule-list";
    const addRuleButton = document.createElement("button");
    addRuleButton.type = "button";
    addRuleButton.className = "secondary add-rule-button";
    addRuleButton.textContent = "Add page target";
    const note = document.createElement("p");
    note.className = "field-note";
    note.textContent = "These custom rows are only used when this website is set to Specific languages.";
    rulesField.append(rulesLabel, rulesList, addRuleButton, note);

    const customSettings = document.createElement("div");
    customSettings.className = "language-grid";
    appendSiteCustomSettings(site, customSettings, modeField, rulesField);
    settings.append(followRow, customSettings);
    item.append(header, settings);
    elements.siteList.appendChild(item);

    followInput.addEventListener("change", async () => {
      site.followGlobalPageTranslation = followInput.checked;
      await saveState();
      renderSites();
      setStatus(
        site.followGlobalPageTranslation
          ? `${site.pattern} now follows the global page translation settings.`
          : `${site.pattern} now uses custom page translation settings.`
      );
    });

    modeSelect.addEventListener("change", async () => {
      site.pageTranslationMode = normalizePageTranslationMode(modeSelect.value);
      await saveState();
      renderSites();
      setStatus(`Updated page translation mode for ${site.pattern}.`);
    });

    addRuleButton.addEventListener("click", async () => {
      if (site.pageTranslationRules.length >= MAX_PAGE_TRANSLATION_RULES) {
        setStatus("You can add up to 3 page translation rows per website.");
        return;
      }

      site.pageTranslationRules = [
        ...site.pageTranslationRules,
        getNextPageTranslationRule(site.pageTranslationRules)
      ];
      await saveState();
      renderSites();
      setStatus(`Added a custom page target for ${site.pattern}.`);
    });

    renderRuleEditor(rulesList, site.pageTranslationRules, async (nextRules) => {
      site.pageTranslationRules = normalizePageTranslationRules(nextRules);
      await saveState();
      renderSites();
      setStatus(`Updated custom page translation settings for ${site.pattern}.`);
    });
    addRuleButton.disabled = site.pageTranslationMode !== "specific-languages"
      || site.pageTranslationRules.length >= MAX_PAGE_TRANSLATION_RULES;
  });
}

async function saveState() {
  state.pageTranslationRules = normalizePageTranslationRules(state.pageTranslationRules);

  await browserApi.storage.sync.set({
    sites: state.sites.map((site) => ({
      pattern: site.pattern,
      followGlobalPageTranslation: site.followGlobalPageTranslation,
      pageTranslationMode: site.pageTranslationMode,
      pageTranslationRules: site.pageTranslationRules.map((rule) => ({ ...rule }))
    })),
    autoTranslate: state.autoTranslate,
    pageTranslationMode: state.pageTranslationMode,
    pageTranslationRules: state.pageTranslationRules,
    showOriginalOnTranslatedSelection: state.showOriginalOnTranslatedSelection,
    selectionTargetLanguage: state.selectionTargetLanguage
  });
}

function syncFormFromState() {
  elements.pageTranslationMode.value = state.pageTranslationMode;
  elements.showOriginalOnTranslatedSelection.checked = state.showOriginalOnTranslatedSelection;
  elements.selectionTargetLanguage.value = state.selectionTargetLanguage;
  updateGlobalPageTranslationVisibility();
}

function setActiveTab(tabId) {
  elements.sidebarTabs.forEach((tab) => {
    const isActive = tab.dataset.tab === tabId;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-current", isActive ? "page" : "false");
  });

  elements.settingsPanels.forEach((panel) => {
    const isActive = panel.dataset.panel === tabId;
    panel.classList.toggle("active", isActive);
    panel.hidden = !isActive;
  });
}

function updateGlobalPageTranslationVisibility() {
  const showRules = state.pageTranslationMode === "specific-languages";
  elements.pageTranslationRulesField.hidden = !showRules;
  elements.pageTranslationRules.hidden = !showRules;
  elements.addPageTarget.hidden = !showRules;
}

function populateLanguageSelects() {
  elements.selectionTargetLanguage.innerHTML = "";
  TRANSLATOR_LANGUAGES.forEach((language) => {
    const option = document.createElement("option");
    option.value = language.code;
    option.textContent = language.label;
    elements.selectionTargetLanguage.appendChild(option);
  });
}

function buildLanguageSelect(selectedValue) {
  const select = document.createElement("select");
  TRANSLATOR_LANGUAGES.forEach((language) => {
    const option = document.createElement("option");
    option.value = language.code;
    option.textContent = language.label;
    option.selected = language.code === selectedValue;
    select.appendChild(option);
  });
  return select;
}

function getStoredPageTranslationRules(stored) {
  if (Array.isArray(stored.pageTranslationRules) && stored.pageTranslationRules.length) {
    return normalizePageTranslationRules(stored.pageTranslationRules);
  }

  const legacySourceLanguage = normalizeLanguage(
    stored.sourceLanguage,
    TRANSLATOR_DEFAULT_SETTINGS.pageTranslationRules[0].sourceLanguage
  );
  const legacyTargetLanguage = normalizeLanguage(
    stored.targetLanguage,
    TRANSLATOR_DEFAULT_SETTINGS.pageTranslationRules[0].targetLanguage
  );
  const additionalTargetLanguages = Array.isArray(stored.additionalTargetLanguages)
    ? stored.additionalTargetLanguages
    : [];

  return normalizePageTranslationRules([
    { sourceLanguage: legacySourceLanguage, targetLanguage: legacyTargetLanguage },
    ...additionalTargetLanguages.map((targetLanguage) => ({
      sourceLanguage: legacySourceLanguage,
      targetLanguage
    }))
  ]);
}

function normalizePageTranslationRules(rules) {
  if (!Array.isArray(rules) || !rules.length) {
    return cloneDefaultPageTranslationRules();
  }

  const normalized = rules
    .map((rule) => ({
      sourceLanguage: normalizeLanguage(
        rule?.sourceLanguage,
        TRANSLATOR_DEFAULT_SETTINGS.pageTranslationRules[0].sourceLanguage
      ),
      targetLanguage: normalizeLanguage(
        rule?.targetLanguage,
        TRANSLATOR_DEFAULT_SETTINGS.pageTranslationRules[0].targetLanguage
      )
    }))
    .map((rule) => {
      if (rule.sourceLanguage === rule.targetLanguage) {
        return {
          sourceLanguage: rule.sourceLanguage,
          targetLanguage: getFallbackTarget(rule.sourceLanguage)
        };
      }
      return rule;
    })
    .filter((rule, index, array) => {
      return array.findIndex((entry) => {
        return entry.sourceLanguage === rule.sourceLanguage && entry.targetLanguage === rule.targetLanguage;
      }) === index;
    })
    .slice(0, MAX_PAGE_TRANSLATION_RULES);

  return normalized.length ? normalized : cloneDefaultPageTranslationRules();
}

function normalizePageTranslationMode(value) {
  return value === "entire-page" ? "entire-page" : TRANSLATOR_DEFAULT_SETTINGS.pageTranslationMode;
}

function normalizeSites(sites) {
  if (!Array.isArray(sites)) {
    return [];
  }

  return sites
    .map((site) => normalizeSiteEntry(site))
    .filter(Boolean)
    .filter((site, index, array) => array.findIndex((entry) => entry.pattern === site.pattern) === index)
    .sort((left, right) => left.pattern.localeCompare(right.pattern));
}

function normalizeSite(value) {
  if (typeof value !== "string") {
    return "";
  }

  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");

  if (!cleaned) {
    return "";
  }

  const hostnamePattern = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/;
  return hostnamePattern.test(cleaned) ? cleaned : "";
}

function normalizeLanguage(value, fallback) {
  const validCodes = TRANSLATOR_LANGUAGES.map((language) => language.code);
  return validCodes.includes(value) ? value : fallback;
}

function getLanguageLabel(code) {
  return TRANSLATOR_LANGUAGES.find((language) => language.code === code)?.label ?? code;
}

function getPageTargetSummary() {
  return state.pageTranslationRules
    .map((rule) => `${getLanguageLabel(rule.sourceLanguage)} -> ${getLanguageLabel(rule.targetLanguage)}`)
    .join(" | ");
}

function getPrimaryTargetLanguage(rules) {
  return rules[0]?.targetLanguage ?? TRANSLATOR_DEFAULT_SETTINGS.selectionTargetLanguage;
}

function getNextPageTranslationRule(rules) {
  const lastRule = rules[rules.length - 1] ?? TRANSLATOR_DEFAULT_SETTINGS.pageTranslationRules[0];
  const sourceLanguage = lastRule.sourceLanguage;
  const usedTargets = new Set(rules.map((rule) => rule.targetLanguage));
  const nextTarget = TRANSLATOR_LANGUAGES.find((language) => {
    return language.code !== sourceLanguage && !usedTargets.has(language.code);
  })?.code ?? getFallbackTarget(sourceLanguage);

  return { sourceLanguage, targetLanguage: nextTarget };
}

function getFallbackTarget(sourceLanguage) {
  return sourceLanguage === "en" ? "ko" : "en";
}

function getFallbackSource(targetLanguage) {
  return targetLanguage === "ko" ? "en" : "ko";
}

function getPageTranslationModeLabel(mode) {
  return mode === "entire-page" ? "Entire web page" : "Specific languages";
}

function getSerializableSettings() {
  return {
    sites: state.sites.map((site) => ({
      pattern: site.pattern,
      followGlobalPageTranslation: site.followGlobalPageTranslation,
      pageTranslationMode: site.pageTranslationMode,
      pageTranslationRules: site.pageTranslationRules.map((rule) => ({ ...rule }))
    })),
    autoTranslate: state.autoTranslate,
    pageTranslationMode: state.pageTranslationMode,
    pageTranslationRules: state.pageTranslationRules.map((rule) => ({ ...rule })),
    showOriginalOnTranslatedSelection: state.showOriginalOnTranslatedSelection,
    selectionTargetLanguage: state.selectionTargetLanguage
  };
}

function normalizeImportedSettings(settings) {
  const pageTranslationRules = normalizePageTranslationRules(settings?.pageTranslationRules);
  return {
    sites: normalizeSites(settings?.sites),
    autoTranslate: settings?.autoTranslate !== false,
    pageTranslationMode: normalizePageTranslationMode(settings?.pageTranslationMode),
    pageTranslationRules,
    showOriginalOnTranslatedSelection: settings?.showOriginalOnTranslatedSelection !== false,
    selectionTargetLanguage: normalizeLanguage(
      settings?.selectionTargetLanguage,
      getPrimaryTargetLanguage(pageTranslationRules)
    )
  };
}

function renderRuleEditor(container, rules, onChange) {
  container.innerHTML = "";

  rules.forEach((rule, index) => {
    const row = document.createElement("div");
    row.className = "page-rule";

    const sourceField = document.createElement("label");
    sourceField.className = "field";
    const sourceLabel = document.createElement("span");
    sourceLabel.textContent = "From";
    const sourceSelect = buildLanguageSelect(rule.sourceLanguage);
    sourceSelect.addEventListener("change", async () => {
      const nextRules = rules.map((entry, entryIndex) => {
        if (entryIndex !== index) {
          return { ...entry };
        }

        const nextRule = {
          ...entry,
          sourceLanguage: normalizeLanguage(sourceSelect.value, entry.sourceLanguage)
        };
        if (nextRule.sourceLanguage === nextRule.targetLanguage) {
          nextRule.targetLanguage = getFallbackTarget(nextRule.sourceLanguage);
        }
        return nextRule;
      });
      await onChange(nextRules);
    });
    sourceField.append(sourceLabel, sourceSelect);

    const targetField = document.createElement("label");
    targetField.className = "field";
    const targetLabel = document.createElement("span");
    targetLabel.textContent = "To";
    const targetSelect = buildLanguageSelect(rule.targetLanguage);
    targetSelect.addEventListener("change", async () => {
      const nextRules = rules.map((entry, entryIndex) => {
        if (entryIndex !== index) {
          return { ...entry };
        }

        const nextRule = {
          ...entry,
          targetLanguage: normalizeLanguage(targetSelect.value, entry.targetLanguage)
        };
        if (nextRule.targetLanguage === nextRule.sourceLanguage) {
          nextRule.sourceLanguage = getFallbackSource(nextRule.targetLanguage);
        }
        return nextRule;
      });
      await onChange(nextRules);
    });
    targetField.append(targetLabel, targetSelect);

    const actionSlot = document.createElement("div");
    if (index > 0) {
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "secondary";
      removeButton.textContent = "Remove";
      removeButton.addEventListener("click", async () => {
        await onChange(rules.filter((_, ruleIndex) => ruleIndex !== index));
      });
      actionSlot.appendChild(removeButton);
    }

    row.append(sourceField, targetField, actionSlot);
    container.appendChild(row);
  });
}

function normalizeSiteEntry(site) {
  if (typeof site === "string") {
    const pattern = normalizeSite(site);
    return pattern ? createSiteSettings(pattern) : null;
  }

  if (!site || typeof site !== "object") {
    return null;
  }

  const pattern = normalizeSite(site.pattern);
  if (!pattern) {
    return null;
  }

  return {
    pattern,
    followGlobalPageTranslation: site.followGlobalPageTranslation !== false,
    pageTranslationMode: normalizePageTranslationMode(site.pageTranslationMode),
    pageTranslationRules: normalizePageTranslationRules(site.pageTranslationRules)
  };
}

function createSiteSettings(pattern) {
  return {
    pattern,
    followGlobalPageTranslation: true,
    pageTranslationMode: state.pageTranslationMode,
    pageTranslationRules: normalizePageTranslationRules(state.pageTranslationRules)
  };
}

function cloneDefaultPageTranslationRules() {
  return TRANSLATOR_DEFAULT_SETTINGS.pageTranslationRules.map((rule) => ({ ...rule }));
}

function appendSiteCustomSettings(site, customSettings, modeField, rulesField) {
  customSettings.innerHTML = "";

  if (site.followGlobalPageTranslation) {
    return;
  }

  customSettings.appendChild(modeField);

  if (site.pageTranslationMode === "specific-languages") {
    customSettings.appendChild(rulesField);
  }
}

function getSiteModeSummary(site) {
  const effectiveSite = site.followGlobalPageTranslation
    ? {
        ...site,
        pageTranslationMode: state.pageTranslationMode,
        pageTranslationRules: state.pageTranslationRules
      }
    : site;

  if (site.followGlobalPageTranslation) {
    return `Global: ${getModeSummaryText(effectiveSite.pageTranslationMode, effectiveSite.pageTranslationRules)}`;
  }

  return `Custom: ${getModeSummaryText(effectiveSite.pageTranslationMode, effectiveSite.pageTranslationRules)}`;
}

function getModeSummaryText(mode, rules) {
  if (mode === "entire-page") {
    const targets = rules
      .map((rule) => getLanguageLabel(rule.targetLanguage))
      .filter((value, index, array) => array.indexOf(value) === index)
      .join(" / ");
    return `entire page -> ${targets}`;
  }

  return rules
    .map((rule) => `${getLanguageLabel(rule.sourceLanguage)} -> ${getLanguageLabel(rule.targetLanguage)}`)
    .join(" | ");
}

function setStatus(message) {
  elements.status.textContent = message;

  if (statusTimeoutId !== null) {
    window.clearTimeout(statusTimeoutId);
    statusTimeoutId = null;
  }

  if (!message) {
    return;
  }

  statusTimeoutId = window.setTimeout(() => {
    elements.status.textContent = "";
    statusTimeoutId = null;
  }, STATUS_MESSAGE_DURATION);
}
