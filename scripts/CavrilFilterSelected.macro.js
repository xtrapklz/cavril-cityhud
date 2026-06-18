/**
 * Cavril — Filter Selected Citizens
 * ============================================================================
 * Standalone Foundry macro. Paste the body below into a new "Script" macro
 * in Foundry and drop it on your macro bar. Selecting one or more citizen
 * tokens on the canvas and clicking this macro opens CityHUD with all of
 * them pre-selected in the left panel — ready for tag edits, mass metric
 * changes, group spawn, event application, etc.
 *
 * No-ops gracefully when:
 *   - No tokens are selected
 *   - The selected tokens aren't tagged as Cavril citizens
 *   - The CityHUD module isn't installed / loaded
 *
 * The logic itself lives in cavril-cityhud.js as
 * `CavrilTools.filterSelectedCitizens()`. This macro is a one-line
 * wrapper so the user doesn't have to memorize the API name.
 * ============================================================================
 */

if (typeof window.CavrilTools?.filterSelectedCitizens !== "function") {
  ui.notifications.error("Cavril CityHUD module isn't loaded — enable it in Module Management and reload.");
} else {
  window.CavrilTools.filterSelectedCitizens();
}
