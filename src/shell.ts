const SAFE = /^[\w@%+=:,./-]+$/;

/** One word for a POSIX shell: left alone when it needs no quoting, else in single quotes. */
export function shellWord(text: string): string {
  return SAFE.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}
