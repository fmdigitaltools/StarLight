/*
 * Texts of the installer and uninstaller windows, in every language they
 * speak. The language is the Windows one when it is here, English otherwise:
 * the same rule as StarLight. The NSIS installer passes the Windows display
 * language in startup.txt (`language=`); until it has been read, the
 * language of WebView2 is used, which follows Windows too.
 *
 * Static texts are marked in the pages with data-text="key" (data-alt for
 * the alt attribute, data-title for the window title); the scripts use
 * installerTexts.text(key, params), where {name} placeholders are filled
 * from params.
 *
 * The folder names (folderProjects, folderExports, folderSessions) must be
 * the same as `common.folders` in StarLight's language files: the
 * `languages` test checks it.
 */
;(function () {
  'use strict'

  const TEXTS = {
    it: {
      installTitle: 'Installazione di StarLight',
      uninstallTitle: 'Disinstallazione di StarLight',
      logoAlt: 'Logo di StarLight',
      slogan: 'Dal cielo notturno all’immagine finita.',
      version: 'Versione {version}',
      // Installer steps
      stepIntro: 'Introduzione',
      stepFolders: 'Cartelle',
      stepInstall: 'Installazione',
      stepDone: 'Completamento',
      intro:
        'StarLight è un programma per l’elaborazione delle immagini astronomiche, pensato in primo luogo per le riprese impilate e in grado di assistere anche nel miglioramento delle singole immagini. Accetta file FITS e XISF, immagini TIFF e PNG e i formati RAW delle fotocamere. Le funzioni principali sono l’impilamento delle riprese di una sessione, la riduzione del rumore, la rimozione del fondo cielo, l’identificazione degli oggetti inquadrati e l’esportazione per la stampa e per i social.',
      spaceIntro: 'L’installazione richiede circa {size} di spazio su disco.',
      licenseOwn: 'StarLight — licenza GNU GPL versione 3 o successiva',
      licenseTitle: 'Componenti e dati di terze parti:',
      licenseChromium: 'Chromium — BSD-3-Clause e altre licenze libere',
      licenseUpdaterLibs: 'Librerie di supporto di electron-updater — MIT, ISC, BlueOak-1.0.0, Python-2.0',
      licenseOpenNgc: 'Catalogo OpenNGC, Mattia Verga — CC BY-SA 4.0',
      licenseGaia: 'Catalogo Gaia DR3, ESA/Gaia/DPAC — uso libero con citazione',
      readLicense: 'Leggi la licenza',
      foldersTitle: 'Scelta delle cartelle',
      programFolder: 'Cartella del programma',
      workFolder: 'Cartella di lavoro',
      browse: 'Sfoglia…',
      workFolderNote:
        'Contiene i progetti, le esportazioni e le sessioni dal vivo. Modificabile in seguito dalle Impostazioni.',
      desktopShortcut: 'Collegamento sul desktop',
      startShortcut: 'Collegamento nel menu Start',
      fileTypes: 'Apertura dei file .fit, .fits, .fz, .xisf e .slight con StarLight',
      spaceNeeded: 'Spazio richiesto {size}',
      spaceFree: 'Spazio richiesto {size} · disponibile su {drive} {free}',
      spaceChecking: 'Spazio richiesto {size} · disponibile su {drive} …',
      spaceShort: ' · non basta, scegli un’altra unità.',
      installing: 'Installazione in corso',
      installingText: 'Copia dei file di StarLight nella cartella del programma.',
      preparing: 'Preparazione…',
      installed: 'Installazione completata',
      summaryIntro: 'Riepilogo dell’installazione:',
      firstRun: 'Al primo avvio una guida mostra i comandi principali.',
      cancel: 'Annulla',
      back: 'Indietro',
      next: 'Avanti',
      install: 'Installa',
      launch: 'Avvia StarLight',
      launching: 'Avvio di StarLight…',
      close: 'Chiudi',
      phaseRemoval: 'Rimozione della versione precedente',
      phaseExtraction: 'Estrazione dei file del programma',
      phaseCopy: 'Copia dei file nella cartella del programma',
      phaseShortcuts: 'Creazione dei collegamenti',
      phaseAssociations: 'Associazione dei tipi di file',
      phaseWork: 'Preparazione della cartella di lavoro',
      checkingOpen: 'Controllo che StarLight non sia aperto…',
      installInterrupted: 'Installazione interrotta.',
      installFailed: 'L’installazione non è riuscita (codice {code}).',
      installNoChanges: 'Nessuna modifica alle preferenze. Puoi riprovare avviando di nuovo l’installazione.',
      prefsNotUpdated: 'Preferenze non aggiornate. Puoi scegliere la cartella di lavoro dalle Impostazioni.',
      summaryProgram: 'Programma installato in ',
      summaryWork: 'Progetti, esportazioni e sessioni dal vivo in ',
      folderProjects: 'Progetti',
      folderExports: 'Esportazioni',
      folderSessions: 'Sessioni dal vivo',
      // Uninstaller
      stepConfirm: 'Conferma',
      stepUninstall: 'Disinstallazione',
      uninstallText:
        'StarLight verrà rimosso da questo computer insieme ai collegamenti sul desktop e nel menu Start, e i file non si apriranno più con il programma.',
      deleteData: 'Elimina anche i dati del programma',
      dataNoteBefore:
        'Impostazioni, libreria di calibrazione, cataloghi e plugin installati, copie di recupero del lavoro e registro degli errori, nella cartella ',
      dataNoteAfter: '. Se li conservi, li ritrovi reinstallando il programma.',
      dataWarning: 'I dati eliminati non si possono recuperare.',
      untouched: 'I progetti e le immagini che hai salvato non vengono toccati. Se StarLight è aperto, verrà chiuso.',
      uninstalling: 'Disinstallazione in corso',
      uninstallingText: 'Rimozione di StarLight da questo computer.',
      uninstalled: 'Disinstallazione completata',
      uninstallSummaryIntro: 'Riepilogo della disinstallazione:',
      thanks: 'Grazie per aver usato StarLight.',
      uninstall: 'Disinstalla',
      phaseUnassociate: 'Rimozione dell’apertura dei file con StarLight',
      phaseData: 'Eliminazione dei dati del programma',
      phaseFiles: 'Rimozione dei file del programma',
      phaseUnshortcuts: 'Rimozione dei collegamenti e della voce nelle app installate',
      uninstallInterrupted: 'Disinstallazione interrotta.',
      uninstallFailed: 'La disinstallazione non è riuscita (codice {code}).',
      uninstallRetry:
        'Chiudi StarLight, se è aperto, e avvia di nuovo la disinstallazione dalle app installate di Windows.',
      summaryRemoved: 'Programma rimosso da ',
      summaryDataDeleted: 'Dati del programma eliminati da ',
      summaryDataKept: 'Dati del programma conservati in ',
      summaryUnlinked: 'Collegamenti e apertura dei file con StarLight rimossi'
    },
    en: {
      installTitle: 'StarLight setup',
      uninstallTitle: 'Uninstall StarLight',
      logoAlt: 'StarLight logo',
      slogan: 'From the night sky to the finished image.',
      version: 'Version {version}',
      stepIntro: 'Introduction',
      stepFolders: 'Folders',
      stepInstall: 'Installation',
      stepDone: 'Finish',
      intro:
        'StarLight is a program for processing astronomical images, designed first of all for stacked images and also able to help improve single frames. It accepts FITS and XISF files, TIFF and PNG images and camera RAW formats. Its main functions are stacking the frames of a session, noise reduction, sky background removal, identification of the objects in the field and export for printing and social media.',
      spaceIntro: 'The installation needs about {size} of disk space.',
      licenseOwn: 'StarLight — GNU GPL license version 3 or later',
      licenseTitle: 'Third-party components and data:',
      licenseChromium: 'Chromium — BSD-3-Clause and other free licenses',
      licenseUpdaterLibs: 'electron-updater support libraries — MIT, ISC, BlueOak-1.0.0, Python-2.0',
      licenseOpenNgc: 'OpenNGC catalog, Mattia Verga — CC BY-SA 4.0',
      licenseGaia: 'Gaia DR3 catalog, ESA/Gaia/DPAC — free use with citation',
      readLicense: 'Read the license',
      foldersTitle: 'Choose the folders',
      programFolder: 'Program folder',
      workFolder: 'Work folder',
      browse: 'Browse…',
      workFolderNote: 'Holds projects, exports and live sessions. It can be changed later in Settings.',
      desktopShortcut: 'Desktop shortcut',
      startShortcut: 'Start menu shortcut',
      fileTypes: 'Open .fit, .fits, .fz, .xisf and .slight files with StarLight',
      spaceNeeded: 'Space needed {size}',
      spaceFree: 'Space needed {size} · available on {drive} {free}',
      spaceChecking: 'Space needed {size} · available on {drive} …',
      spaceShort: ' · not enough, choose another drive.',
      installing: 'Installing',
      installingText: 'Copying the StarLight files into the program folder.',
      preparing: 'Preparing…',
      installed: 'Installation complete',
      summaryIntro: 'Installation summary:',
      firstRun: 'On first launch a quick tour shows the main commands.',
      cancel: 'Cancel',
      back: 'Back',
      next: 'Next',
      install: 'Install',
      launch: 'Launch StarLight',
      launching: 'Launching StarLight…',
      close: 'Close',
      phaseRemoval: 'Removing the previous version',
      phaseExtraction: 'Extracting the program files',
      phaseCopy: 'Copying the files into the program folder',
      phaseShortcuts: 'Creating the shortcuts',
      phaseAssociations: 'Associating the file types',
      phaseWork: 'Preparing the work folder',
      checkingOpen: 'Checking that StarLight is not open…',
      installInterrupted: 'Installation interrupted.',
      installFailed: 'The installation failed (code {code}).',
      installNoChanges: 'No changes to the preferences. You can try again by starting the installation again.',
      prefsNotUpdated: 'Preferences not updated. You can choose the work folder in Settings.',
      summaryProgram: 'Program installed in ',
      summaryWork: 'Projects, exports and live sessions in ',
      folderProjects: 'Projects',
      folderExports: 'Exports',
      folderSessions: 'Live sessions',
      stepConfirm: 'Confirm',
      stepUninstall: 'Uninstall',
      uninstallText:
        'StarLight will be removed from this computer together with its desktop and Start menu shortcuts, and files will no longer open with it.',
      deleteData: 'Also delete the program data',
      dataNoteBefore:
        'Settings, calibration library, installed catalogs and plugins, recovery copies of your work and the error log, in the folder ',
      dataNoteAfter: '. If you keep them, you will find them again when you reinstall the program.',
      dataWarning: 'Deleted data cannot be recovered.',
      untouched: 'The projects and images you saved are not touched. If StarLight is open, it will be closed.',
      uninstalling: 'Uninstalling',
      uninstallingText: 'Removing StarLight from this computer.',
      uninstalled: 'Uninstall complete',
      uninstallSummaryIntro: 'Uninstall summary:',
      thanks: 'Thank you for using StarLight.',
      uninstall: 'Uninstall',
      phaseUnassociate: 'Removing the StarLight file associations',
      phaseData: 'Deleting the program data',
      phaseFiles: 'Removing the program files',
      phaseUnshortcuts: 'Removing the shortcuts and the entry in installed apps',
      uninstallInterrupted: 'Uninstall interrupted.',
      uninstallFailed: 'The uninstall failed (code {code}).',
      uninstallRetry: 'Close StarLight, if it is open, and start the uninstall again from the installed apps in Windows.',
      summaryRemoved: 'Program removed from ',
      summaryDataDeleted: 'Program data deleted from ',
      summaryDataKept: 'Program data kept in ',
      summaryUnlinked: 'Shortcuts and StarLight file associations removed'
    }
  }

  const LOCALES = { it: 'it-IT', en: 'en-US' }

  function pick(locale) {
    const code = String(locale || '').toLowerCase().split(/[-_]/)[0]
    return Object.prototype.hasOwnProperty.call(TEXTS, code) ? code : 'en'
  }

  let language = pick(typeof navigator !== 'undefined' ? navigator.language : '')

  function text(key, params) {
    let s = TEXTS[language][key]
    if (s === undefined) s = TEXTS.en[key]
    if (s === undefined) return key
    return s.replace(/\{(\w+)\}/g, (whole, name) => (params && name in params ? String(params[name]) : whole))
  }

  /** Fills the marked elements of the page with the texts of the current language. */
  function apply() {
    document.documentElement.lang = language
    for (const el of document.querySelectorAll('[data-text]')) el.textContent = text(el.dataset.text)
    for (const el of document.querySelectorAll('[data-alt]')) el.alt = text(el.dataset.alt)
    const title = document.querySelector('[data-title]')
    if (title) {
      document.title = text(title.dataset.title)
      if (typeof Neutralino !== 'undefined') Neutralino.window.setTitle(document.title).catch(() => {})
    }
  }

  /** A whole number in the format of the current language. */
  function number(value, options) {
    return value.toLocaleString(LOCALES[language], options)
  }

  // Exposed for the scripts of the two windows and for the `languages` test.
  globalThis.installerTexts = {
    TEXTS,
    text,
    apply,
    number,
    language: () => language,
    setLanguage(locale) {
      const next = pick(locale)
      if (next === language) return
      language = next
      apply()
    }
  }
})()
