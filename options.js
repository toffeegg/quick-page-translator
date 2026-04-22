const browserApi = typeof browser !== "undefined" ? browser : chrome;

const MAX_PAGE_TRANSLATION_RULES = 3;

const elements = {
  autoTranslate: document.getElementById("autoTranslate"),
  pageTranslationMode: document.getElementById("pageTranslationMode"),
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

initialize().catch((error) => {
  console.error("Failed to load options", error);
  setStatus("Could not load settings.");
});

async function initialize() {
  populateLanguageSelects();

  const stored = await browserApi.storage.sync.get(null);
  const pageTranslationRules = getStoredPageTranslationRules(stored);
  state = {
    sites: normalizeSites(stored.sites),
    autoTranslate: stored.autoTranslate !== false,
    pageTranslationMode: normalizePageTranslationMode(stored.pageTranslationMode),
    pageTranslationRules,
    showOriginalOnTranslatedSelection: stored.showOriginalOnTranslatedSelection !== false,
    selectionTargetLanguage: normalizeLanguage(
      stored.selectionTargetLanguage,
      getPrimaryTargetLanguage(pageTranslationRules)
    )
  };

  elements.autoTranslate.checked = state.autoTranslate;
  elements.pageTranslationMode.value = state.pageTranslationMode;
  elements.showOriginalOnTranslatedSelection.checked = state.showOriginalOnTranslatedSelection;
  elements.selectionTargetLanguage.value = state.selectionTargetLanguage;
  renderPageTranslationRules();
  renderSites();
  bindEvents();
}

function bindEvents() {
  elements.autoTranslate.addEventListener("change", async () => {
    state.autoTranslate = elements.autoTranslate.checked;
    await saveState();
    setStatus(state.autoTranslate ? "Automatic translation enabled." : "Automatic translation disabled.");
  });

  elements.pageTranslationMode.addEventListener("change", async () => {
    state.pageTranslationMode = normalizePageTranslationMode(elements.pageTranslationMode.value);
    await saveState();
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

    if (state.sites.includes(normalized)) {
      setStatus("That website is already in the list.");
      return;
    }

    state.sites.push(normalized);
    state.sites.sort();
    await saveState();
    renderSites();
    elements.siteInput.value = "";
    setStatus(`Added ${normalized}.`);
  });

  elements.clearAll.addEventListener("click", async () => {
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
  elements.pageTranslationRules.innerHTML = "";

  state.pageTranslationRules.forEach((rule, index) => {
    const row = document.createElement("div");
    row.className = "page-rule";

    const sourceField = document.createElement("label");
    sourceField.className = "field";
    const sourceLabel = document.createElement("span");
    sourceLabel.textContent = "From";
    const sourceSelect = buildLanguageSelect(rule.sourceLanguage);
    sourceSelect.addEventListener("change", async () => {
      state.pageTranslationRules[index].sourceLanguage = normalizeLanguage(
        sourceSelect.value,
        state.pageTranslationRules[index].sourceLanguage
      );
      if (state.pageTranslationRules[index].sourceLanguage === state.pageTranslationRules[index].targetLanguage) {
        state.pageTranslationRules[index].targetLanguage = getFallbackTarget(state.pageTranslationRules[index].sourceLanguage);
      }
      state.pageTranslationRules = normalizePageTranslationRules(state.pageTranslationRules);
      renderPageTranslationRules();
      await saveState();
      setStatus(`Page translation set to ${getPageTargetSummary()}.`);
    });
    sourceField.append(sourceLabel, sourceSelect);

    const targetField = document.createElement("label");
    targetField.className = "field";
    const targetLabel = document.createElement("span");
    targetLabel.textContent = "To";
    const targetSelect = buildLanguageSelect(rule.targetLanguage);
    targetSelect.addEventListener("change", async () => {
      state.pageTranslationRules[index].targetLanguage = normalizeLanguage(
        targetSelect.value,
        state.pageTranslationRules[index].targetLanguage
      );
      if (state.pageTranslationRules[index].targetLanguage === state.pageTranslationRules[index].sourceLanguage) {
        state.pageTranslationRules[index].sourceLanguage = getFallbackSource(state.pageTranslationRules[index].targetLanguage);
      }
      state.pageTranslationRules = normalizePageTranslationRules(state.pageTranslationRules);
      renderPageTranslationRules();
      await saveState();
      setStatus(`Page translation set to ${getPageTargetSummary()}.`);
    });
    targetField.append(targetLabel, targetSelect);

    const actionSlot = document.createElement("div");
    if (index > 0) {
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "secondary";
      removeButton.textContent = "Remove";
      removeButton.addEventListener("click", async () => {
        state.pageTranslationRules = state.pageTranslationRules.filter((_, ruleIndex) => ruleIndex !== index);
        renderPageTranslationRules();
        await saveState();
        setStatus(`Removed page target. ${getPageTargetSummary()}.`);
      });
      actionSlot.appendChild(removeButton);
    }

    row.append(sourceField, targetField, actionSlot);
    elements.pageTranslationRules.appendChild(row);
  });

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
    item.className = "site-item";

    const label = document.createElement("span");
    label.className = "site-pill";
    label.textContent = site;

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "secondary";
    removeButton.textContent = "Delete";
    removeButton.addEventListener("click", async () => {
      state.sites = state.sites.filter((entry) => entry !== site);
      await saveState();
      renderSites();
      setStatus(`Removed ${site}.`);
    });

    item.append(label, removeButton);
    elements.siteList.appendChild(item);
  });
}

async function saveState() {
  state.pageTranslationRules = normalizePageTranslationRules(state.pageTranslationRules);

  await browserApi.storage.sync.set({
    sites: state.sites,
    autoTranslate: state.autoTranslate,
    pageTranslationMode: state.pageTranslationMode,
    pageTranslationRules: state.pageTranslationRules,
    showOriginalOnTranslatedSelection: state.showOriginalOnTranslatedSelection,
    selectionTargetLanguage: state.selectionTargetLanguage
  });
}

function syncFormFromState() {
  elements.autoTranslate.checked = state.autoTranslate;
  elements.pageTranslationMode.value = state.pageTranslationMode;
  elements.showOriginalOnTranslatedSelection.checked = state.showOriginalOnTranslatedSelection;
  elements.selectionTargetLanguage.value = state.selectionTargetLanguage;
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
    return [...TRANSLATOR_DEFAULT_SETTINGS.pageTranslationRules];
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

  return normalized.length ? normalized : [...TRANSLATOR_DEFAULT_SETTINGS.pageTranslationRules];
}

function normalizePageTranslationMode(value) {
  return value === "entire-page" ? "entire-page" : TRANSLATOR_DEFAULT_SETTINGS.pageTranslationMode;
}

function normalizeSites(sites) {
  if (!Array.isArray(sites)) {
    return [];
  }

  return sites
    .map((site) => normalizeSite(site))
    .filter(Boolean)
    .filter((site, index, array) => array.indexOf(site) === index)
    .sort();
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
    sites: [...state.sites],
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

function setStatus(message) {
  elements.status.textContent = message;
}
