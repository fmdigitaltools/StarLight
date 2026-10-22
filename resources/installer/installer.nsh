# StarLight installation on Windows: additions to the electron-builder NSIS template.
#
# The engine stays electron-builder's, because the automatic update
# (electron-updater) reinstalls by launching this same program with
# "--updated /S", that is without windows. Only the face changes here:
#
# - Started normally (not silent), the installer extracts a small web
#   interface (Neutralinojs, which uses the WebView2 already present in
#   Windows) into a temporary folder and shows it instead of the NSIS pages.
#   The interface asks for folders and options; then it relaunches this same
#   file silently with the choices made (see resources/installer/ui/program.js)
#   and follows its progress.
#   If the interface cannot open (for example WebView2 is missing), the
#   classic NSIS pages are used instead.
#
# - Started silently (/S, updates included) it does what it always did, plus
#   two things: it honours the choices passed by the interface (Start menu,
#   file types) and remembers whether .fit/.fits/.fz/.xisf/.slight files open
#   with StarLight, so an update does not lose the choice.
#
# Parameters recognised in silent mode, all optional:
#   --no-desktop-shortcut        no desktop shortcut (electron-builder's)
#   --starlight-start-menu=0     no Start menu shortcut
#   --starlight-associate=1|0    open (or not) .fit, .fits, .fz, .xisf and .slight with StarLight
#   --starlight-progress=FILE    file where the phases are noted, read by the interface
#   /D=FOLDER                    program folder (always last)
#
# Uninstallation follows the same scheme: started normally it shows its own
# window (resources/installer/ui/uninstall.html, with the configuration
# neutralino-uninstall.config.json), which relaunches the uninstaller
# silently; if the window does not open the classic pages remain, with the
# "Dati del programma" page. Silent mode parameters:
#   --starlight-delete-data=1    also deletes %APPDATA%\StarLight and the update cache
#   --starlight-progress=FILE    as above (phases: associations, data, files)
#   _?=FOLDER                    program folder (always last, NSIS's own)

!include LogicLib.nsh
!include FileFunc.nsh

# Registry classes of the file types. The "StarLight.previous" value keeps
# the association that existed before, to restore when StarLight is removed.
!define STARLIGHT_CLASS_FITS "StarLight.FITS"
!define STARLIGHT_CLASS_PROJECT "StarLight.Project"
!define STARLIGHT_CLASS_XISF "StarLight.XISF"

# Progress file read by the interface, both in installation and in
# uninstallation (parameter --starlight-progress=FILE).
Var starlightProgress

# Appends a line to the progress file read by the interface (UTF-16,
# because paths can contain accented letters).
!macro starlightNote TEXT
  ${If} $starlightProgress != ""
    ClearErrors
    FileOpen $R8 "$starlightProgress" a
    ${IfNot} ${Errors}
      FileSeek $R8 0 END
      FileWriteUTF16LE $R8 "${TEXT}$\r$\n"
      FileClose $R8
    ${EndIf}
  ${EndIf}
!macroend

# Version codename, read from src/shared/version.ts at build time, shown by
# both interfaces.
!searchparse /noerrors /file "${PROJECT_DIR}\src\shared\version.ts" "export const APP_CODENAME = '" STARLIGHT_CODENAME "'"
!ifndef STARLIGHT_CODENAME
  !define STARLIGHT_CODENAME ""
!endif

# Windows display language as a locale name ("it-IT", "en-US"…), passed to
# the interface in startup.txt and used for the few texts of this file:
# Italian when Windows is in Italian, English otherwise, the same rule as
# StarLight (the interface texts are in resources/installer/ui/texts.js).
Var starlightLanguage
!macro starlightReadLanguage
  Push $0
  Push $1
  System::Call 'kernel32::GetUserDefaultUILanguage() i .r0'
  System::Call 'kernel32::LCIDToLocaleName(i r0, w .r1, i 85, i 0) i'
  StrCpy $starlightLanguage $1
  Pop $1
  Pop $0
!macroend

