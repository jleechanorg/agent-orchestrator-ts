/**
 * Environment variable expansion — supports ${VAR} and ${VAR:-default} in YAML values.
 *
 * Companion module: config.ts is upstream code; env expansion is a fork feature
 * so it lives here to avoid merge conflicts.
 */

const ENV_VAR_RE = /\$\{([^}]+)\}/g;

export function expandEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    return expandEnvVarsInString(value);
  }

  if (Array.isArray(value)) {
    return value.map(expandEnvVars);
  }

  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = expandEnvVars(val);
    }
    return result;
  }

  return value;
}

function expandEnvVarsInString(value: string): string {
  return value.replace(ENV_VAR_RE, (_match, expr: string) => {
    const fallbackSeparator = ":-";
    const fallbackIndex = expr.indexOf(fallbackSeparator);

    if (fallbackIndex >= 0) {
      const varName = expr.substring(0, fallbackIndex);
      const defaultValue = expr.substring(fallbackIndex + fallbackSeparator.length);
      const envValue = process.env[varName];
      return envValue !== undefined && envValue !== "" ? envValue : defaultValue;
    }

    const envValue = process.env[expr];
    return envValue !== undefined ? envValue : "";
  });
}
