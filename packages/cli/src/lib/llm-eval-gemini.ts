import {
  LLM_EVAL_TIMEOUT_MS,
  STRICT_VERDICT_RE,
  type LlmEvalResult,
} from "./llm-eval-shared.js";

/**
 * Run gemini evaluation via Google Gemini API directly.
 * Native fetch is used to avoid interactive CLI process hangs.
 * Fail-closed: missing VERDICT = failure.
 */
export async function tryGeminiPrint(prompt: string): Promise<LlmEvalResult> {
  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey) {
    return { validVerdict: false, output: "", error: undefined }; // fallback chain continue
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_EVAL_TIMEOUT_MS);

  try {
    const model = process.env["GEMINI_MODEL"] || "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: prompt,
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      if ([401, 403, 429].includes(response.status)) {
        return {
          validVerdict: false,
          output: "",
          error: undefined,
        };
      }
      return {
        validVerdict: false,
        output: "",
        error: `Gemini API returned status ${response.status}: ${errText}`,
      };
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string;
          }>;
        };
      }>;
    };

    const output = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    if (!STRICT_VERDICT_RE.test(output)) {
      return {
        validVerdict: false,
        output,
        error: `Gemini output missing VERDICT line (got ${output.slice(0, 100)}...)`,
      };
    }

    return { validVerdict: true, output };
  } catch (err: unknown) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    const isTimeout = controller.signal.aborted;
    if (isAbort || isTimeout) {
      return {
        validVerdict: false,
        output: "",
        error: undefined,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      validVerdict: false,
      output: "",
      error: `Gemini API call failed: ${msg}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}