# Sets VAR to the Italian or the English text, by the Windows language.
!macro starlightText VAR IT EN
  StrCpy ${VAR} "${EN}"
  Push $0
  StrCpy $0 $starlightLanguage 2
  ${If} $0 == "it"
    Pop $0
    StrCpy ${VAR} "${IT}"
  ${Else}
    Pop $0
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
  Var starlightAssociate
  Var starlightStartMenu

  # Shows the web interface and waits for it to close. If the interface
  # really opened, the installer quits without showing anything else;
  # otherwise it returns and the classic pages follow.
  Function starlightInterface
    # Only one installer window at a time.
    System::Call 'kernel32::CreateMutexW(p 0, i 0, w "StarLight-installer-interface") p .r1 ?e'
    Pop $0
    ${If} $0 == 183
      Quit
    ${EndIf}

    InitPluginsDir
    !insertmacro starlightReadLanguage
    StrCpy $R0 "$PLUGINSDIR\interface"
    SetOutPath "$R0"
    File "/oname=starlight-installer.exe" "${BUILD_RESOURCES_DIR}\installer\neutralino\neutralino-win_x64.exe"
    File "${BUILD_RESOURCES_DIR}\installer\neutralino\LICENSE-neutralinojs.txt"
    File "${BUILD_RESOURCES_DIR}\installer\neutralino.config.json"
    SetOutPath "$R0\page"
    File /r "${BUILD_RESOURCES_DIR}\installer\ui\*.*"
    # Logo shown in the page (the same as the app's) and window icon.
    File "/oname=logo.svg" "${BUILD_RESOURCES_DIR}\icon.svg"
    File "/oname=logo.png" "${BUILD_RESOURCES_DIR}\icon-256.png"
    !if /FileExists "${PROJECT_DIR}\LICENSE"
      File "/oname=license.txt" "${PROJECT_DIR}\LICENSE"
    !endif

    # Proposed folder: the one of the existing installation, if any,
    # otherwise the user's programs folder (no administrator rights, as for
    # updates).
    ReadRegStr $R1 HKCU "Software\${APP_GUID}" InstallLocation
    ${If} $R1 == ""
      StrCpy $R1 "$LOCALAPPDATA\Programs\${APP_FILENAME}"
    ${EndIf}

    # Starting data for the interface, one entry per line.
    FileOpen $R2 "$R0\startup.txt" w
    FileWriteUTF16LE /BOM $R2 "setup=$EXEPATH$\r$\n"
    FileWriteUTF16LE $R2 "programFolder=$R1$\r$\n"
    FileWriteUTF16LE $R2 "existingInstall=$R1$\r$\n"
    FileWriteUTF16LE $R2 "documents=$DOCUMENTS$\r$\n"
    FileWriteUTF16LE $R2 "data=$APPDATA\${APP_FILENAME}$\r$\n"
    FileWriteUTF16LE $R2 "executable=${PRODUCT_FILENAME}.exe$\r$\n"
    FileWriteUTF16LE $R2 "name=${PRODUCT_NAME}$\r$\n"
    FileWriteUTF16LE $R2 "language=$starlightLanguage$\r$\n"
    FileWriteUTF16LE $R2 "version=${VERSION}$\r$\n"
    FileWriteUTF16LE $R2 "codename=${STARLIGHT_CODENAME}$\r$\n"
    # Size of the program files once extracted, known at build time: it is
    # the basis of the progress bar.
    !ifdef APP_64_UNPACKED_SIZE
      FileWriteUTF16LE $R2 "sizeKB=${APP_64_UNPACKED_SIZE}$\r$\n"
    !else ifdef ESTIMATED_SIZE
      FileWriteUTF16LE $R2 "sizeKB=${ESTIMATED_SIZE}$\r$\n"
    !endif
    FileWriteUTF16LE $R2 "desktop=$DESKTOP$\r$\n"
    FileWriteUTF16LE $R2 "startMenu=$SMPROGRAMS$\r$\n"
    FileWriteUTF16LE $R2 "shortcut=${SHORTCUT_NAME}$\r$\n"
    FileClose $R2
    # The "existingInstall" line counts only if the key really existed.
    ReadRegStr $R1 HKCU "Software\${APP_GUID}" InstallLocation
    ${If} $R1 == ""
      FileOpen $R2 "$R0\startup.txt" a
      FileSeek $R2 0 END
      FileWriteUTF16LE $R2 "noExistingInstall=1$\r$\n"
      FileClose $R2
    ${EndIf}

    # The WebView2 engine data stays in the temporary folder, which Windows
    # and NSIS clean up, instead of %APPDATA%.
    System::Call 'kernel32::SetEnvironmentVariableW(w "WEBVIEW2_USER_DATA_FOLDER", w "$PLUGINSDIR\webview") i'

    # The interface finds its files in the current working folder.
    SetOutPath "$R0"
    ClearErrors
    ExecWait '"$R0\starlight-installer.exe" --load-dir-res --path=.' $R3

    # The interface writes "opened.txt" as soon as it appears: if it is
    # missing, it did not start and the classic pages follow.
    ${IfNot} ${FileExists} "$R0\opened.txt"
      SetOutPath "$TEMP"
      Return
    ${EndIf}

    # Waits for the WebView2 processes to release the files, so the
    # temporary folder is deleted entirely on exit.
    SetOutPath "$TEMP"
    StrCpy $R4 0
    ${Do}
      ClearErrors
      RMDir /r "$PLUGINSDIR\webview"
      ${IfNot} ${FileExists} "$PLUGINSDIR\webview\*.*"
        ${Break}
      ${EndIf}
      IntOp $R4 $R4 + 1
      ${If} $R4 > 20
        ${Break}
      ${EndIf}
      Sleep 250
    ${Loop}
    SetErrorLevel $R3
    Quit
  FunctionEnd

  !macro preInit
    # Before everything else: right after, the template creates a "single
    # instance" lock that would prevent the interface from relaunching this file.
    ${IfNot} ${Silent}
      Call starlightInterface
    ${EndIf}
  !macroend

  !macro customInit
    ${If} ${Silent}
      # The file type choice must be read now: the uninstallation of the
      # previous version, which comes later, deletes the registry key.
      ReadRegStr $starlightAssociate SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" StarLightAssociateFiles
      StrCpy $starlightStartMenu ""

      ${StdUtils.GetParameter} $R0 "starlight-associate" ""
      ${If} $R0 != ""
        StrCpy $starlightAssociate $R0
      ${EndIf}
      ${StdUtils.GetParameter} $R0 "starlight-start-menu" ""
      StrCpy $starlightStartMenu $R0
      ${StdUtils.GetParameter} $starlightProgress "starlight-progress" ""

      ${If} $starlightProgress != ""
        # The interface measures the bytes extracted here before the final copy.
        InitPluginsDir
        !insertmacro starlightNote "temp=$PLUGINSDIR"
      ${EndIf}
    ${EndIf}
  !macroend

  !macro starlightAssociateExtension EXT CLASS
    ReadRegStr $R1 SHELL_CONTEXT "Software\Classes\.${EXT}" ""
    ${If} $R1 != ""
    ${AndIf} $R1 != "${CLASS}"
      WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}" "StarLight.previous" "$R1"
    ${EndIf}
    WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}" "" "${CLASS}"
    WriteRegNone SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${CLASS}"
  !macroend

  !macro starlightRegisterClass CLASS DESCRIPTION
    WriteRegStr SHELL_CONTEXT "Software\Classes\${CLASS}" "" "${DESCRIPTION}"
    WriteRegStr SHELL_CONTEXT "Software\Classes\${CLASS}\DefaultIcon" "" "$appExe,0"
    WriteRegStr SHELL_CONTEXT "Software\Classes\${CLASS}\shell" "" "open"
    WriteRegStr SHELL_CONTEXT "Software\Classes\${CLASS}\shell\open" "" "Apri con ${PRODUCT_NAME}"
    WriteRegStr SHELL_CONTEXT "Software\Classes\${CLASS}\shell\open\command" "" '"$appExe" "%1"'
  !macroend

  !macro customInstall
    # The shortcuts have already been created by the template: the Start
    # menu one is removed if not chosen.
    ${If} $starlightStartMenu == "0"
      WinShell::UninstShortcut "$newStartMenuLink"
      Delete "$newStartMenuLink"
    ${EndIf}
    !insertmacro starlightNote "phase=shortcuts"

    ${If} $starlightAssociate == "1"
      # File type names shown by Explorer, in the Windows language.
      !insertmacro starlightReadLanguage
      !insertmacro starlightText $R4 "Immagine FITS" "FITS image"
      !insertmacro starlightText $R5 "Immagine XISF" "XISF image"
      !insertmacro starlightText $R6 "Progetto di ${PRODUCT_NAME}" "${PRODUCT_NAME} project"
      !insertmacro starlightRegisterClass "${STARLIGHT_CLASS_FITS}" "$R4"
      !insertmacro starlightRegisterClass "${STARLIGHT_CLASS_XISF}" "$R5"
      !insertmacro starlightRegisterClass "${STARLIGHT_CLASS_PROJECT}" "$R6"
      !insertmacro starlightAssociateExtension "fit" "${STARLIGHT_CLASS_FITS}"
      !insertmacro starlightAssociateExtension "fits" "${STARLIGHT_CLASS_FITS}"
      # Compressed FITS (.fz) and XISF. TIFF and PNG no: they are common
      # formats and the program chosen by the user stays.
      !insertmacro starlightAssociateExtension "fz" "${STARLIGHT_CLASS_FITS}"
      !insertmacro starlightAssociateExtension "xisf" "${STARLIGHT_CLASS_XISF}"
      !insertmacro starlightAssociateExtension "slight" "${STARLIGHT_CLASS_PROJECT}"
      System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
      !insertmacro starlightNote "phase=associations"
    ${EndIf}
    ${If} $starlightAssociate != ""
      WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" StarLightAssociateFiles "$starlightAssociate"
    ${EndIf}
    !insertmacro starlightNote "phase=done"
  !macroend
