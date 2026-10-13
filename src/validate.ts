import { usageError } from "./errors.ts";

export const FORMATS = ["srt", "vtt", "txt", "json"] as const;
export type Format = (typeof FORMATS)[number];

const LOCALE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;
const LANG_FLAG = /^[a-z][\w-]{0,31}$/i;
const ID = /^[\w.-]{1,128}$/;
const PACK = /^\d{1,6}min$/;
const KEY = /^[\w-]{1,128}$/;
const LIMIT = /^[1-9]\d{0,5}$/;

export function parseLanguage(value: string): string {
  if (!LOCALE.test(value)) {
    throw usageError(`--language must be a language code such as en or pt-BR, not "${value}".`);
  }
  return value;
}

export function parseTranslate(value: string): string[] {
  const codes = value.split(",").map((code) => code.trim());
  for (const code of codes) {
    if (!LOCALE.test(code)) {
      throw usageError(
        `--translate takes language codes separated by commas, such as es,de; "${code}" is not one.`,
      );
    }
  }
  return [...new Set(codes)];
}

export function parseLang(value: string): string {
  if (!LANG_FLAG.test(value)) {
    throw usageError(`--lang must be a translation language code or "cleaned", not "${value}".`);
  }
  return value;
}

export function parseLimit(value: string): number {
  if (!LIMIT.test(value)) throw usageError("--limit must be a whole number from 1 to 999999.");
  return Number(value);
}

export function parseId(value: string, name: string): string {
  if (!ID.test(value) || value === "." || value === "..") {
    throw usageError(`${name} must be 1 to 128 letters, digits, dots, dashes or underscores.`);
  }
  return value;
}

export function parsePack(value: string): string {
  if (!PACK.test(value)) {
    throw usageError(`The pack must look like 300min; run \`hushscript packs\` to list them.`);
  }
  return value;
}

export function parseKey(value: string): string {
  if (!KEY.test(value)) {
    throw usageError("--key must be 1 to 128 characters from A-Z, a-z, 0-9, _ and -.");
  }
  return value;
}

/** `--json` prints the transcript as JSON, so a different `--format` contradicts it. */
export function resolveFormat(json: boolean, format: Format | undefined): Format {
  if (!json) return format ?? "txt";
  if (format !== undefined && format !== "json") {
    throw usageError("--json prints the transcript as JSON; drop --format or use --format json.");
  }
  return "json";
}
