/*
 * StarLight uninstaller window.
 *
 * Runs inside Neutralinojs, started by the NSIS uninstaller (see
 * resources/installer/installer.nsh), which first writes the starting data
 * to "startup.txt": where the uninstaller is, the program folder, the data
 * folder and the version.
 *
 * The actual uninstallation is always done by the electron-builder engine:
 * this page relaunches the same uninstaller silently with the choice about
 * the data (/S --starlight-delete-data=0|1 _?=folder) and follows its work:
 *   - it reads the phases the uninstaller notes in "progress.txt"
 *     (associations, data, files);
 *   - it measures the bytes left in the program folder, comparing them with
 *     those that were there at the start.
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
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  /** Windows-style path, without a trailing backslash. */
  function windowsPath(p) {
    let q = String(p || '').replace(/\//g, '\\')
    if (q.length > 3) q = q.replace(/\\+$/, '')
    return q
  }
  function joinPath(base, name) {
    return windowsPath(base).replace(/\\$/, '') + '\\' + name
  }

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

  /** Bytes taken by the files of a folder (0 if it no longer exists). */
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
        // file just deleted: it no longer counts
      }
    }
    return total
  }

  // ---------------------------------------------------------------------
  // Starting data
  // ---------------------------------------------------------------------
  const state = {
    startup: {},
    uiFolder: '',
    programFolder: '',
    dataFolder: '',
    running: false,
    finished: false
  }

  const panels = [...document.querySelectorAll('[data-step]')]
  const stepItems = [...document.querySelectorAll('#indicator li')]
  const next = $('next')
  const cancel = $('cancel')
  const dataBox = $('c-data')
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
    // Signal for the uninstaller: the interface really opened.
    await Neutralino.filesystem.writeFile(state.uiFolder + '\\opened.txt', '1')

    const s = state.startup
    // Windows display language, as read by the uninstaller.
    if (s.language) T.setLanguage(s.language)
    state.programFolder = windowsPath(s.programFolder)
    state.dataFolder = windowsPath(s.data)
    $('version').textContent = T.text('version', { version: s.version || '' }) + (s.codename ? ' · ' + s.codename : '')
    $('program-path').textContent = state.programFolder
    $('program-path').title = state.programFolder
    $('data-path').textContent = state.dataFolder

    show(0)
    try {
      await Neutralino.window.setDraggableRegion('brand')
      await Neutralino.window.setDraggableRegion('indicator')
    } catch {
      // without dragging the window is still usable
    }
  }

  dataBox.addEventListener('change', () => {
    $('data-warning').hidden = !dataBox.checked
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
    cancel.hidden = n >= 1
    next.disabled = n === 1
    cancel.textContent = T.text('cancel')
    next.firstChild.textContent = T.text(n === 2 ? 'close' : 'uninstall')
    if (n === 1) void uninstall()
    if (n === 2) summarize()
  }

  // ---------------------------------------------------------------------
  // Uninstallation
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

  /** Phases shown in the log, in the order the engine runs them. */
  function chosenPhases() {
    const f = [{ id: 'associations', text: T.text('phaseUnassociate') }]
    if (dataBox.checked) f.push({ id: 'data', text: T.text('phaseData') })
    f.push(
      { id: 'files', text: T.text('phaseFiles') },
      { id: 'shortcuts', text: T.text('phaseUnshortcuts') }
    )
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
   * Share of the bar for each stretch: removing the program files is almost
   * all the work; the rest is split between the initial check, the
   * associations, the data and the final steps.
   */
  const SHARE_START = 10
  const SHARE_FILES = 85

  async function uninstall() {
    state.running = true
    log.innerHTML = ''
    phases = chosenPhases()
    currentPhase = -1
    setBar(0)
    phaseText.textContent = T.text('preparing')
    const initial = (await folderSize(state.programFolder)) || 1

    const progressFile = state.uiFolder + '\\progress.txt'
    try {
      await Neutralino.filesystem.remove(progressFile)
    } catch {
      // it was not there
    }

    const s = state.startup
    const args = ['"' + s.uninstaller + '"', '/S']
    args.push('--starlight-delete-data=' + (dataBox.checked ? '1' : '0'))
    args.push('"--starlight-progress=' + progressFile + '"')
    if (s.mode) args.push(s.mode)
    // _?= goes last and without quotes, as NSIS requires: the uninstaller
    // works from where it is, without copying itself elsewhere.
    args.push('_?=' + state.programFolder)

    let exitCode = null
    const proc = await Neutralino.os.spawnProcess(args.join(' '))
    const onEvent = (ev) => {
      if (ev.detail.id === proc.id && ev.detail.action === 'exit') exitCode = Number(ev.detail.data)
    }
    await Neutralino.events.on('spawnedProcess', onEvent)

    let notes = {}
    const readNotes = async () => {
      try {
        const fresh = {}
        for (const line of (await readUtf16(progressFile)).split(/\r?\n/)) {
          if (line.startsWith('phase=')) fresh[line.slice(6)] = true
        }
        notes = fresh
      } catch {
        // the file is not there yet
      }
    }

    let bar = 0
    let started = false
    for (;;) {
      const finished = exitCode !== null
      await readNotes()

      let v = 0
      // First of all the engine checks that StarLight is not open (a few
      // seconds, with nothing to measure).
      if (!started && !finished) {
        phaseText.textContent = T.text('checkingOpen')
        started = true
      }
      if (notes.associations) {
        startPhase('associations')
        v = SHARE_START / 2
      }
      if (notes.data) {
        startPhase('data')
        v = SHARE_START * 0.8
      }
      if (notes.files) {
        startPhase('files')
        const remaining = await folderSize(state.programFolder)
        v = SHARE_START + SHARE_FILES * (1 - Math.min(1, remaining / initial))
        if (remaining === 0) startPhase('shortcuts')
      }
      bar = Math.max(bar, v)
      setBar(bar)
      if (test) test.note(Math.round(bar * 10) / 10 + '% ' + (phases[currentPhase] ? phases[currentPhase].id : 'preparation'))

      if (finished) break
      await wait(250)
    }
    await Neutralino.events.off('spawnedProcess', onEvent)

    const programLeft = await exists(joinPath(state.programFolder, s.executable || 'StarLight.exe'))
    state.running = false
    if (exitCode !== 0 || programLeft) {
      phaseText.textContent = ''
      const error = document.createElement('span')
      error.className = 'error'
      error.textContent =
        exitCode === 1
          ? T.text('uninstallInterrupted')
          : T.text('uninstallFailed', { code: exitCode })
      phaseText.append(error)
      const line = document.createElement('div')
      line.className = 'error'
      line.textContent = T.text('uninstallRetry')
      log.appendChild(line)
      next.disabled = false
      next.firstChild.textContent = T.text('close')
      step = 2
      return
    }

    startPhase('shortcuts')
    closePhase(currentPhase)
    setBar(100)
    phaseText.textContent = T.text('uninstalled')
    state.finished = true
    await wait(700)
    show(2)
  }

  function summarize() {
    const ul = $('summary')
    ul.innerHTML = ''
    const lines = [[T.text('summaryRemoved'), state.programFolder]]
    if (dataBox.checked) lines.push([T.text('summaryDataDeleted'), state.dataFolder])
    else lines.push([T.text('summaryDataKept'), state.dataFolder])
    lines.push([T.text('summaryUnlinked'), ''])
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
    await Neutralino.app.exit(state.finished ? 0 : 1)
  }

  // ---------------------------------------------------------------------
  // Buttons and closing
  // ---------------------------------------------------------------------
  next.addEventListener('click', () => {
    if (step === 2) void quit()
    else show(1)
  })
  cancel.addEventListener('click', () => {
    if (!state.running) void quit()
  })
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !state.running) void quit()
  })
  // Alt+F4 or closing from the system: ignored while the files are removed.
  Neutralino.events.on('windowClose', () => {
    if (!state.running) void quit()
  })

  // ---------------------------------------------------------------------
  // Automatic test, developers only: if the environment variable
  // STARLIGHT_UNINSTALLER_TEST names a folder, the window walks through the
  // steps by itself (deleting the data if STARLIGHT_UNINSTALLER_DATA is 1),
  // saves a picture of each step and a log of the times in that folder, then
  // closes. Normal users do not have the variable and see none of this.
  // ---------------------------------------------------------------------
  let test = null
  async function automaticTest() {
    const env = async (k) => {
      try {
        return await Neutralino.os.getEnv(k)
      } catch {
        return ''
      }
    }
    const folder = await env('STARLIGHT_UNINSTALLER_TEST')
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
    await wait(1200)
    if ((await env('STARLIGHT_UNINSTALLER_DATA')) === '1') {
      dataBox.checked = true
      dataBox.dispatchEvent(new Event('change'))
    }
    await snapshot('confirm')
    test.note('uninstall')
    next.click()
    let last = 0
    while (step === 1) {
      await wait(200)
      if (performance.now() - last > 1500 && state.running) {
        last = performance.now()
        await snapshot('uninstalling')
      }
      if (!state.running && !state.finished) break
    }
    await snapshot(state.finished ? 'done' : 'error')
    test.note(state.finished ? 'completed' : 'failed')
    await Neutralino.filesystem.writeFile(folder + '\\times.txt', lines.join('\r\n'))
    await quit()
  }

  Neutralino.events.on('ready', () => {
    prepare().then(
      () => automaticTest().catch((e) => console.error(e)),
      async (e) => {
        // Without the starting data nothing can be uninstalled from here: the
        // window closes and the uninstaller falls back to the classic pages.
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