!endif

!ifdef BUILD_UNINSTALLER
  # This file is read before MUI2 (included by the template later, with
  # double-inclusion protection): it is needed here for MUI_HEADER_TEXT.
  !include MUI2.nsh
  !include nsDialogs.nsh

  # "1" if deleting the program data too was requested: with the checkbox
  # of the graphical window (which relaunches the uninstaller with
  # --starlight-delete-data=1) or with the one of the classic page. In
  # updates the parameter is absent and the data stays.
  Var starlightDeleteData
  Var starlightDataBox
  # Installation mode parameter to pass again to the relaunched
  # uninstaller (/currentuser or /allusers), as in the Windows installed
  # apps entry.
  Var starlightMode
  # Uninstaller welcome text, in the Windows language (customUnInit).
  Var starlightUnWelcome

  # Shows the graphical uninstall window and waits for it to close, like
  # starlightInterface for installation: if the interface really opened, the
  # uninstaller quits without showing anything else; otherwise it returns
  # and the classic pages follow.
  Function un.starlightInterface
    System::Call 'kernel32::CreateMutexW(p 0, i 0, w "StarLight-uninstaller-interface") p .r1 ?e'
    Pop $0
    ${If} $0 == 183
      Quit
    ${EndIf}

    InitPluginsDir
    StrCpy $R0 "$PLUGINSDIR\interface"
    SetOutPath "$R0"
    File "/oname=starlight-uninstaller.exe" "${BUILD_RESOURCES_DIR}\installer\neutralino\neutralino-win_x64.exe"
    File "${BUILD_RESOURCES_DIR}\installer\neutralino\LICENSE-neutralinojs.txt"
    File "/oname=neutralino.config.json" "${BUILD_RESOURCES_DIR}\installer\neutralino-uninstall.config.json"
    SetOutPath "$R0\page"
    File /r "${BUILD_RESOURCES_DIR}\installer\ui\*.*"
    File "/oname=logo.svg" "${BUILD_RESOURCES_DIR}\icon.svg"
    File "/oname=logo.png" "${BUILD_RESOURCES_DIR}\icon-256.png"

    # Starting data for the interface, one entry per line. The running
    # uninstaller is the temporary copy NSIS creates by itself: the interface
    # relaunches it silently with _?= on the program folder, so it works
    # without copying itself again.
    FileOpen $R2 "$R0\startup.txt" w
    FileWriteUTF16LE /BOM $R2 "uninstaller=$EXEPATH$\r$\n"
    FileWriteUTF16LE $R2 "programFolder=$INSTDIR$\r$\n"
    FileWriteUTF16LE $R2 "data=$APPDATA\${APP_FILENAME}$\r$\n"
    FileWriteUTF16LE $R2 "executable=${PRODUCT_FILENAME}.exe$\r$\n"
    FileWriteUTF16LE $R2 "language=$starlightLanguage$\r$\n"
    FileWriteUTF16LE $R2 "version=${VERSION}$\r$\n"
    FileWriteUTF16LE $R2 "codename=${STARLIGHT_CODENAME}$\r$\n"
    FileWriteUTF16LE $R2 "mode=$starlightMode$\r$\n"
    FileClose $R2

    # The WebView2 engine data stays in the temporary folder, which Windows
    # and NSIS clean up, instead of %APPDATA%.
    System::Call 'kernel32::SetEnvironmentVariableW(w "WEBVIEW2_USER_DATA_FOLDER", w "$PLUGINSDIR\webview") i'

    # The interface finds its files in the current working folder, which
    # thus is no longer the program folder to delete.
    SetOutPath "$R0"
    ClearErrors
    ExecWait '"$R0\starlight-uninstaller.exe" --load-dir-res --path=.' $R3

    ${IfNot} ${FileExists} "$R0\opened.txt"
      SetOutPath "$TEMP"
      Return
    ${EndIf}

    # Waits for the WebView2 processes to release the files, so the
    # temporary folder is deleted entirely on exit.
    SetOutPath "$TEMP"
    StrCpy $R4 0
    ${Do}
      ClearErrors
      RMDir /r "$PLUGINSDIR\webview"
      ${IfNot} ${FileExists} "$PLUGINSDIR\webview\*.*"
        ${Break}
      ${EndIf}
      IntOp $R4 $R4 + 1
      ${If} $R4 > 20
        ${Break}
      ${EndIf}
      Sleep 250
    ${Loop}
    SetErrorLevel $R3
    Quit
  FunctionEnd

  !macro customUnInit
    !insertmacro starlightReadLanguage
    !insertmacro starlightText $starlightUnWelcome "Questo programma ti guiderà nella disinstallazione di ${PRODUCT_NAME}.$\r$\n$\r$\nPrima di iniziare, assicurati che ${PRODUCT_NAME} sia chiuso." "This wizard will guide you through the uninstallation of ${PRODUCT_NAME}.$\r$\n$\r$\nBefore starting, make sure ${PRODUCT_NAME} is closed."
    ${If} ${Silent}
      # Choices passed by the graphical window (absent in updates).
      ${StdUtils.GetParameter} $starlightDeleteData "starlight-delete-data" "0"
      ${StdUtils.GetParameter} $starlightProgress "starlight-progress" ""
    ${Else}
      # $installMode belongs to the template (multiUser.nsh), already read here.
      ${If} $installMode == "all"
        StrCpy $starlightMode "/allusers"
      ${Else}
        StrCpy $starlightMode "/currentuser"
      ${EndIf}
      Call un.starlightInterface
    ${EndIf}
  !macroend

  Function un.starlightDataPage
    !insertmacro starlightText $R4 "Dati del programma" "Program data"
    !insertmacro starlightText $R5 "Scegli se conservare i dati di StarLight su questo computer." "Choose whether to keep the StarLight data on this computer."
    !insertmacro MUI_HEADER_TEXT "$R4" "$R5"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    !insertmacro starlightText $R4 "Nella cartella $APPDATA\${APP_FILENAME} StarLight conserva le impostazioni, la libreria di calibrazione, i cataloghi e i plugin che hai installato, le copie di recupero del lavoro e il registro degli errori. Se la conservi, ritrovi tutto reinstallando il programma.$\r$\n$\r$\nI progetti e le immagini che hai salvato non vengono toccati." "In the folder $APPDATA\${APP_FILENAME} StarLight keeps the settings, the calibration library, the catalogs and plugins you installed, the recovery copies of your work and the error log. If you keep it, you will find everything again when you reinstall the program.$\r$\n$\r$\nThe projects and images you saved are not touched."
    ${NSD_CreateLabel} 0 0 100% 72u "$R4"
    Pop $0
    !insertmacro starlightText $R5 "Elimina anche i dati del programma" "Also delete the program data"
    ${NSD_CreateCheckbox} 0 80u 100% 12u "$R5"
    Pop $starlightDataBox
    ${If} $starlightDeleteData == "1"
      ${NSD_Check} $starlightDataBox
    ${EndIf}
    nsDialogs::Show
  FunctionEnd

  Function un.starlightDataPageLeave
    ${NSD_GetState} $starlightDataBox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $starlightDeleteData "1"
    ${Else}
      StrCpy $starlightDeleteData "0"
    ${EndIf}
  FunctionEnd

  !macro starlightDisassociateExtension EXT CLASS
    ReadRegStr $R1 SHELL_CONTEXT "Software\Classes\.${EXT}" ""
    ${If} $R1 == "${CLASS}"
      ReadRegStr $R2 SHELL_CONTEXT "Software\Classes\.${EXT}" "StarLight.previous"
      ${If} $R2 != ""
        WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}" "" "$R2"
      ${Else}
        DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}" ""
      ${EndIf}
    ${EndIf}
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}" "StarLight.previous"
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${CLASS}"
    # The keys are removed only if they stay completely empty: NSIS's
    # "/ifempty" only looks at subkeys, not values (like the default one just
    # restored), so the values are checked by hand.
    EnumRegValue $R3 SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" 0
    ${If} $R3 == ""
      DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids"
    ${EndIf}
    ClearErrors
    EnumRegValue $R3 SHELL_CONTEXT "Software\Classes\.${EXT}" 0
    ReadRegStr $R2 SHELL_CONTEXT "Software\Classes\.${EXT}" ""
    ${If} $R3 == ""
    ${AndIf} $R2 == ""
      DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.${EXT}"
    ${EndIf}
  !macroend

  !macro customUnInstall
    # In an update the old version is removed and immediately put back:
    # the associations stay where they are.
    ${IfNot} ${isUpdated}
      !insertmacro starlightNote "phase=associations"
      !insertmacro starlightDisassociateExtension "fit" "${STARLIGHT_CLASS_FITS}"
      !insertmacro starlightDisassociateExtension "fits" "${STARLIGHT_CLASS_FITS}"
      !insertmacro starlightDisassociateExtension "fz" "${STARLIGHT_CLASS_FITS}"
      !insertmacro starlightDisassociateExtension "xisf" "${STARLIGHT_CLASS_XISF}"
      !insertmacro starlightDisassociateExtension "slight" "${STARLIGHT_CLASS_PROJECT}"
      DeleteRegKey SHELL_CONTEXT "Software\Classes\${STARLIGHT_CLASS_FITS}"
      DeleteRegKey SHELL_CONTEXT "Software\Classes\${STARLIGHT_CLASS_XISF}"
      DeleteRegKey SHELL_CONTEXT "Software\Classes\${STARLIGHT_CLASS_PROJECT}"
      System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

      # Program data, only if requested in its page: the folder in
      # %APPDATA% and the cache of downloaded updates (updaterCacheDirName in
      # src/main/updates.ts).
      ${If} $starlightDeleteData == "1"
        !insertmacro starlightNote "phase=data"
        ${If} $installMode == "all"
          SetShellVarContext current
        ${EndIf}
        RMDir /r "$APPDATA\${APP_FILENAME}"
        RMDir /r "$LOCALAPPDATA\starlight-updater"
        ${If} $installMode == "all"
          SetShellVarContext all
        ${EndIf}
      ${EndIf}
    ${EndIf}
    # Right after, the template deletes the program files.
    !insertmacro starlightNote "phase=files"
  !macroend
!endif

# Uninstaller welcome page with its own text, in the Windows language (set
# in customUnInit): NSIS's Italian language file says «Questa programma».
# Right after, the program data page with the checkbox to delete them.
!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TEXT "$starlightUnWelcome$\r$\n$\r$\n$_CLICK"
  !insertmacro MUI_UNPAGE_WELCOME
  UninstPage custom un.starlightDataPage un.starlightDataPageLeave
!macroend
