/*
 * Splash window.
 *
 * When the app starts, a small frameless window with the logo, a quotation
 * and the version appears immediately in the center of the screen, while the
 * main window gets ready hidden. Once the interface has drawn its first
 * content, the main window is shown and the splash fades out and closes.
 *
 * The page is a static file (resources/splash/splash.html), without React:
 * it must be ready in an instant, before everything else.
 *
 * Two waits, for opposite reasons:
 * - a minimum visible time, because a window that appears and vanishes in a
 *   tenth of a second looks like a glitch, not a welcome;
 * - a maximum safety time: if for any reason the interface never reports
 *   that it is ready, the main window is shown anyway instead of leaving the
 *   user in front of the logo alone.
 */
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { APP_VERSION, APP_CODENAME } from '@shared/version'
import { getLanguage, isLanguage, languageForLocale, setLanguage, t } from '../shared/i18n/i18n'

/**
 * A splash window quotation. The text and the author come from the language
 * files (`mainSplash.phrases.<id>`); `source` is not shown and lets anyone
 * reading the code find the original text.
 */
interface Phrase {
  id: string
  source: string
}

/*
 * The quotations, one at random at every startup. Each was checked against
 * the original work or Wikiquote: no dubious attributions. Italian authors
 * appear in their original words; for the others the Italian text uses a
 * published translation or a faithful one, and the English text uses a
 * published English translation where one exists. About 110 characters, so
 * the sentence fits on two lines. No more than two per author.
 */
const PHRASES: readonly Phrase[] = [
  { id: 'dante1', source: 'Inferno XXXIV, 139' },
  { id: 'dante2', source: 'Paradiso XXXIII, 145' },
  { id: 'leopardi1', source: 'Canto notturno di un pastore errante dell’Asia, lines 1-2, 1830' },
  { id: 'leopardi2', source: 'Le ricordanze, lines 1-2, 1829' },
  { id: 'pascoli', source: 'X Agosto, Myricae, 1896' },
  { id: 'ungaretti', source: 'Mattina, 1917 (L’Allegria)' },
  { id: 'galileo1', source: 'Il Saggiatore (The Assayer), ch. 6, 1623' },
  { id: 'galileo2', source: 'Sidereus Nuncius, 1610' },
  { id: 'hack', source: 'in U. Veronesi, Dell’amore e del dolore delle donne, Einaudi 2010, p. 69' },
  { id: 'copernicus', source: 'De revolutionibus orbium coelestium, I, 10, 1543' },
  { id: 'kepler', source: 'Epitaph written for himself, 1630' },
  { id: 'ptolemy', source: 'Epigram, Palatine Anthology IX, 577; at the head of some manuscripts of the Almagest' },
  { id: 'ovid', source: 'Metamorphoses I, 85-86' },
  { id: 'kant', source: 'Critique of Practical Reason, Conclusion, 1788' },
  { id: 'pascal', source: 'Pensées, fr. 206 Brunschvicg (201 Lafuma), 1670' },
  { id: 'hugo', source: 'Les Misérables, I, VII, 3 "A tempest in a skull", 1862' },
  { id: 'wilde', source: 'Lady Windermere’s Fan, act III, 1892' },
  { id: 'vanGogh1', source: 'Letter to Theo no. 638, 9-10 July 1888' },
  { id: 'vanGogh2', source: 'Letter to Theo no. 691, 29 September 1888' },
  { id: 'saintExupery1', source: 'The Little Prince, ch. XVII, 1943' },
  { id: 'saintExupery2', source: 'The Little Prince, ch. XXVI, 1943' },
  { id: 'einstein1', source: 'The World as I See It (Mein Weltbild), 1931' },
  { id: 'einstein2', source: 'Physics and Reality (Physik und Realität), 1936' },
  { id: 'hubble', source: 'The Exploration of Space, Harper’s Magazine, May 1929' },
  { id: 'feynman', source: 'The Feynman Lectures on Physics, vol. I, ch. 3, 1963' },
  { id: 'sagan1', source: 'Cosmos, episode 1, 1980' },
  { id: 'sagan2', source: 'Pale Blue Dot, 1994' },
  { id: 'rubin', source: 'Bright Galaxies, Dark Matters, 1997, preface' },
  { id: 'hawking', source: 'Brief Answers to the Big Questions, 2018; earlier at the London Paralympics, 2012' },
  { id: 'tyson', source: 'Astrophysics for People in a Hurry, epigraph, 2017' }
]

