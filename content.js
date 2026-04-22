const browserApi = typeof browser !== "undefined" ? browser : chrome;

const MAX_BATCH_SIZE = 15;
const MAX_TEXT_LENGTH = 450;

let cachedSettings = null;
let isTranslating = false;
let observer = null;
let translatedNodes = new WeakSet();
let originalNodeTexts = new WeakMap();
let overlay = null;

initialize().catch((error) => {
  console.error("Translator failed to initialize", error);
});

async function initialize() {
  cachedSettings = await loadSettings();
  listenForSettingChanges();
  bindSelectionTranslator();
  bindOverlayDismiss();

  if (shouldAutoTranslate()) {
    await translateVisibleDocument();
    startObserving();
  }
}

async function loadSettings() {
  const stored = await browserApi.storage.sync.get(null);
  const sites = normalizeSites(stored.sites);
  return {
    sites,
    autoTranslate: stored.autoTranslate !== false,
    pageTranslationMode: normalizePageTranslationMode(stored.pageTranslationMode),
    pageTranslationRules: getStoredPageTranslationRules(stored),
    showOriginalOnTranslatedSelection: stored.showOriginalOnTranslatedSelection !== false,
    selectionTargetLanguage: normalizeLanguage(
      stored.selectionTargetLanguage,
      TRANSLATOR_DEFAULT_SETTINGS.selectionTargetLanguage
    )
  };
}

function listenForSettingChanges() {
  browserApi.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") {
      return;
    }

    if (changes.sites) {
      cachedSettings.sites = normalizeSites(changes.sites.newValue);
    }

    if (changes.autoTranslate) {
      cachedSettings.autoTranslate = changes.autoTranslate.newValue !== false;
    }

    if (changes.pageTranslationMode) {
      cachedSettings.pageTranslationMode = normalizePageTranslationMode(changes.pageTranslationMode.newValue);
    }

    if (changes.pageTranslationRules) {
      cachedSettings.pageTranslationRules = normalizePageTranslationRules(changes.pageTranslationRules.newValue);
    }

    if (changes.selectionTargetLanguage) {
      cachedSettings.selectionTargetLanguage = normalizeLanguage(
        changes.selectionTargetLanguage.newValue,
        TRANSLATOR_DEFAULT_SETTINGS.selectionTargetLanguage
      );
    }

    if (changes.showOriginalOnTranslatedSelection) {
      cachedSettings.showOriginalOnTranslatedSelection = changes.showOriginalOnTranslatedSelection.newValue !== false;
    }

    const enabledForSite = shouldAutoTranslate();
    if (!enabledForSite && observer) {
      observer.disconnect();
      observer = null;
      return;
    }

    if (enabledForSite && !observer) {
      translatedNodes = new WeakSet();
      translateVisibleDocument().catch((error) => {
        console.error("Translation after settings change failed", error);
      });
      startObserving();
    }
  });
}

function shouldAutoTranslate() {
  return cachedSettings.autoTranslate && Boolean(getCurrentSiteSettings());
}

function getCurrentSiteSettings() {
  const matchedSite = cachedSettings.sites.find((site) => matchSitePattern(window.location.hostname, site.pattern));
  if (!matchedSite) {
    return null;
  }

  if (matchedSite.followGlobalPageTranslation) {
    return {
      pageTranslationMode: cachedSettings.pageTranslationMode,
      pageTranslationRules: cachedSettings.pageTranslationRules
    };
  }

  return {
    pageTranslationMode: matchedSite.pageTranslationMode,
    pageTranslationRules: matchedSite.pageTranslationRules
  };
}

