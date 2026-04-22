const browserApi = typeof browser !== "undefined" ? browser : chrome;

async function ensureDefaults() {
  const stored = await browserApi.storage.sync.get(TRANSLATOR_DEFAULT_SETTINGS);
  await browserApi.storage.sync.set({
    sites: Array.isArray(stored.sites) ? stored.sites : TRANSLATOR_DEFAULT_SETTINGS.sites,
    autoTranslate: stored.autoTranslate !== false,
    sourceLanguage: normalizeLanguage(stored.sourceLanguage, TRANSLATOR_DEFAULT_SETTINGS.sourceLanguage),
    targetLanguage: normalizeLanguage(stored.targetLanguage, TRANSLATOR_DEFAULT_SETTINGS.targetLanguage),
    selectionTargetLanguage: normalizeLanguage(
      stored.selectionTargetLanguage,
      normalizeLanguage(stored.targetLanguage, TRANSLATOR_DEFAULT_SETTINGS.selectionTargetLanguage)
    )
  });
}

browserApi.runtime.onInstalled.addListener(() => {
  ensureDefaults().catch((error) => {
    console.error("Failed to initialize settings", error);
  });
});

browserApi.runtime.onMessage.addListener((message, sender) => {
  if (!message) {
    return undefined;
  }

  if (message.type === "translate-text-batch") {
    return translateBatch(message.payload);
  }

  if (message.type === "translate-selection") {
    return translateSelection(message.payload);
  }

  return undefined;
});

async function translateBatch(payload) {
  const texts = Array.isArray(payload?.texts) ? payload.texts : [];
  const sourceLanguage = normalizeLanguage(payload?.sourceLanguage, TRANSLATOR_DEFAULT_SETTINGS.sourceLanguage);
  const targetLanguage = normalizeLanguage(payload?.targetLanguage, TRANSLATOR_DEFAULT_SETTINGS.targetLanguage);
  if (!texts.length) {
    return { translations: [] };
  }

  const translations = await Promise.all(
    texts.map(async (text) => {
      const result = await translateText(text, sourceLanguage, targetLanguage);
      return result.translation;
    })
  );
  return { translations };
}

async function translateSelection(payload) {
  const text = typeof payload?.text === "string" ? payload.text.trim() : "";
  const targetLanguage = normalizeLanguage(
    payload?.targetLanguage,
    TRANSLATOR_DEFAULT_SETTINGS.selectionTargetLanguage
  );
  if (!text) {
    return { translation: "", detectedLanguage: "" };
  }

  const result = await translateText(text, "auto", targetLanguage);
  return {
    translation: result.translation,
    detectedLanguage: result.detectedLanguage
  };
}

async function translateText(text, sourceLanguage, targetLanguage) {
  const query = new URLSearchParams();
  query.set("client", "gtx");
  query.set("sl", sourceLanguage);
  query.set("tl", targetLanguage);
  query.set("dt", "t");
  query.set("q", text);

  const response = await fetch(`https://translate.googleapis.com/translate_a/single?${query.toString()}`);
  if (!response.ok) {
    throw new Error(`Translation request failed with status ${response.status}`);
  }

  const data = await response.json();
  return {
    translation: flattenSegments(data[0]),
    detectedLanguage: typeof data[2] === "string" ? data[2] : sourceLanguage
  };
}

function flattenSegments(segments) {
  if (!Array.isArray(segments)) {
    return "";
  }

  return segments
    .map((segment) => (Array.isArray(segment) ? segment[0] : ""))
    .join("")
    .trim();
}

function normalizeLanguage(value, fallback) {
  const validCodes = TRANSLATOR_LANGUAGES.map((language) => language.code);
  return validCodes.includes(value) ? value : fallback;
}