function phraseText(phrase: Phrase): string {
  return t('mainSplash.phrases.' + phrase.id + '.text')
}

function phraseAuthor(phrase: Phrase): string {
  return t('mainSplash.phrases.' + phrase.id + '.author')
}

/** Minimum time the splash window stays visible, in milliseconds. */
const MIN_VISIBLE_MS = 7000
/** After this time the main window is shown anyway. */
const MAX_WAIT_MS = 20000
/** How long to wait for the interface to draw its first content. */
const CONTENT_WAIT_MS = 5000

let splashWindow: BrowserWindow | null = null
/** When the splash window appeared. */
let shownAt = 0

function resourcesFolder(): string {
  return app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources')
}

/** Reads a JSON file from the data folder; a missing or damaged file counts as empty. */
function readJson(name: string): Record<string, unknown> {
  try {
    const data = JSON.parse(readFileSync(join(app.getPath('userData'), name), 'utf-8')) as unknown
    return data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The settings that matter here, read from the preferences file. */
function startupSettings(): { active: boolean; reducedMotion: boolean; language: unknown } {
  const settings = readJson('preferences.json')['settings']
  const g = (settings !== null && typeof settings === 'object' ? settings : {}) as Record<string, unknown>
  return {
    active: g['splashWindow'] !== false,
    reducedMotion: g['reducedMotion'] === true,
    language: g['language']
  }
}

/*
 * Applies the language chosen in the settings to the main process before
 * anything is shown: the splash texts, and the dialogs until the interface
 * sends its own choice. 'auto' (or no choice yet) means the Windows language.
 */
function applySavedLanguage(language: unknown): void {
  setLanguage(isLanguage(language) ? language : languageForLocale(app.getLocale()))
}

/*
 * Picks the quotation, avoiding the one shown last time. The last quotation
 * is remembered in a separate file rather than in the preferences: the
 * interface rewrites the preferences in full, and two writes to the same
 * file at the same moment could each lose the other's change.
 */
function choosePhrase(): Phrase {
  const last = readJson('startup.json')['lastPhrase']
  const candidates = PHRASES.filter((f) => phraseText(f) !== last)
  const choice = candidates[Math.floor(Math.random() * candidates.length)] ?? PHRASES[0]
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(
      join(app.getPath('userData'), 'startup.json'),
      JSON.stringify({ lastPhrase: phraseText(choice) }, null, 2),
      'utf-8'
    )
  } catch {
    // Failing to remember the quotation is harmless: at worst it repeats.
  }
  return choice
}

/**
 * Applies the saved language and opens the splash window, unless the
 * settings turned it off. Must be called first, as soon as the app is ready.
 */
export function openSplashWindow(): void {
  const { active, reducedMotion, language } = startupSettings()
  applySavedLanguage(language)
  if (!active || splashWindow) return

  const phrase = choosePhrase()
  // Ten pixels per side are reserved for the card shadow (see splash.html).
  splashWindow = new BrowserWindow({
    width: 540,
    height: 360,
    center: true,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: 'StarLight',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  splashWindow.setMenu(null)
  splashWindow.once('ready-to-show', () => {
    if (!splashWindow) return
    // Bring it to the foreground: the user launched the app, and Windows
    // leaves a window shown without activation behind the active one.
    splashWindow.setAlwaysOnTop(true, 'screen-saver')
    splashWindow.show()
    splashWindow.moveTop()
    splashWindow.focus()
    shownAt = Date.now()
    void captureStartupIfRequested()
  })
  splashWindow.on('closed', () => {
    splashWindow = null
  })
  shownAt = Date.now()

  void splashWindow.loadFile(join(resourcesFolder(), 'splash', 'splash.html'), {
    query: {
      phrase: phraseText(phrase),
      author: phraseAuthor(phrase),
      version: t('mainSplash.version', { version: APP_VERSION, codename: APP_CODENAME }),
      logo: pathToFileURL(join(resourcesFolder(), 'icon.svg')).href,
      lang: getLanguage(),
      label: t('mainSplash.label'),
      starting: t('mainSplash.starting'),
      reducedMotion: reducedMotion ? '1' : '0'
    }
  })
}

/** Updates the progress bar and caption of the splash window, if it is open. */
function step(percent: number, text: string): void {
  if (!splashWindow || splashWindow.isDestroyed()) return
  void splashWindow.webContents
    .executeJavaScript(`window.splash && window.splash.step(${percent}, ${JSON.stringify(text)})`)
    .catch(() => undefined)
}

/** Fades out and closes the splash window. */
async function closeSplash(): Promise<void> {
  const f = splashWindow
  if (!f || f.isDestroyed()) return
  splashWindow = null
  let wait = 0
  try {
    wait = Number(await f.webContents.executeJavaScript('window.splash ? window.splash.close() : 0')) || 0
  } catch {
    wait = 0
  }
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  if (!f.isDestroyed()) f.destroy()
}

/*
 * The 'ready-to-show' event fires at the page's first paint, which for a
 * React interface may still be empty. Here we wait until the interface has
 * put something in its container and that content has been painted (two
 * frames), with a time limit.
 */
const WAIT_FOR_CONTENT = `new Promise((done) => {
  const limit = Date.now() + ${CONTENT_WAIT_MS};
  const check = () => {
    const root = document.getElementById('root');
    if ((root && root.childElementCount > 0) || Date.now() > limit) {
      requestAnimationFrame(() => requestAnimationFrame(() => done(true)));
    } else {
      setTimeout(check, 30);
    }
  };
  check();
})`

/**
 * Follows the loading of the main window (created hidden): advances the
 * splash progress bar with the actual phases, shows the main window as soon
 * as it is ready and the minimum time has passed, then closes the splash.
 * `afterShown` runs only once, when the window is visible.
 */
export function accompanyStartup(main: BrowserWindow, afterShown: () => void): void {
  let shown = false

  const show = (): void => {
    if (shown) return
    shown = true
    clearTimeout(security)
    if (!main.isDestroyed()) {
      main.show()
      // Focus moves from the splash window to the main one.
      main.focus()
      afterShown()
    }
    void closeSplash()
  }

  const security = setTimeout(show, MAX_WAIT_MS)

  // Without a splash window, fall back to the simple behavior.
  if (!splashWindow) {
    main.once('ready-to-show', show)
    return
  }

  main.webContents.once('did-start-loading', () => step(25, t('mainSplash.phases.loading')))
  main.webContents.once('dom-ready', () => step(55, t('mainSplash.phases.tools')))
  main.once('ready-to-show', () => {
    step(80, t('mainSplash.phases.firstPaint'))
    void main.webContents
      .executeJavaScript(WAIT_FOR_CONTENT)
      .catch(() => undefined)
      .then(async () => {
        step(100, t('mainSplash.phases.ready'))
        const missing = MIN_VISIBLE_MS - (Date.now() - shownAt)
        if (missing > 0) await new Promise((r) => setTimeout(r, missing))
        show()
      })
  })
  // If the main window closes before appearing, nothing is left open.
  main.once('closed', () => {
    clearTimeout(security)
    void closeSplash()
  })
}

/** True until the main window has been shown. */
export function startupInProgress(): boolean {
  return splashWindow !== null
}

/**
 * Development check capture: with STARLIGHT_CAPTURE_SPLASH set to a path,
 * takes a screenshot of the splash window shortly after it appears (once the
 * entrance animation has finished).
 */
async function captureStartupIfRequested(): Promise<void> {
  if (app.isPackaged) return
  const destination = process.env['STARLIGHT_CAPTURE_SPLASH']
  if (!destination) return
  await new Promise((r) => setTimeout(r, 500))
  if (!splashWindow || splashWindow.isDestroyed()) return
  const image = await splashWindow.webContents.capturePage()
  await writeFile(destination, image.toPNG())
  console.log('[StarLight] splash window capture saved to ' + destination)
}
