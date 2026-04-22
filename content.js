const browserApi = typeof browser !== "undefined" ? browser : chrome;

const MAX_BATCH_SIZE = 15;
const MAX_TEXT_LENGTH = 450;

let cachedSettings = null;
let isTranslating = false;
let observer = null;
let translatedNodes = new WeakSet();
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
  const stored = await browserApi.storage.sync.get(TRANSLATOR_DEFAULT_SETTINGS);
  return {
    sites: Array.isArray(stored.sites) ? stored.sites : TRANSLATOR_DEFAULT_SETTINGS.sites,
    autoTranslate: stored.autoTranslate !== false,
    sourceLanguage: normalizeLanguage(stored.sourceLanguage, TRANSLATOR_DEFAULT_SETTINGS.sourceLanguage),
    targetLanguage: normalizeLanguage(stored.targetLanguage, TRANSLATOR_DEFAULT_SETTINGS.targetLanguage),
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
      cachedSettings.sites = Array.isArray(changes.sites.newValue) ? changes.sites.newValue : [];
    }

    if (changes.autoTranslate) {
      cachedSettings.autoTranslate = changes.autoTranslate.newValue !== false;
    }

    if (changes.sourceLanguage) {
      cachedSettings.sourceLanguage = normalizeLanguage(
        changes.sourceLanguage.newValue,
        TRANSLATOR_DEFAULT_SETTINGS.sourceLanguage
      );
    }

    if (changes.targetLanguage) {
      cachedSettings.targetLanguage = normalizeLanguage(
        changes.targetLanguage.newValue,
        TRANSLATOR_DEFAULT_SETTINGS.targetLanguage
      );
    }

    if (changes.selectionTargetLanguage) {
      cachedSettings.selectionTargetLanguage = normalizeLanguage(
        changes.selectionTargetLanguage.newValue,
        TRANSLATOR_DEFAULT_SETTINGS.selectionTargetLanguage
      );
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
  return cachedSettings.autoTranslate && isSiteEnabled(window.location.hostname, cachedSettings.sites);
}

function isSiteEnabled(hostname, sites) {
  return sites.some((pattern) => matchSitePattern(hostname, pattern));
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
      const texts = batch.map((node) => node.textContent.trim()).filter(Boolean);
      if (!texts.length) {
        continue;
      }

      const { translations } = await browserApi.runtime.sendMessage({
        type: "translate-text-batch",
        payload: {
          texts,
          sourceLanguage: cachedSettings.sourceLanguage,
          targetLanguage: cachedSettings.targetLanguage
        }
      });

      batch.forEach((node, index) => {
        const translated = translations?.[index];
        if (translated && translated !== node.textContent.trim()) {
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

      if (value.trim().length > MAX_TEXT_LENGTH || !matchesSourceLanguage(value, cachedSettings.sourceLanguage)) {
        return NodeFilter.FILTER_REJECT;
      }

      if (translatedNodes.has(node)) {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const nodes = [];
  let currentNode = walker.nextNode();

  while (currentNode) {
    translatedNodes.add(currentNode);
    nodes.push(currentNode);
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

  const detectedLabel = getLanguageLabel(detectedLanguage);
  overlay.textContent = detectedLabel ? `${detectedLabel} -> ${getLanguageLabel(cachedSettings.selectionTargetLanguage)}\n${translation}` : translation;
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

function normalizeLanguage(value, fallback) {
  const validCodes = TRANSLATOR_LANGUAGES.map((language) => language.code);
  return validCodes.includes(value) ? value : fallback;
}

function getLanguageLabel(code) {
  const match = TRANSLATOR_LANGUAGES.find((language) => language.code === code);
  return match ? match.label : "";
}
