# Place NAPS2 portable files here. See DependencyManager.integration.md

Download the NAPS2 portable ZIP from https://www.naps2.com/download and
extract it into this folder before building the Windows installer.
Expected contents: naps2.console.exe + its DLLs.

Excluded from Windows builds if this stays empty — `electron-builder.yml`'s
extraResources entry only copies files that exist, but the app will fall back
to a system-wide NAPS2 install (or prompt the user to download it) if this
folder has no naps2.console.exe in it.
