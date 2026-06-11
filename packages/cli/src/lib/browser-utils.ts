/**
 * Determine if the browser should open automatically based on:
 *   - opts.openBrowser (CLI flag --open-browser / --no-open-browser)
 *   - opts.open (CLI flag --open / --no-open)
 *   - config.openBrowser (YAML config)
 *   - AO_NO_OPEN_BROWSER (environment variable)
 */
export function shouldOpenBrowser(
  opts: { openBrowser?: boolean; open?: boolean } | undefined,
  config: { openBrowser?: boolean },
): boolean {
  if (opts?.openBrowser === false) return false;
  if (opts?.open === false) return false;
  if (opts?.openBrowser === true) return true;
  if (opts?.open === true) return true;

  const envVal = process.env["AO_NO_OPEN_BROWSER"]?.toLowerCase();
  if (envVal === "1" || envVal === "true") return false;

  if (config.openBrowser === true) return true;

  return false;
}
