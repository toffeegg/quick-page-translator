const browserApi = typeof browser !== "undefined" ? browser : chrome;

async function ensureDefaults() {
  const stored = await browserApi.storage.sync.get(null);
  const pageTranslationRules = getStoredPageTranslationRules(stored);
  await browserApi.storage.sync.set({
    sites: normalizeSites(stored.sites),
    autoTranslate: stored.autoTranslate !== false,
    pageTranslationMode: normalizePageTranslationMode(stored.pageTranslationMode),
    pageTranslationRules,
    showOriginalOnTranslatedSelection: stored.showOriginalOnTranslatedSelection !== false,
    selectionTargetLanguage: normalizeLanguage(
      stored.selectionTargetLanguage,
      pageTranslationRules[0]?.targetLanguage ?? TRANSLATOR_DEFAULT_SETTINGS.selectionTargetLanguage
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
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (!items.length) {
    return { translations: [] };
  }

  const translations = await Promise.all(
    items.map(async (item) => {
      const text = typeof item?.text === "string" ? item.text.trim() : "";
      if (!text) {
        return "";
      }

      const sourceLanguage = normalizeSourceLanguage(item?.sourceLanguage);
      const targetLanguages = normalizeTargetLanguages(item?.targetLanguages, sourceLanguage);
      const translatedVersions = await Promise.all(
        targetLanguages.map(async (targetLanguage) => {
          const result = await translateText(text, sourceLanguage, targetLanguage);
          return result.translation;
        })
      );
      return combineTranslations(translatedVersions);
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

function normalizeSites(sites) {
  if (!Array.isArray(sites)) {
    return TRANSLATOR_DEFAULT_SETTINGS.sites.map((site) => normalizeSiteEntry(site)).filter(Boolean);
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

function normalizeSourceLanguage(value) {
  return value === "auto"
    ? "auto"
    : normalizeLanguage(value, TRANSLATOR_DEFAULT_SETTINGS.pageTranslationRules[0].sourceLanguage);
}

function normalizeTargetLanguages(values, sourceLanguage) {
  if (!Array.isArray(values) || !values.length) {
    const fallbackTarget = TRANSLATOR_DEFAULT_SETTINGS.pageTranslationRules[0].targetLanguage;
    return [sourceLanguage === fallbackTarget ? getFallbackTarget(sourceLanguage) : fallbackTarget];
  }

  const validCodes = new Set(TRANSLATOR_LANGUAGES.map((language) => language.code));
  const normalized = values
    .filter((value) => validCodes.has(value))
    .filter((value) => sourceLanguage === "auto" || value !== sourceLanguage)
    .filter((value, index, array) => array.indexOf(value) === index)
    .slice(0, 3);

  return normalized.length ? normalized : [TRANSLATOR_DEFAULT_SETTINGS.pageTranslationRules[0].targetLanguage];
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

function combineTranslations(translations) {
  return translations.filter(Boolean).join(" / ");
}

function getFallbackTarget(sourceLanguage) {
  return sourceLanguage === "en" ? "ko" : "en";
}

function cloneDefaultPageTranslationRules() {
  return TRANSLATOR_DEFAULT_SETTINGS.pageTranslationRules.map((rule) => ({ ...rule }));
}
