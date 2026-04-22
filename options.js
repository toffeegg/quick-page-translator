const browserApi = typeof browser !== "undefined" ? browser : chrome;

const elements = {
  autoTranslate: document.getElementById("autoTranslate"),
  sourceLanguage: document.getElementById("sourceLanguage"),
  targetLanguage: document.getElementById("targetLanguage"),
  selectionTargetLanguage: document.getElementById("selectionTargetLanguage"),
  siteForm: document.getElementById("siteForm"),
  siteInput: document.getElementById("siteInput"),
  siteList: document.getElementById("siteList"),
  clearAll: document.getElementById("clearAll"),
  status: document.getElementById("status")
};

let state = {
  sites: [],
  autoTranslate: true,
  sourceLanguage: TRANSLATOR_DEFAULT_SETTINGS.sourceLanguage,
  targetLanguage: TRANSLATOR_DEFAULT_SETTINGS.targetLanguage,
  selectionTargetLanguage: TRANSLATOR_DEFAULT_SETTINGS.selectionTargetLanguage
};

initialize().catch((error) => {
  console.error("Failed to load options", error);
  setStatus("Could not load settings.");
});

async function initialize() {
  populateLanguageSelects();

  const stored = await browserApi.storage.sync.get(TRANSLATOR_DEFAULT_SETTINGS);
  state = {
    sites: normalizeSites(stored.sites),
    autoTranslate: stored.autoTranslate !== false,
    sourceLanguage: normalizeLanguage(stored.sourceLanguage, TRANSLATOR_DEFAULT_SETTINGS.sourceLanguage),
    targetLanguage: normalizeLanguage(stored.targetLanguage, TRANSLATOR_DEFAULT_SETTINGS.targetLanguage),
    selectionTargetLanguage: normalizeLanguage(
      stored.selectionTargetLanguage,
      normalizeLanguage(stored.targetLanguage, TRANSLATOR_DEFAULT_SETTINGS.selectionTargetLanguage)
    )
  };

  elements.autoTranslate.checked = state.autoTranslate;
  elements.sourceLanguage.value = state.sourceLanguage;
  elements.targetLanguage.value = state.targetLanguage;
  elements.selectionTargetLanguage.value = state.selectionTargetLanguage;
  renderSites();
  bindEvents();
}

function bindEvents() {
  elements.autoTranslate.addEventListener("change", async () => {
    state.autoTranslate = elements.autoTranslate.checked;
    await saveState();
    setStatus(state.autoTranslate ? "Automatic translation enabled." : "Automatic translation disabled.");
  });

  elements.sourceLanguage.addEventListener("change", async () => {
    state.sourceLanguage = normalizeLanguage(elements.sourceLanguage.value, TRANSLATOR_DEFAULT_SETTINGS.sourceLanguage);
    if (state.sourceLanguage === state.targetLanguage) {
      state.targetLanguage = getFallbackTarget(state.sourceLanguage);
      elements.targetLanguage.value = state.targetLanguage;
    }
    await saveState();
    setStatus(`Page translation set to ${getLanguageLabel(state.sourceLanguage)} -> ${getLanguageLabel(state.targetLanguage)}.`);
  });

  elements.targetLanguage.addEventListener("change", async () => {
    state.targetLanguage = normalizeLanguage(elements.targetLanguage.value, TRANSLATOR_DEFAULT_SETTINGS.targetLanguage);
    if (state.targetLanguage === state.sourceLanguage) {
      state.sourceLanguage = getFallbackSource(state.targetLanguage);
      elements.sourceLanguage.value = state.sourceLanguage;
    }
    await saveState();
    setStatus(`Page translation set to ${getLanguageLabel(state.sourceLanguage)} -> ${getLanguageLabel(state.targetLanguage)}.`);
  });

  elements.selectionTargetLanguage.addEventListener("change", async () => {
    state.selectionTargetLanguage = normalizeLanguage(
      elements.selectionTargetLanguage.value,
      TRANSLATOR_DEFAULT_SETTINGS.selectionTargetLanguage
    );
    await saveState();
    setStatus(`Highlight translation target set to ${getLanguageLabel(state.selectionTargetLanguage)}.`);
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
  await browserApi.storage.sync.set({
    sites: state.sites,
    autoTranslate: state.autoTranslate,
    sourceLanguage: state.sourceLanguage,
    targetLanguage: state.targetLanguage,
    selectionTargetLanguage: state.selectionTargetLanguage
  });
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

function populateLanguageSelects() {
  [elements.sourceLanguage, elements.targetLanguage, elements.selectionTargetLanguage].forEach((select) => {
    select.innerHTML = "";
    TRANSLATOR_LANGUAGES.forEach((language) => {
      const option = document.createElement("option");
      option.value = language.code;
      option.textContent = language.label;
      select.appendChild(option);
    });
  });
}

function normalizeLanguage(value, fallback) {
  const validCodes = TRANSLATOR_LANGUAGES.map((language) => language.code);
  return validCodes.includes(value) ? value : fallback;
}

function getLanguageLabel(code) {
  return TRANSLATOR_LANGUAGES.find((language) => language.code === code)?.label ?? code;
}

function getFallbackTarget(sourceLanguage) {
  return sourceLanguage === "en" ? "ko" : "en";
}

function getFallbackSource(targetLanguage) {
  return targetLanguage === "ko" ? "en" : "ko";
}

function setStatus(message) {
  elements.status.textContent = message;
}
