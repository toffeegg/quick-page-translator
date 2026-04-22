const browserApi = typeof browser !== "undefined" ? browser : chrome;

const summary = document.getElementById("summary");
const hostnameLabel = document.getElementById("hostname");
const toggleSite = document.getElementById("toggleSite");
const toggleAutoTranslate = document.getElementById("toggleAutoTranslate");
const refreshPage = document.getElementById("refreshPage");
const openSettings = document.getElementById("openSettings");

const popupState = {
  tabId: null,
  hostname: "",
  normalizedHostname: "",
  sites: [],
  autoTranslate: true
};

initialize().catch((error) => {
  console.error("Failed to load popup", error);
  summary.textContent = "Unable to read the current tab.";
  hostnameLabel.hidden = true;
  toggleSite.hidden = true;
  refreshPage.hidden = true;
});

async function initialize() {
  const [tab] = await browserApi.tabs.query({ active: true, currentWindow: true });
  const hostname = getTabHostname(tab?.url);
  const settings = await browserApi.storage.sync.get(TRANSLATOR_DEFAULT_SETTINGS);
  const sites = normalizeSites(settings.sites);
  const enabled = sites.some((site) => matchesHost(hostname, site));
  const sourceLanguage = normalizeLanguage(settings.sourceLanguage, TRANSLATOR_DEFAULT_SETTINGS.sourceLanguage);
  const targetLanguage = normalizeLanguage(settings.targetLanguage, TRANSLATOR_DEFAULT_SETTINGS.targetLanguage);
  const selectionTargetLanguage = normalizeLanguage(
    settings.selectionTargetLanguage,
    TRANSLATOR_DEFAULT_SETTINGS.selectionTargetLanguage
  );

  popupState.tabId = typeof tab?.id === "number" ? tab.id : null;
  popupState.hostname = hostname;
  popupState.normalizedHostname = normalizeSite(hostname);
  popupState.sites = sites;
  popupState.autoTranslate = settings.autoTranslate !== false;

  if (!hostname) {
    summary.textContent = "Open a normal web page to use the translator.";
    hostnameLabel.hidden = true;
    toggleSite.hidden = true;
    syncAutoTranslateControls();
    return;
  }

  hostnameLabel.textContent = hostname;
  hostnameLabel.hidden = false;
  syncToggleButton();
  syncAutoTranslateControls();

  if (!settings.autoTranslate) {
    summary.textContent = `Auto-translation is paused. Ctrl + highlight still translates to ${getLanguageLabel(selectionTargetLanguage)}.`;
    return;
  }

  summary.textContent = enabled
    ? `${hostname} is set to translate ${getLanguageLabel(sourceLanguage)} -> ${getLanguageLabel(targetLanguage)}.`
    : `${hostname} is not in your saved sites yet.`;
}

openSettings.addEventListener("click", () => {
  browserApi.runtime.openOptionsPage();
  window.close();
});

toggleSite.addEventListener("click", async () => {
  if (!popupState.normalizedHostname) {
    return;
  }

  const isSaved = popupState.sites.includes(popupState.normalizedHostname);
  popupState.sites = isSaved
    ? popupState.sites.filter((site) => site !== popupState.normalizedHostname)
    : [...popupState.sites, popupState.normalizedHostname].sort();

  await browserApi.storage.sync.set({ sites: popupState.sites });
  syncToggleButton();

  summary.textContent = isSaved
    ? `${popupState.hostname} was removed from your saved sites.`
    : `${popupState.hostname} was added to your saved sites.`;
});

toggleAutoTranslate.addEventListener("click", async () => {
  popupState.autoTranslate = !popupState.autoTranslate;
  await browserApi.storage.sync.set({ autoTranslate: popupState.autoTranslate });
  syncAutoTranslateControls();

  if (!popupState.autoTranslate) {
    summary.textContent = "Auto-translation paused. Refresh the page when you want the change to apply there.";
    return;
  }

  if (!popupState.hostname) {
    summary.textContent = "Auto-translation resumed.";
    return;
  }

  const isSaved = popupState.sites.some((site) => matchesHost(popupState.hostname, site));
  summary.textContent = isSaved
    ? `${popupState.hostname} will auto-translate again after refresh or on your next visit.`
    : `${popupState.hostname} is not in your saved sites yet.`;
});

refreshPage.addEventListener("click", async () => {
  if (popupState.tabId === null) {
    return;
  }

  await browserApi.tabs.reload(popupState.tabId);
  window.close();
});

function syncToggleButton() {
  if (!popupState.normalizedHostname) {
    toggleSite.hidden = true;
    return;
  }

  const isSaved = popupState.sites.includes(popupState.normalizedHostname);
  toggleSite.hidden = false;
  toggleSite.textContent = isSaved ? "Remove website" : "Add website";
  toggleSite.classList.toggle("danger", isSaved);
}

function syncAutoTranslateControls() {
  toggleAutoTranslate.textContent = popupState.autoTranslate ? "Pause auto-translate" : "Resume auto-translate";
  toggleAutoTranslate.classList.toggle("danger", !popupState.autoTranslate);
  refreshPage.hidden = popupState.autoTranslate || popupState.tabId === null || !popupState.hostname;
}

function matchesHost(hostname, pattern) {
  if (!hostname || !pattern) {
    return false;
  }

  if (pattern.startsWith("*.")) {
    const root = pattern.slice(2);
    return hostname === root || hostname.endsWith(`.${root}`);
  }

  return hostname === pattern || hostname.endsWith(`.${pattern}`);
}

function normalizeLanguage(value, fallback) {
  const validCodes = TRANSLATOR_LANGUAGES.map((language) => language.code);
  return validCodes.includes(value) ? value : fallback;
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

function getTabHostname(url) {
  if (typeof url !== "string" || !/^https?:/i.test(url)) {
    return "";
  }

  try {
    return new URL(url).hostname;
  } catch (error) {
    console.warn("Could not parse active tab URL", error);
    return "";
  }
}

function getLanguageLabel(code) {
  return TRANSLATOR_LANGUAGES.find((language) => language.code === code)?.label ?? code;
}