function matchSitePattern(hostname, pattern) {
  if (!pattern || typeof pattern !== "string") {
    return false;
  }

  const normalized = pattern
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");

  if (!normalized) {
    return false;
  }

  if (normalized.startsWith("*.")) {
    const root = normalized.slice(2);
    return hostname === root || hostname.endsWith(`.${root}`);
  }

  return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

async function translateVisibleDocument() {
  if (isTranslating) {
    return;
  }

  isTranslating = true;

  try {
    const textNodes = collectTranslatableNodes(document.body);
    if (!textNodes.length) {
      return;
    }

    const batches = chunkNodes(textNodes, MAX_BATCH_SIZE);
    for (const batch of batches) {
      const items = batch
        .map(({ node, request }) => ({
          text: node.textContent.trim(),
          sourceLanguage: request.sourceLanguage,
          targetLanguages: request.targetLanguages
        }))
        .filter((item) => item.text);

      if (!items.length) {
        continue;
      }

      const { translations } = await browserApi.runtime.sendMessage({
        type: "translate-text-batch",
        payload: { items }
      });

      batch.forEach(({ node }, index) => {
        const translated = translations?.[index];
        if (translated && translated !== node.textContent.trim()) {
          originalNodeTexts.set(node, node.textContent);
          node.textContent = preserveSpacing(node.textContent, translated);
        }
      });
    }
  } catch (error) {
    console.error("Translation failed", error);
  } finally {
    isTranslating = false;
  }
}

function collectTranslatableNodes(root) {
  if (!root) {
    return [];
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.parentElement) {
        return NodeFilter.FILTER_REJECT;
      }

      const parentTag = node.parentElement.tagName;
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "CODE", "PRE"].includes(parentTag)) {
        return NodeFilter.FILTER_REJECT;
      }

      const value = node.textContent;
      if (!value || !value.trim()) {
        return NodeFilter.FILTER_REJECT;
      }

      if (value.trim().length > MAX_TEXT_LENGTH) {
        return NodeFilter.FILTER_REJECT;
      }

      if (translatedNodes.has(node)) {
        return NodeFilter.FILTER_REJECT;
      }

      if (!getTranslationRequestForText(value)) {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const nodes = [];
  let currentNode = walker.nextNode();

  while (currentNode) {
    translatedNodes.add(currentNode);
    const request = getTranslationRequestForText(currentNode.textContent);
    if (request) {
      nodes.push({ node: currentNode, request });
    }
    currentNode = walker.nextNode();
  }

  return nodes;
}

function chunkNodes(nodes, size) {
  const chunks = [];
  for (let index = 0; index < nodes.length; index += size) {
    chunks.push(nodes.slice(index, index + size));
  }
  return chunks;
}

function preserveSpacing(original, translated) {
  const leading = original.match(/^\s*/)?.[0] ?? "";
  const trailing = original.match(/\s*$/)?.[0] ?? "";
  return `${leading}${translated}${trailing}`;
}

