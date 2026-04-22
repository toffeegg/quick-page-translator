# Quick Page Translator

Firefox extension that automatically translates configured websites using your chosen language pair, plus an instant `Ctrl` + highlight translator for selected text.

## What it does

- Lets you add and delete website domains in the extension settings page
- Lets you choose a source language and target language for automatic page translation
- Lets you choose a target language for `Ctrl` + highlight translation
- Detects the selected text language automatically for highlight translation
- Watches dynamic pages and translates newly added text too

## Files

- `manifest.json` - extension manifest
- `constants.js` - shared language options and default settings
- `background.js` - translation and language-detection requests
- `content.js` - page scanning, DOM replacement, and the `Ctrl` + highlight overlay
- `options.html`, `options.css`, `options.js` - settings UI
- `popup.html`, `popup.css`, `popup.js` - quick status popup

## Load in Firefox

1. Open `about:debugging` in Firefox.
2. Click `This Firefox`.
3. Click `Load Temporary Add-on`.
4. Choose `manifest.json` from this folder.

## Notes

- This version uses the public Google Translate web endpoint, which is convenient but unofficial and may be rate-limited or changed by Google.
