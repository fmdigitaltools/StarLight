/*
 * StarLight installer window.
 *
 * Runs inside Neutralinojs, started by the NSIS installer (see
 * resources/installer/installer.nsh), which first writes the starting data
 * to "startup.txt": where the installer is, the proposed folder, the size of
 * the program files and so on.
 *
 * The actual installation is always done by the electron-builder engine:
 * this page relaunches the same installer silently with the choices made
 * (/S /D=folder and a few options) and follows its work:
 *   - it measures the bytes already extracted into the installer's temporary
 *     folder and then those copied into the program folder, comparing them
 *     with the size known at build time;
 *   - it reads the phases the installer notes in "progress.txt"
 *     (shortcuts, file types, done).
 * At the end it creates the work folder and writes it into StarLight's
 * preferences (preferences.json, key settings.workFolder), merging it with
 * what the file already contains.
 */
(function () {
  'use strict'

  Neutralino.init()
  const T = globalThis.installerTexts
  T.apply()

  // ---------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------
  const $ = (id) => document.getElementById(id)
  const MB = 1024 * 1024
  const GB = 1024 * MB

  /** Windows-style path, without a trailing backslash. */
  function windowsPath(p) {
    let q = String(p || '').replace(/\//g, '\\')
    if (q.length > 3) q = q.replace(/\\+$/, '')
    return q
  }
  function joinPath(base, name) {
    return windowsPath(base).replace(/\\$/, '') + '\\' + name
  }
  function lastName(p) {
    const parts = windowsPath(p).split('\\')
    return parts[parts.length - 1] || ''
  }
  function formatMB(bytes) {
    return T.number(Math.round(bytes / MB)) + ' MB'
  }
  function formatGB(bytes) {
    const g = bytes / GB
    return T.number(g >= 100 ? Math.round(g) : Math.round(g * 10) / 10) + ' GB'
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  /** Reads a text file written by NSIS in UTF-16 (with or without BOM). */
  async function readUtf16(path) {
    const data = await Neutralino.filesystem.readBinaryFile(path)
    return new TextDecoder('utf-16le').decode(data).replace(/^﻿/, '')
  }
  function keyValueLines(text) {
    const result = {}
    for (const line of text.split(/\r?\n/)) {
      const i = line.indexOf('=')
      if (i > 0) result[line.slice(0, i)] = line.slice(i + 1)
    }
    return result
  }

  async function exists(path) {
    try {
      await Neutralino.filesystem.getStats(path)
      return true
    } catch {
      return false
    }
  }

  /** Bytes taken by the files of a folder (0 if it does not exist yet). */
  async function folderSize(path) {
    let entries
    try {
      entries = await Neutralino.filesystem.readDirectory(path, { recursive: true })
    } catch {
      return 0
    }
    let total = 0
    for (const e of entries) {
      if (e.type !== 'FILE') continue
      try {
        total += (await Neutralino.filesystem.getStats(e.path)).size
      } catch {
        // file just moved or deleted: counted on the next round
      }
    }
    return total
  }

  /** Free space on the drive of a path, in bytes; null if unknown. */
  async function freeSpace(path) {
    const letter = /^([A-Za-z]):/.exec(path)
    if (!letter) return null
    try {
      const r = await Neutralino.os.execCommand(
        'powershell -NoProfile -NonInteractive -Command "[System.IO.DriveInfo]::new(\'' + letter[1] + '\').AvailableFreeSpace"'
      )
      const n = Number(r.stdOut.trim())
      return Number.isFinite(n) && n > 0 ? n : null
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------------
  // Starting data
  // ---------------------------------------------------------------------
  const state = {
    startup: {},
    uiFolder: '',
    size: 0,
    programFolder: '',
    workFolder: '',
    free: null,
    initialExisting: 0,
    installing: false,
    installed: false,
    // The quick tour starts only while the preferences do not mark it as seen
    // (onboardingCompleted, see src/renderer/src/App.tsx): installing over a
    // previous version keeps them, so the tour does not start again.
    tourSeen: false
  }

  const panels = [...document.querySelectorAll('[data-step]')]
  const stepItems = [...document.querySelectorAll('#indicator li')]
  const next = $('next')
  const back = $('back')
  const cancel = $('cancel')
  let step = 0

  /**
   * The window starts hidden: Neutralino sets its size in screen pixels,
   * while the page is drawn in "logical" pixels. With a scaled screen (for
   * example at 150%) it is enlarged accordingly, centred and only then shown.
   */
  async function fitWindow() {
    const width = 820
    const height = 620
    try {
      const scale = devicePixelRatio || 1
      await Neutralino.window.setSize({ width: Math.round(width * scale), height: Math.round(height * scale) })
      await Neutralino.window.center()
    } finally {
      await Neutralino.window.show()
      await Neutralino.window.focus()
    }
  }

  async function prepare() {
    await fitWindow()
    state.uiFolder = windowsPath(NL_CWD)
    state.startup = keyValueLines(await readUtf16(state.uiFolder + '\\startup.txt'))
    // Signal for the installer: the interface really opened.
    await Neutralino.filesystem.writeFile(state.uiFolder + '\\opened.txt', '1')

    const s = state.startup
    // Windows display language, as read by the installer.
    if (s.language) T.setLanguage(s.language)
    state.size = Number(s.sizeKB || 0) * 1024
    state.programFolder = windowsPath(s.programFolder)

    $('version').textContent = T.text('version', { version: s.version || '' }) + (s.codename ? ' · ' + s.codename : '')
    if (state.size > 0) {
      $('space-intro').textContent = T.text('spaceIntro', { size: formatMB(state.size) })
    }

    // Work folder: the one chosen in the past, if any, otherwise
    // Documents\StarLight as the program proposes.
    state.workFolder = joinPath(s.documents, 'StarLight')
    try {
      const prefs = JSON.parse(await Neutralino.filesystem.readFile(joinPath(s.data, 'preferences.json')))
      const chosen = prefs && prefs.settings && prefs.settings.workFolder
      if (typeof chosen === 'string' && chosen.trim()) state.workFolder = windowsPath(chosen)
      state.tourSeen = prefs !== null && typeof prefs === 'object' && prefs.onboardingCompleted === true
    } catch {
      // no preferences yet: the proposal is fine
    }

    updateFolders()
    $('first-run').hidden = state.tourSeen
    show(0)
    try {
      await Neutralino.window.setDraggableRegion('brand')
      await Neutralino.window.setDraggableRegion('indicator')
    } catch {
      // without dragging the window is still usable
    }
  }

  // ---------------------------------------------------------------------
  // Folders
  // ---------------------------------------------------------------------
  const productName = () => state.startup.name || 'StarLight'

  function updateFolders() {
    $('program-path').textContent = state.programFolder
    $('program-path').title = state.programFolder
    $('work-path').textContent = state.workFolder
    $('work-path').title = state.workFolder
    void showTree()
    void updateSpace()
  }

  const FOLDER_KEYS = ['folderProjects', 'folderExports', 'folderSessions']

  /**
   * Names of the three subfolders in a work folder: the ones already there in
   * any language, the current one first, otherwise the ones of the current
   * language. StarLight follows the same rule (subfolderName in
   * src/renderer/src/settings.ts), so a folder created in another language is
   * used instead of a new one next to it.
   */
  async function subfolderNames(base) {
    const languages = [T.language(), ...Object.keys(T.TEXTS).filter((l) => l !== T.language())]
    const names = []
    for (const key of FOLDER_KEYS) {
      let chosen = T.TEXTS[T.language()][key]
      for (const l of languages) {
        const name = T.TEXTS[l][key]
        if (name && (await exists(joinPath(base, name)))) {
          chosen = name
          break
        }
      }
      names.push(chosen)
    }
    return names
  }

  let treeRequest = 0
  async function showTree() {
    const thisRequest = ++treeRequest
    const base = state.workFolder
    const names = await subfolderNames(base)
    if (thisRequest !== treeRequest) return
    $('tree').innerHTML = ''
    const b = document.createElement('b')
    b.textContent = base
    // The first line is a block of its own (shortened with an ellipsis if long).
    $('tree').append(b, '├─ ' + names[0] + '\n├─ ' + names[1] + '\n└─ ' + names[2])
  }

  let spaceRequest = 0
  async function updateSpace() {
    const note = $('space-note')
    const thisRequest = ++spaceRequest
    const drive = (/^([A-Za-z]:)/.exec(state.programFolder) || [])[1]
    note.classList.remove('warning')
    note.textContent = drive
      ? T.text('spaceChecking', { size: formatMB(state.size), drive })
      : T.text('spaceNeeded', { size: formatMB(state.size) })
    const free = await freeSpace(state.programFolder)
    if (thisRequest !== spaceRequest) return
    state.free = free
    if (free == null) {
      note.textContent = T.text('spaceNeeded', { size: formatMB(state.size) })
    } else {
      note.textContent = T.text('spaceFree', { size: formatMB(state.size), drive, free: formatGB(free) })
      if (free < state.size * 1.05) {
        note.classList.add('warning')
        note.textContent += T.text('spaceShort')
      }
    }
    if (step === 1) next.disabled = !validChoice()
  }

  function validChoice() {
    const absolute = (p) => /^[A-Za-z]:\\/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p)
    if (!absolute(state.programFolder) || !absolute(state.workFolder)) return false
    if (state.free != null && state.free < state.size * 1.05) return false
    return true
  }

  /**
   * The chosen folder gets a "StarLight" subfolder, unless it is already
   * called that: the uninstaller deletes the whole program folder, so it
   * must never be a folder that contains anything else.
   */
  function withSubfolder(choice) {
    const p = windowsPath(choice)
    return lastName(p).toLowerCase() === productName().toLowerCase() ? p : joinPath(p, productName())
  }

  async function chooseFolder(title, current) {
    try {
      const choice = await Neutralino.os.showFolderDialog(title, { defaultPath: current })
      return choice ? withSubfolder(choice) : null
    } catch {
      return null
    }
  }

  $('change-program').addEventListener('click', async () => {
    const p = await chooseFolder(T.text('programFolder'), state.programFolder)
    if (p) {
      state.programFolder = p
      updateFolders()
    }
  })
  $('change-work').addEventListener('click', async () => {
    const p = await chooseFolder(T.text('workFolder'), state.workFolder)
    if (p) {
      state.workFolder = p
      updateFolders()
    }
  })

  // ---------------------------------------------------------------------
  // Steps
  // ---------------------------------------------------------------------
  function show(n) {
    step = n
    panels.forEach((p, i) => (p.hidden = i !== n))
    stepItems.forEach((v, i) => {
      v.className = i < n ? 'done' : i === n ? 'active' : ''
    })
    back.hidden = n === 0 || n >= 2
    cancel.hidden = n === 2
    cancel.textContent = T.text(n === 3 ? 'close' : 'cancel')
    next.disabled = n === 2 || (n === 1 && !validChoice())
    next.firstChild.textContent = T.text(n === 1 ? 'install' : n === 3 ? 'launch' : 'next')
    if (n === 2) void install()
    if (n === 3) summarize()
  }

  // ---------------------------------------------------------------------
  // Installation
  // ---------------------------------------------------------------------
  const fill = $('fill')
  const head = $('head')
  const percent = $('percent')
  const phaseText = $('phase')
  const log = $('log')

  function setBar(v) {
    const x = Math.max(0, Math.min(100, v))
    fill.style.width = x + '%'
    head.style.left = x + '%'
    percent.textContent = Math.floor(x) + '%'
    percent.setAttribute('aria-valuenow', String(Math.floor(x)))
  }

  /** Phases shown in the log; the optional ones only if chosen. */
  function chosenPhases() {
    const f = []
    if (state.initialExisting > 0) f.push({ id: 'removal', text: T.text('phaseRemoval') })
    f.push(
      { id: 'extraction', text: T.text('phaseExtraction') },
      { id: 'copy', text: T.text('phaseCopy') }
    )
    if ($('c-desktop').checked || $('c-start').checked) f.push({ id: 'shortcuts', text: T.text('phaseShortcuts') })
    if ($('c-file').checked) f.push({ id: 'associations', text: T.text('phaseAssociations') })
    f.push({ id: 'work', text: T.text('phaseWork') })
    return f
  }

  let phases = []
  let currentPhase = -1
  function startPhase(id) {
    const i = phases.findIndex((f) => f.id === id)
    if (i < 0 || i <= currentPhase) return
    for (let k = currentPhase; k < i; k++) if (k >= 0) closePhase(k)
    for (let k = Math.max(0, currentPhase + 1); k <= i; k++) {
      const line = document.createElement('div')
      line.dataset.phase = phases[k].id
      line.textContent = '… ' + phases[k].text
      log.appendChild(line)
      if (k < i) closePhase(k)
    }
    currentPhase = i
    phaseText.textContent = phases[i].text + '…'
  }
  function closePhase(k) {
    const line = log.querySelector('[data-phase="' + phases[k].id + '"]')
    if (!line || line.dataset.closed) return
    line.dataset.closed = '1'
    line.innerHTML = ''
    const ok = document.createElement('span')
    ok.className = 'ok'
    ok.textContent = '✓'
    line.append(ok, ' ' + phases[k].text)
  }

  /*
   * Share of the bar for each stretch, calibrated on measured times (on a
   * fast disk the extraction from the compressed archive takes about one and
   * a half times the copy into the program folder), so the bar moves at an
   * almost constant speed. The first stretch measures the removal of the
   * previous version, if any; the rest is for the final steps.
   */
  const SHARE_PREPARATION = 8
  const SHARE_EXTRACTION = 50
  const SHARE_COPY = 32

  async function install() {
    state.installing = true
    log.innerHTML = ''
    // Bytes of the version already installed: their disappearance measures
    // the removal of the previous version, which the engine does first.
    const existing = state.startup.noExistingInstall ? '' : windowsPath(state.startup.existingInstall)
    state.initialExisting = existing ? await folderSize(existing) : 0
    phases = chosenPhases()
    currentPhase = -1
    setBar(0)
    phaseText.textContent = 'Preparazione…'

    const progressFile = state.uiFolder + '\\progress.txt'
    try {
      await Neutralino.filesystem.remove(progressFile)
    } catch {
      // it was not there
    }

    const s = state.startup
    const args = ['"' + s.setup + '"', '/S']
    if (!$('c-desktop').checked) args.push('--no-desktop-shortcut')
    args.push('--starlight-start-menu=' + ($('c-start').checked ? '1' : '0'))
    args.push('--starlight-associate=' + ($('c-file').checked ? '1' : '0'))
    args.push('"--starlight-progress=' + progressFile + '"')
    // /D= goes last and without quotes, as NSIS requires.
    args.push('/D=' + state.programFolder)

    let exitCode = null
    const proc = await Neutralino.os.spawnProcess(args.join(' '))
    const onEvent = (ev) => {
      if (ev.detail.id === proc.id && ev.detail.action === 'exit') exitCode = Number(ev.detail.data)
    }
    await Neutralino.events.on('spawnedProcess', onEvent)

    const total = state.size || 1
    let tempFolder = ''
    let notes = {}
    let extractedDone = false
    let bar = 0

    const readNotes = async () => {
      try {
        const text = await readUtf16(progressFile)
        const fresh = {}
        for (const line of text.split(/\r?\n/)) {
          const i = line.indexOf('=')
          if (i <= 0) continue
          const k = line.slice(0, i)
          const v = line.slice(i + 1)
          if (k === 'temp') tempFolder = v
          if (k === 'phase') fresh[v] = true
        }
        notes = fresh
      } catch {
        // the file is not there yet
      }
    }

    // Follows the installer's work until it ends.
    for (;;) {
      const finished = exitCode !== null
      await readNotes()

      let v = 0
      let extracted = 0
      // The installer has started and, first of all, checks that StarLight
      // is not open (a few seconds, with nothing to measure).
      if (tempFolder && currentPhase < 0) phaseText.textContent = T.text('checkingOpen')
      if (tempFolder) extracted = extractedDone ? total : await folderSize(tempFolder + '\\7z-out')
      if (state.initialExisting > 0 && extracted === 0) {
        const remaining = await folderSize(existing)
        if (remaining < state.initialExisting) startPhase('removal')
        v = SHARE_PREPARATION * (1 - Math.min(1, remaining / state.initialExisting))
      }
      if (extracted > 0) {
        startPhase('extraction')
        if (extracted >= total * 0.995) extractedDone = true
        v = SHARE_PREPARATION + SHARE_EXTRACTION * Math.min(1, extracted / total)
        if (extractedDone) {
          // The copy starts only after extraction: before that the program
          // folder may still contain the previous version.
          startPhase('copy')
          const copied = await folderSize(state.programFolder)
          v = SHARE_PREPARATION + SHARE_EXTRACTION + SHARE_COPY * Math.min(1, copied / total)
        }
      }
      if (notes.shortcuts) {
        startPhase('copy')
        v = SHARE_PREPARATION + SHARE_EXTRACTION + SHARE_COPY
        startPhase('shortcuts')
        v += 3
      }
      if (notes.associations) {
        startPhase('associations')
        v += 3
      }
      bar = Math.max(bar, v)
      setBar(bar)
      if (test) test.note(Math.round(bar * 10) / 10 + '% ' + (phases[currentPhase] ? phases[currentPhase].id : 'preparation'))

      if (finished) break
      await wait(250)
    }
    await Neutralino.events.off('spawnedProcess', onEvent)

    if (exitCode !== 0 || !notes.done) {
      state.installing = false
      phaseText.textContent = ''
      const error = document.createElement('span')
      error.className = 'error'
      error.textContent =
        exitCode === 1
          ? T.text('installInterrupted')
          : T.text('installFailed', { code: exitCode })
      phaseText.append(error)
      const line = document.createElement('div')
      line.className = 'error'
      line.textContent = T.text('installNoChanges')
      log.appendChild(line)
      cancel.hidden = false
      cancel.textContent = T.text('close')
      return
    }

    if ($('c-desktop').checked || $('c-start').checked) startPhase('shortcuts')
    if ($('c-file').checked) startPhase('associations')
    startPhase('work')
    setBar(Math.max(bar, 97))
    const prefsOk = await prepareWorkFolder()
    if (!prefsOk) {
      const line = document.createElement('div')
      line.className = 'error'
      line.textContent = T.text('prefsNotUpdated')
      log.appendChild(line)
    }
    closePhase(currentPhase)
    setBar(100)
    phaseText.textContent = T.text('installed')
    state.installing = false
    state.installed = true
    await wait(prefsOk ? 700 : 2500)
    show(3)
  }

  /**
   * Creates the work folder with its subfolders and writes it into
   * StarLight's preferences (preferences.json, key settings.workFolder, the
   * same one read by src/renderer/src/settings.ts), merging it with what the
   * file already contains.
   */
  async function prepareWorkFolder() {
    const base = state.workFolder
    for (const sub of ['', ...(await subfolderNames(base))]) {
      const p = sub ? joinPath(base, sub) : base
      try {
        if (!(await exists(p))) await Neutralino.filesystem.createDirectory(p)
      } catch {
        // if it fails, StarLight will create it when needed
      }
    }

    const dataFolder = windowsPath(state.startup.data)
    const prefsFile = joinPath(dataFolder, 'preferences.json')
    let prefs = {}
    if (await exists(prefsFile)) {
      try {
        prefs = JSON.parse(await Neutralino.filesystem.readFile(prefsFile))
      } catch {
        // unreadable file: better not to touch it than to lose what it holds
        return false
      }
      if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return false
    }
    const settings = prefs.settings && typeof prefs.settings === 'object' ? prefs.settings : {}
    prefs.settings = Object.assign({}, settings, { workFolder: base })
    try {
      if (!(await exists(dataFolder))) await Neutralino.filesystem.createDirectory(dataFolder)
      await Neutralino.filesystem.writeFile(prefsFile, JSON.stringify(prefs, null, 2))
      return true
    } catch {
      return false
    }
  }

  function summarize() {
    const ul = $('summary')
    ul.innerHTML = ''
    const lines = [
      [T.text('summaryProgram'), state.programFolder],
      [T.text('summaryWork'), state.workFolder]
    ]
    if ($('c-desktop').checked) lines.push([T.text('desktopShortcut'), ''])
    if ($('c-start').checked) lines.push([T.text('startShortcut'), ''])
    if ($('c-file').checked) lines.push([T.text('fileTypes'), ''])
    for (const [t, c] of lines) {
      const li = document.createElement('li')
      li.append(t)
      if (c) {
        const code = document.createElement('code')
        code.textContent = c
        li.append(code)
      }
      ul.appendChild(li)
    }
  }

  async function quit() {
    await Neutralino.app.exit(0)
  }

  async function launchStarLight() {
    next.disabled = true
    next.firstChild.textContent = T.text('launching')
    const exe = joinPath(state.programFolder, state.startup.executable || 'StarLight.exe')
    try {
      // "start" detaches StarLight from this window, which closes right after.
      await Neutralino.os.execCommand('cmd /c start "" "' + exe + '"', { background: true, cwd: state.programFolder })
    } catch {
      // if the launch fails, StarLight is installed anyway
    }
    await wait(800)
    await quit()
  }

  // ---------------------------------------------------------------------
  // Buttons and closing
  // ---------------------------------------------------------------------
  next.addEventListener('click', () => {
    if (step === 3) {
      void launchStarLight()
      return
    }
    show(step + 1)
  })
  back.addEventListener('click', () => show(Math.max(0, step - 1)))
  cancel.addEventListener('click', () => {
    if (!state.installing) void quit()
  })
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !state.installing && $('license-panel').hidden) void quit()
    if (e.key === 'Escape' && !$('license-panel').hidden) $('license-panel').hidden = true
  })
  // Alt+F4 or closing from the system: ignored while the files are copied.
  Neutralino.events.on('windowClose', () => {
    if (!state.installing) void quit()
  })

  $('read-license').addEventListener('click', async () => {
    try {
      $('license-text').textContent = await Neutralino.filesystem.readFile(state.uiFolder + '\\page\\license.txt')
      $('license-panel').hidden = false
      $('close-license').focus()
    } catch {
      await Neutralino.os.open('https://www.gnu.org/licenses/gpl-3.0.html')
    }
  })
  $('close-license').addEventListener('click', () => {
    $('license-panel').hidden = true
  })

  // ---------------------------------------------------------------------
  // Automatic test, developers only: if the environment variable
  // STARLIGHT_INSTALLER_TEST names a folder, the window walks through the
  // steps by itself with the folders given in STARLIGHT_INSTALLER_PROGRAM
  // and STARLIGHT_INSTALLER_WORK, saves a picture of each step and a log of
  // the times in that folder, then closes. Normal users do not have the
  // variable and see none of this.
  // ---------------------------------------------------------------------
  let test = null
  async function automaticTest() {
    let folder = ''
    try {
      folder = await Neutralino.os.getEnv('STARLIGHT_INSTALLER_TEST')
    } catch {
      return
    }
    if (!folder) return
    const start = performance.now()
    const lines = []
    let shot = 0
    test = {
      note(t) {
        lines.push(((performance.now() - start) / 1000).toFixed(2) + ' s  ' + t)
      }
    }
    const snapshot = async (name) => {
      await wait(400)
      await Neutralino.window.snapshot(folder + '\\' + String(++shot).padStart(2, '0') + '-' + name + '.png')
    }
    const env = async (k) => {
      try {
        return await Neutralino.os.getEnv(k)
      } catch {
        return ''
      }
    }
    await wait(1200)
    await snapshot('intro')
    $('read-license').click()
    await wait(300)
    await snapshot('license')
    $('close-license').click()
    show(1)
    const program = await env('STARLIGHT_INSTALLER_PROGRAM')
    const work = await env('STARLIGHT_INSTALLER_WORK')
    if (program) state.programFolder = windowsPath(program)
    if (work) state.workFolder = windowsPath(work)
    if ((await env('STARLIGHT_INSTALLER_NO_START_MENU')) === '1') $('c-start').checked = false
    updateFolders()
    await wait(1500)
    await snapshot('folders')
    test.note('install')
    next.click()
    let last = 0
    while (step === 2) {
      await wait(200)
      if (performance.now() - last > 2500 && state.installing) {
        last = performance.now()
        await snapshot('installing')
      }
      if (!state.installing && !state.installed) break
    }
    await snapshot(state.installed ? 'done' : 'error')
    test.note(state.installed ? 'completed' : 'failed')
    await Neutralino.filesystem.writeFile(folder + '\\times.txt', lines.join('\r\n'))
    if ((await env('STARLIGHT_INSTALLER_LAUNCH')) === '1' && state.installed) next.click()
    else await quit()
  }

  Neutralino.events.on('ready', () => {
    prepare().then(
      () => automaticTest().catch((e) => console.error(e)),
      async (e) => {
        // Without the starting data nothing can be installed: the window
        // closes and the installer falls back to the classic pages.
        try {
          await Neutralino.filesystem.remove(state.uiFolder + '\\opened.txt')
        } catch {
          // nothing to remove
        }
        console.error(e)
        await Neutralino.app.exit(3)
      }
    )
  })
})()
