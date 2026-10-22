# Translating StarLight

StarLight speaks Italian and English. This guide explains how to add a new
language or improve an existing one. No programming is needed for the
interface texts: they are plain JSON files. Some longer contents (help, quick
tour, glossary) are TypeScript data files and need one line of code to be
registered.

## Contents

- [How languages work](#how-languages-work)
- [Adding a language](#adding-a-language)
- [Rules for the texts](#rules-for-the-texts)
- [Longer contents](#longer-contents)
- [Plugins and catalogs](#plugins-and-catalogs)
- [Checking a translation](#checking-a-translation)
- [What is never translated](#what-is-never-translated)

## How languages work

Every text shown to the user lives in `src/shared/i18n/locales/<language>/`,
one JSON file per area of the program (a *namespace*): `menuBar.json`,
`settingsWindow.json`, `stackPanel.json` and so on. The folder name is the
language code: `it`, `en`, `fr`, `de`, `pt-BR`…

- **Italian (`it`) is the reference language**: it has every key, and it
  decides which namespaces exist.
- **English (`en`) is the fallback language**: it also has every key.
- A text missing in a language falls back to English, then to Italian. A
  partial translation therefore works from the first file translated: the
  missing parts simply show in English.

The language is chosen in **Settings → General → Language**. With
**Automatic**, StarLight follows the Windows language when it is available,
and English otherwise.

Numbers and dates follow the language too (decimal separator, grouping,
month names), through the locale tag declared in the language's
`common.json`.

## Adding a language

1. **Create the folder.** Copy `src/shared/i18n/locales/en/` to a new folder
   named with the language code, for example `src/shared/i18n/locales/fr/`.
   The code is a two- or three-letter ISO 639 code, optionally followed by a
   region in capitals (`pt-BR`). Copying the English folder is easier than
   the Italian one for most translators; both have the same keys.

2. **Declare the language** in `common.json`:

   ```json
   {
     "language": {
       "name": "Français",
       "locale": "fr-FR",
       "label": "Langue",
       "hint": "…",
       "auto": "Automatique"
     }
   }
   ```

   `name` is the language's own name, as it appears in the language list.
   `locale` is the BCP 47 tag used to format numbers and dates.

3. **Translate the values**, file by file. Change only the text on the right
   of each `:`; never the keys on the left.

4. **Regenerate the language index**:

   ```
   node tools/generate-locales-index.mjs
   ```

   This rewrites `src/shared/i18n/locales.ts`, which must never be edited by
   hand. It has to run again whenever a language folder or a JSON file is
   added or removed (`npm run dist` runs it too).

5. **Check** the translation (see [Checking a translation](#checking-a-translation))
   and start the program with `npm run dev`: the new language appears in
   Settings → General → Language.

A language may leave out whole files: those areas show in English. It may
not add files or keys that Italian lacks.

## Rules for the texts

- **Placeholders** are written `{name}` and are replaced by the program with
  a value (a file name, a number, a count). Keep every placeholder of the
  original, spelled exactly the same; their order in the sentence may change.

  ```json
  "unreadableFiles": "{count} files could not be read: {error}"
  ```

- **Singular and plural** usually have separate keys (`countOne`,
  `countOther`): translate both even when the language does not distinguish
  them.
- **Tone.** The interface addresses the user directly, with the informal
  form where the language has one (Italian uses *tu*). Help pages and the
  glossary are impersonal.
- **Consistency.** Use the same word for the same thing everywhere, and refer
  to buttons and menus with their exact label. When a label changes, search
  the help and glossary for it.
- **Brands.** No telescope or camera brand appears in the texts: StarLight
  works with any instrument, and a model name is shown only when it is read
  from a file.
- **Typography.** Use the quotation marks, apostrophes and spacing rules of
  the language (« », “ ”, „ “…), and keep line breaks out of the texts: the
  layout wraps them.
- **English** uses American spelling (*color*, *center*, *gray*).
- **Length.** Some labels sit in narrow places (the workflow steps, the
  status bar, buttons). Keep them short and check them in the program.

## Longer contents

Some contents are too long or too structured for a JSON file. Each exists
as one file per language and is chosen with `byLanguage()` (in
`src/shared/i18n/i18n.ts`), which falls back to English and then Italian:

| Content | Files | Registered in |
|---|---|---|
| Help center | `src/renderer/src/components/helpContent.<lang>.ts` | `HelpCenter.tsx` |
| Quick tour | `src/renderer/src/components/onboardingSteps.<lang>.ts` | `Onboarding.tsx` |
| Glossary | `src/renderer/src/glossary/terms.<lang>.ts` | `glossary/terms.ts` |
| What's new | `src/shared/whatsNew.<lang>.json` (Italian: `whatsNew.json`) | `WhatsNewButton.tsx`, `tools/write-release-notes.mjs` |
| Constellation and object names | `src/core/catalog/` | `catalog.ts` |

To translate one of them, copy the English file with the new language code,
translate it, and add it to the `byLanguage({ it: …, en: … })` call where
it is registered:

```ts
return byLanguage({ it: HELP_CONTENT_IT, en: HELP_CONTENT_EN, fr: HELP_CONTENT_FR })
```

Until then these contents show in English, while the rest of the program is
already in the new language.

## Plugins and catalogs

Plugins and deep-sky catalogs carry their own translations in their
manifest, in a `translations` field keyed by language code. A new language
does not need any change to them: missing translations fall back to English.
See [Translations](plugin.md#translations) in the plugin guide and
[Languages](catalogs.md#languages) in the catalog guide.

## Checking a translation

```
npm run test -- --only languages
```

The check reports, for every language:

- keys that Italian lacks (an error: they would never be used);
- placeholders that differ from the Italian text (an error);
- empty texts and a missing or invalid `common.language.name` or
  `common.language.locale` (errors);
- how many keys are still missing (not an error: they show in English).

Then look at the program: long words that overflow, labels cut in narrow
places, sentences that read badly once the placeholders are filled.

## What is never translated

- Keys, file names, namespaces and anything in the code.
- The log (`starlight.log`): its messages are written in English in the code,
  so that it can be read by whoever helps with a problem. Only error texts
  that were also shown to the user may appear in the chosen language.
- Names of file formats (FITS, XISF, TIFF…), units (s, px, arcsec) and
  catalog identifiers (M 31, NGC 7331, IC 434).
