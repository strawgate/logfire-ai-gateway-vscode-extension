/**
 * Sanitize lone UTF-16 surrogates before serialization.
 *
 * `JSON.stringify` either throws or emits invalid JSON when a string contains
 * unpaired surrogates (e.g. from Windows file paths or certain emoji sequences).
 * This replacer converts every string value in the serialized object to its
 * well-formed equivalent first.
 */

const LONE_SURROGATE_PATTERN =
  /([\uD800-\uDBFF][\uDC00-\uDFFF])|[\uD800-\uDFFF]/g;

export function toWellFormedString(value: string): string {
  // toWellFormed() is available in V8 12.2+ (Node 22+, VS Code 1.90+).
  // Fall back to the regex approach for older runtimes.
  return (value as unknown as { toWellFormed?: () => string }).toWellFormed?.() ??
    value.replace(LONE_SURROGATE_PATTERN, (_, pair) => (pair ? pair : "\uFFFD"));
}

export function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    typeof v === "string" ? toWellFormedString(v) : v,
  );
}
