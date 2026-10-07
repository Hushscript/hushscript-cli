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
variable in CI: a token on the command line is visible to other processes on the machine.

## Commands

| Command | What it does |
|---|---|
| `login` | Prompts for a token and stores it. |
| `logout` | Deletes the stored token. |
| `balance` | Shows the minutes you can spend. |
| `transcribe <file>` | Uploads a recording, waits, and prints the transcript. Flags: `--language`, `--translate es,de`, `--format srt\|vtt\|txt\|json`, `--out path`. |
| `transcripts` | Lists finished transcripts, newest first. Flag: `--limit` (default 20). |
| `transcript <id>` | Prints one transcript. Flags: `--format`, `--lang` (a translation, or `cleaned`). |
| `jobs` | Lists jobs. Flag: `--active` for the ones that have not finished. |
| `packs` | Lists the minute packs you can buy, with prices. |
| `buy <pack>` | Buys a pack with your saved default card. Flags: `--yes`, `--key`. |

Global flags: `--json` and `--token`. The default format is `txt`. `--out` writes through a temporary
file and a rename, so the target is never half written.

### Buying minutes

`buy` shows the no-refund notice and asks you to confirm. Without a terminal it exits with code 2 and
sends nothing, unless you pass `--yes`:

```sh
hushscript buy 300min --yes
```

If a purchase fails after it was sent, the CLI prints its idempotency key and says the purchase may
have been charged. Retry with the same key and it cannot be charged twice:

```sh
hushscript buy 300min --yes --key <key>
```

### Interrupting

Ctrl-C during `transcribe` stops the upload, prints the resume token of the job and exits with 130.
A second Ctrl-C exits at once.

## Scripting

`--json` prints one JSON document on stdout and nothing else. Errors go to stderr as one JSON object:

```json
{ "code": "insufficient_balance", "numericCode": 4020, "status": 402, "message": "...", "hint": "...", "idempotencyKey": "...", "resumeToken": "..." }
```

`idempotencyKey` and `resumeToken` appear only when the error has one. Progress bars are drawn on
stderr only when it is a terminal and `--json` is off.

| Exit code | Meaning |
|---|---|
| 0 | Success. |
| 1 | The API or the SDK reported an error (also a missing token, or a declined purchase). |
| 2 | Usage error: unknown command or flag, a bad value, `buy` without a terminal and without `--yes`. Nothing was sent. |
| 130 | Interrupted. |

## Development

Everything runs in containers, through `just`: `just ci` runs the static checks, the tests and the
end-to-end run of the built binary against the conformance mock, on Node 22 and 24. Until
`@hushscript/sdk` is on npm the gate packs the SDK from the commit in `sdk-ref`; see
`docs/sdk-dependency.md`.

## License

MIT
