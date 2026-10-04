# Screen share notes

Bana Copilot uses Electron `setContentProtection(true)` as a best-effort flag.
It can hide the HUD from some window-list captures (Meet, some Teams/Zoom window shares).
It does **not** hide the HUD from Zoom entire-display share on Auto.

Use:

1. Share a specific window, or
2. Put the HUD on a second display, or
3. Hide with Cmd+\\

Do not rename the process or claim the overlay is undetectable.
