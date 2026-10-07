# Hushscript CLI

Command line client for the [Hushscript](https://hushscript.com) transcription API. It is built on
the official TypeScript SDK, `@hushscript/sdk`, and needs Node 22 or newer.

```sh
npm install --global @hushscript/cli
hushscript login
hushscript transcribe meeting.mp3 --format srt --out meeting.srt
```

## Token

Create a token in the Hushscript app under Account, Connected apps. The CLI looks for it in this
order:

1. `--token <token>`
2. the `HUSHSCRIPT_TOKEN` environment variable
3. the token stored by `hushscript login`

`hushscript login` asks for the token without echoing it (or reads one line from stdin when it is
piped) and keeps it in `$XDG_CONFIG_HOME/hushscript/config.json`, which is `~/.config/hushscript/config.json`
when `XDG_CONFIG_HOME` is not set and `%APPDATA%\hushscript\config.json` on Windows. The file is
created with mode `0600` in a `0700` folder. `hushscript logout` deletes it. Prefer the environment
variable in CI: a token on the command line is visible to other processes on the machine, and
`login --token` prints a warning for that reason; run plain `login` to type the token or pipe it on
stdin.

- If the stored file is readable by group or others, every command that reads it warns on stderr and
  suggests `chmod 600`; the token is still used.
- If the config folder is a symbolic link, `login` refuses with exit code 1 instead of changing the
  mode of whatever the link points at. Replace the link with a real folder, or point
  `XDG_CONFIG_HOME` at one.
- `--token ""` is a usage error (exit code 2); it does not fall back to the other sources.

## Commands

| Command                 | What it does                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `login`                 | Prompts for a token and stores it.                                                                                                             |
| `logout`                | Deletes the stored token.                                                                                                                      |
| `balance`               | Shows the minutes you can spend.                                                                                                               |
| `transcribe <file>`     | Uploads a recording, waits, and prints the transcript. Flags: `--language`, `--translate es,de`, `--format srt\|vtt\|txt\|json`, `--out path`. |
| `resume <token> <file>` | Finishes a transcription that `transcribe` left behind (see Interrupting). Flags: `--format`, `--out`.                                         |
| `transcripts`           | Lists finished transcripts, newest first. Flag: `--limit` (default 20).                                                                        |
| `transcript <id>`       | Prints one transcript. Flags: `--format`, `--lang` (a translation, or `cleaned`).                                                              |
| `jobs`                  | Lists jobs. Flag: `--active` for the ones that have not finished.                                                                              |
| `packs`                 | Lists the minute packs you can buy, with prices.                                                                                               |
| `buy <pack>`            | Buys a pack with your saved default card. Flags: `--yes`, `--key`.                                                                             |

Global flags: `--json` and `--token`. The default format is `txt`. `--out` writes through a temporary
file and a rename, so the target is never half written. An existing target keeps its mode, and a
symbolic link is written through to the file it points at.

### Buying minutes

`buy` shows the no-refund notice on stderr and asks you to confirm; a missing token is reported
before it asks. With `--yes` the notice is still printed, before the purchase, also under `--json`.
Without a terminal and without `--yes` it exits with code 2 and sends nothing:

```sh
hushscript buy 300min --yes
```

Every purchase has an idempotency key: the one from `--key`, or a fresh one the CLI makes. If a
purchase fails after it was sent, or the CLI is stopped by SIGINT, SIGTERM or SIGHUP while it waits
for the answer (exit code 130), it prints the key and says the purchase may have been charged. Retry
with the same key and it cannot be charged twice:

```sh
hushscript buy 300min --yes --key <key>
```

### Interrupting

Ctrl-C (SIGINT), SIGTERM or SIGHUP during `transcribe` or `resume` stops the call, prints the resume
token of the job and exits with 130. A second signal exits at once, still printing the token. The
message names the command that continues the job:

```sh
hushscript resume <token> meeting.mp3 --format srt --out meeting.srt
```

`resume` takes the same recording and the same `--format`, `--out` and `--json` as `transcribe`; if
the job has finished meanwhile it just fetches the transcript.

## Scripting

`--json` prints one JSON document on stdout and nothing else. Errors go to stderr as one JSON object:

```json
{
  "code": "insufficient_balance",
  "numericCode": 4020,
  "status": 402,
  "message": "...",
  "hint": "...",
  "idempotencyKey": "...",
  "resumeToken": "..."
}
```

`idempotencyKey` and `resumeToken` appear only when the error has one. Progress bars are drawn on
stderr only when it is a terminal and `--json` is off. A few lines of text can come before that
document on stderr, so read its last line: the `buy` no-refund notice, and the warnings about a
readable token file or `login --token`.

| Exit code | Meaning                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------ |
| 0         | Success.                                                                                                           |
| 1         | The API or the SDK reported an error (also a missing token, or a declined purchase).                               |
| 2         | Usage error: unknown command or flag, a bad value, `buy` without a terminal and without `--yes`. Nothing was sent. |
| 130       | Interrupted by SIGINT, SIGTERM or SIGHUP.                                                                          |

## Development

Everything runs in containers, through `just`: `just ci` runs the static checks, the tests and the
end-to-end run of the built binary against the conformance mock, on Node 22 and 24. Until
`@hushscript/sdk` is on npm the gate packs the SDK from the commit in `sdk-ref`; see
`docs/sdk-dependency.md`.

## License

MIT
