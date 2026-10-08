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
- A source that is empty or only whitespace counts as not set: `--token ""`, an empty
  `HUSHSCRIPT_TOKEN`, an empty `token` in the stored file, and likewise `HUSHSCRIPT_BASE_URL`,
  `XDG_CONFIG_HOME` and `APPDATA`. The CLI moves on to the next source; with none left it reports
  "No Hushscript token." (exit code 1). `login --token ""` prompts as if the flag was absent, and
  `logout` ignores `--token`.

## Commands

| Command                 | What it does                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login`                 | Prompts for a token and stores it.                                                                                                                      |
| `logout`                | Deletes the stored token.                                                                                                                               |
| `balance`               | Shows the minutes you can spend.                                                                                                                        |
| `transcribe <file>`     | Uploads a recording, waits, and prints the transcript. Flags: `--language`, `--translate es,de`, `--format srt\|vtt\|txt\|json`, `--out path`, `--key`. |
| `resume <token> <file>` | Finishes a transcription that `transcribe` left behind (see Interrupting). Flags: `--format`, `--out`.                                                  |
| `transcripts`           | Lists finished transcripts, newest first. Flag: `--limit` (default 20).                                                                                 |
| `transcript <id>`       | Prints one transcript. Flags: `--format`, `--lang` (a translation, or `cleaned`).                                                                       |
| `jobs`                  | Lists jobs. Flag: `--active` for the ones that have not finished.                                                                                       |
| `packs`                 | Lists the minute packs you can buy, with prices.                                                                                                        |
| `buy <pack>`            | Buys a pack with your saved default card. Flags: `--yes`, `--key`.                                                                                      |

Global flags: `--json` and `--token`. The default format is `txt`. `--out` writes through a temporary
file and a rename, so the target is never half written. The temporary file is created with the mode
the target will have (an existing target keeps its mode, a new file gets `0644` minus the umask). A
symbolic link is followed, also a dangling one, and written through to the file it points at; before
anything is sent, `--out` is checked at the place the link leads to, so a link into a folder that
does not exist is a usage error (exit code 2) and no job is created.

### Buying minutes

`buy` shows the no-refund notice on stderr and asks you to confirm; a missing token is reported
before it asks. With `--yes` the notice is still printed, before the purchase, also under `--json`.
Without a terminal (stdin and stderr both) and without `--yes` it exits with code 2 and sends nothing:

```sh
hushscript buy 300min --yes
```

A stop signal (SIGINT, SIGTERM or SIGHUP) while `buy` waits for your answer prints nothing and exits
with 130: the no-refund notice and the question are already on stderr, nothing was sent and nothing
was charged.

Every purchase has an idempotency key: the one from `--key`, or a fresh one the CLI makes. If a
purchase fails after it was sent, or the CLI is stopped by SIGINT, SIGTERM or SIGHUP once `buy` has
started (exit code 130, also while the card is still being looked up), it prints the key and says
"The purchase may have been sent. Retry with --key <key>: the same key never charges twice." Only a
refusal that proves nothing was charged (a 400, 402, 404 or 422 answer, or a 403 with numeric code
4021 or 4023) leaves the notice out; a 401 or 429 does not prove it, because the
server answers those before it replays a purchase that already went through. Retry with the same key and
it cannot be charged twice:

```sh
hushscript buy 300min --yes --key <key>
```

### Interrupting

Ctrl-C (SIGINT), SIGTERM or SIGHUP during `transcribe` or `resume` stops the call, prints the resume
token of the job and exits with 130. A second signal exits at once, still printing the token (and the
idempotency key `transcribe` started with). A stop signal at any other moment, when nothing was sent
that a token could be about, ends the CLI with 130 and prints nothing. The message names the command
that continues the job:

```sh
hushscript resume <token> meeting.mp3 --format srt --out meeting.srt
```

When the run stopped before the API handed out a token, the message carries the idempotency key
instead and names the command that replays the same `transcribe` call, with the `--language`, `--translate`,
`--format` and `--out` you passed, so the replay asks for the same job; the same key never creates the
job twice:

```sh
hushscript transcribe --key <key> meeting.mp3 --language en --format srt --out meeting.srt
```

The resume command carries the `--format` and `--out` you passed (the flags you did not pass are left
out). `resume` takes the same recording and the same `--format`, `--out` and `--json` as `transcribe`; if
the job has finished meanwhile it just fetches the transcript.

## Scripting

`--json` prints one JSON document on stdout and nothing else. `--help --json` prints `{"help": "..."}`
and `--version --json` prints `{"version": "..."}`.

Under `--json` stderr is JSON Lines: every line is one JSON object with a `type`. Notices and warnings
come first, as they happen, and the error object, if the command failed, comes last:

```json
{"type":"notice","code":"no_refund","message":"..."}
{"type":"warning","code":"token_file_shared","message":"..."}
{
  "type": "error",
  "code": "insufficient_balance",
  "numericCode": 4020,
  "status": 402,
  "message": "...",
  "hint": "...",
  "idempotencyKey": "...",
  "resumeToken": "..."
}
```

(The error object is one line on stderr; it is wrapped here to read.) `idempotencyKey` and `resumeToken`
appear only when the error has one. The notice codes are `no_refund` (the `buy` notice) and the warning
codes are `token_file_shared` (a stored token file other users can read) and `token_on_command_line`
(`login --token`). Progress bars are drawn on stderr only when it is a terminal and `--json` is off.
The one text that can still reach stderr under `--json` is a prompt (`login` asking for the token,
`buy` asking to confirm): prompts are only shown when both stdin and stderr are terminals; otherwise pass the flags (`--yes`, `--token`) or pipe the token.

| Exit code | Meaning                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------ |
| 0         | Success.                                                                                                           |
| 1         | The API or the SDK reported an error (also a missing token, or a declined purchase).                               |
| 2         | Usage error: unknown command or flag, a bad value, `buy` without a terminal and without `--yes`. Nothing was sent. |
| 130       | Interrupted by SIGINT, SIGTERM or SIGHUP, at any moment of the run.                                                |

## Development

Everything runs in containers, through `just`: `just ci` runs the static checks, the tests and the
end-to-end run of the built binary against the conformance mock, on Node 22 and 24. Until
`@hushscript/sdk` is on npm the gate packs the SDK from the commit in `sdk-ref`; see
`docs/sdk-dependency.md`.

## License

MIT