function startObserving() {
  observer = new MutationObserver((mutations) => {
    const hasRelevantChange = mutations.some((mutation) => {
      return mutation.addedNodes && mutation.addedNodes.length > 0;
    });

    if (hasRelevantChange) {
      scheduleIdleWork(() => {
        translateVisibleDocument().catch((error) => {
          console.error("Deferred translation failed", error);
        });
      });
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

function bindSelectionTranslator() {
  document.addEventListener("mouseup", handleSelectionGesture, true);
}

function bindOverlayDismiss() {
  document.addEventListener("mousedown", handleOverlayDismiss, true);
}

async function handleSelectionGesture(event) {
  if (!event.ctrlKey) {
    return;
  }

  const originalSelection = getOriginalSelectionText();
  if (originalSelection) {
    showSelectionOverlay(event.clientX, event.clientY, originalSelection, "original");
    return;
  }

  const selectedText = window.getSelection()?.toString().trim() ?? "";
  if (!selectedText) {
    return;
  }

  try {
    const result = await browserApi.runtime.sendMessage({
      type: "translate-selection",
      payload: {
        text: selectedText,
        targetLanguage: cachedSettings.selectionTargetLanguage
      }
    });

    if (!result?.translation) {
      return;
    }

    showSelectionOverlay(event.clientX, event.clientY, result.translation, result.detectedLanguage);
  } catch (error) {
    console.error("Selection translation failed", error);
  }
}

function showSelectionOverlay(x, y, translation, detectedLanguage) {
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.setAttribute("data-translator-overlay", "true");
    Object.assign(overlay.style, {
      position: "fixed",
      zIndex: "2147483647",
      maxWidth: "320px",
      padding: "10px 12px",
      borderRadius: "10px",
      background: "rgba(17, 17, 17, 0.94)",
      color: "#ffffff",
      fontSize: "13px",
      lineHeight: "1.45",
      boxShadow: "0 10px 30px rgba(0, 0, 0, 0.22)",
      pointerEvents: "auto",
      whiteSpace: "pre-wrap"
    });
    document.documentElement.appendChild(overlay);
  }

  const overlayTitle = getOverlayTitle(detectedLanguage);
  overlay.textContent = overlayTitle ? `${overlayTitle}\n${translation}` : translation;
  overlay.style.left = `${Math.min(x + 12, window.innerWidth - 340)}px`;
  overlay.style.top = `${Math.min(y + 12, window.innerHeight - 120)}px`;
  overlay.style.opacity = "1";
  overlay.style.display = "block";
}

function handleOverlayDismiss(event) {
  if (!overlay || overlay.style.display === "none") {
    return;
  }

  if (overlay.contains(event.target)) {
    return;
  }

  overlay.style.display = "none";
}

function scheduleIdleWork(callback) {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(callback);
    return;
  }

  window.setTimeout(callback, 120);
}

function matchesSourceLanguage(text, languageCode) {
  const value = text.trim();
  if (!value) {
    return false;
  }

  const detectors = {
    ko: /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/,
    en: /[A-Za-z]/,
    ja: /[\u3040-\u30FF\u31F0-\u31FF]/,
    "zh-CN": /[\u4E00-\u9FFF]/,
    es: /[A-Za-z\u00C0-\u00FF]|[¿¡]/
  };

  const regex = detectors[languageCode];
  return regex ? regex.test(value) : true;
}

function getTranslationRequestForText(text) {
  const currentSiteSettings = getCurrentSiteSettings();
  if (!currentSiteSettings) {
    return null;
  }

  if (currentSiteSettings.pageTranslationMode === "entire-page") {
    const targetLanguages = getUniqueTargetLanguages(currentSiteSettings.pageTranslationRules);
    return targetLanguages.length
      ? { sourceLanguage: "auto", targetLanguages }
      : null;
  }

  const matchingRules = currentSiteSettings.pageTranslationRules.filter((rule) => {
    return matchesSourceLanguage(text, rule.sourceLanguage);
  });

  if (!matchingRules.length) {
    return null;
  }

  return {
    sourceLanguage: matchingRules[0].sourceLanguage,
    targetLanguages: getUniqueTargetLanguages(matchingRules, matchingRules[0].sourceLanguage)
  };
}

function getUniqueTargetLanguages(rules, sourceLanguage = "auto") {
  return rules
    .map((rule) => rule.targetLanguage)
    .filter((targetLanguage) => sourceLanguage === "auto" || targetLanguage !== sourceLanguage)
    .filter((targetLanguage, index, array) => array.indexOf(targetLanguage) === index)
    .slice(0, 3);
}

function getOriginalSelectionText() {
  if (!cachedSettings.showOriginalOnTranslatedSelection) {
    return "";
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return "";
  }

  const range = selection.getRangeAt(0);
  const textNodes = getTextNodesInRange(range);
  if (!textNodes.length) {
    return "";
  }

  const originalSegments = textNodes
    .map((node) => originalNodeTexts.get(node))
    .filter((value) => typeof value === "string" && value.trim());

  if (!originalSegments.length) {
    return "";
  }

  return originalSegments.join(" ").replace(/\s+/g, " ").trim();
}

function getTextNodesInRange(range) {
  const nodes = [];
  const root = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
    ? range.commonAncestorContainer.parentNode
    : range.commonAncestorContainer;

  if (!root) {
    return nodes;
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });

  let currentNode = walker.nextNode();
  while (currentNode) {
    nodes.push(currentNode);
    currentNode = walker.nextNode();
  }

  return nodes;
}

function getOverlayTitle(detectedLanguage) {
  if (detectedLanguage === "original") {
    return "Original text";
  }

  const detectedLabel = getLanguageLabel(detectedLanguage);
  return detectedLabel ? `${detectedLabel} -> ${getLanguageLabel(cachedSettings.selectionTargetLanguage)}` : "";
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
    .map((site) => normalizeSiteEntry(site))
    .filter(Boolean)
    .filter((site, index, array) => array.findIndex((entry) => entry.pattern === site.pattern) === index);
}

function normalizeSiteEntry(site) {
  if (typeof site === "string") {
    const pattern = normalizeSitePattern(site);
    return pattern
      ? {
          pattern,
          followGlobalPageTranslation: true,
          pageTranslationMode: TRANSLATOR_DEFAULT_SETTINGS.pageTranslationMode,
          pageTranslationRules: cloneDefaultPageTranslationRules()
        }
      : null;
  }

  if (!site || typeof site !== "object") {
    return null;
  }

  const pattern = normalizeSitePattern(site.pattern);
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

function normalizeSitePattern(value) {
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

function getLanguageLabel(code) {
  const match = TRANSLATOR_LANGUAGES.find((language) => language.code === code);
  return match ? match.label : "";
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
    .slice(0, 3);

  return normalized.length ? normalized : cloneDefaultPageTranslationRules();
}

function normalizePageTranslationMode(value) {
  return value === "entire-page" ? "entire-page" : TRANSLATOR_DEFAULT_SETTINGS.pageTranslationMode;
}

function getFallbackTarget(sourceLanguage) {
  return sourceLanguage === "en" ? "ko" : "en";
}

function cloneDefaultPageTranslationRules() {
  return TRANSLATOR_DEFAULT_SETTINGS.pageTranslationRules.map((rule) => ({ ...rule }));
}
