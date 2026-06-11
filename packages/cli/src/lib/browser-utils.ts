/**
 * Determine if the browser should open automatically based on:
 *   - opts.openBrowser (CLI flag --no-open-browser)
 *   - opts.open (CLI flag --no-open)
 *   - config.openBrowser (YAML config)
 *   - AO_NO_OPEN_BROWSER (environment variable)
 */
export function shouldOpenBrowser(
  opts: { openBrowser?: boolean; open?: boolean } | undefined,
  config: { openBrowser?: boolean },
): boolean {
  if (opts?.openBrowser === false) return false;
  if (opts?.open === false) return false;
  if (config.openBrowser === false) return false;
  const envVal = process.env["AO_NO_OPEN_BROWSER"]?.toLowerCase();
  if (envVal === "1" || envVal === "true") return false;
  return true;
}
