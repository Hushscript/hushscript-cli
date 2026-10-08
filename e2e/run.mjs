// Runs the built binary (dist/index.js) against the conformance mock this container shares a network with.
// The mock accepts any bearer token that starts with "hsr" and serves the one-speaker transcript for a finished job.
import { spawn, spawnSync } from "node:child_process";
import { deepStrictEqual } from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE_URL = "http://127.0.0.1:4010";
const TOKEN = `hsr1:eu:pat.${"0123456789abcdef".repeat(2)}.${"fedcba9876543210".repeat(4)}`;
const BIN = "dist/index.js";
const WORK = "/tmp/e2e";

mkdirSync(join(WORK, "config"), { recursive: true });

/** @param {string} path @param {unknown} [body] */
async function mock(path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${path} answered ${String(response.status)}`);
  return response;
}

/**
 * The mock's answer as JSON; the caller casts it.
 * @param {string} path
 * @returns {Promise<unknown>}
 */
async function mockJson(path) {
  /** @type {unknown} */
  const body = await (await mock(path)).json();
  return body;
}

/**
 * @param {string[]} args
 * @param {{ env?: Record<string, string>, input?: string }} [options]
 */
function cli(args, options = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    // No input means stdin is /dev/null: not a terminal.
    input: options.input ?? "",
    encoding: "utf8",
    timeout: 120_000,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: join(WORK, "home"),
      XDG_CONFIG_HOME: join(WORK, "config"),
      HUSHSCRIPT_BASE_URL: BASE_URL,
      ...options.env,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** @param {string} text @returns {unknown} */
function parse(text) {
  return JSON.parse(text);
}

/** @param {string} stderr */
function errorCode(stderr) {
  return /** @type {{ code?: unknown }} */ (parse(stderr)).code;
}

const withToken = { HUSHSCRIPT_TOKEN: TOKEN };
const outcome = { failed: false };

/** @param {string} name @param {() => Promise<void> | void} check */
async function step(name, check) {
  try {
    await check();
    console.log(`PASS ${name}`);
  } catch (error) {
    outcome.failed = true;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** @param {boolean} condition @param {string} message */
function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/** @param {{ status: number | null, stderr: string }} result @param {number} status */
function expectStatus(result, status) {
  expect(
    result.status === status,
    `exit ${String(result.status)}, wanted ${String(status)}; stderr: ${result.stderr}`,
  );
}

const media = await mock("/__files/fixtures/media/cbr-20s.mp3");
const sample = join(WORK, "sample.mp3");
writeFileSync(sample, new Uint8Array(await media.arrayBuffer()));
const golden = await (await mock("/__files/fixtures/exports/one-speaker.srt-captions.srt")).text();

/** A fresh mock with credit and jobs that finish at once. */
async function freshMock() {
  await mock("/__scenario", {
    mock: { account: { balance_seconds: 360_000 }, completeState: "done" },
  });
}

await step("transcribe --format srt matches the golden", async () => {
  await freshMock();
  const result = cli(["transcribe", sample, "--format", "srt"], { env: withToken });
  expectStatus(result, 0);
  expect(
    result.stdout === golden,
    "stdout differs from fixtures/exports/one-speaker.srt-captions.srt",
  );
  expect(result.stderr === "", `stderr is not empty: ${result.stderr}`);
});

await step("transcribe --out writes the golden", async () => {
  await freshMock();
  const out = join(WORK, "meeting.srt");
  const result = cli(["transcribe", sample, "--format", "srt", "--out", out], { env: withToken });
  expectStatus(result, 0);
  expect(result.stdout === "", "stdout is not empty");
  expect(readFileSync(out, "utf8") === golden, "the written file differs from the golden");
});

await step("balance --json prints one document", async () => {
  await freshMock();
  const result = cli(["balance", "--json"], { env: withToken });
  expectStatus(result, 0);
  const document = /** @type {{ seconds: number, minutes: number }} */ (parse(result.stdout));
  expect(
    document.seconds === 360_000 && document.minutes === 6000,
    `unexpected balance ${result.stdout}`,
  );
  expect(result.stderr === "", "stderr is not empty");
});

await step("transcripts --json lists SDK summaries over the wire", async () => {
  await mock("/__scenario", { mock: { listing: { count: 2 } } });
  const result = cli(["transcripts", "--json"], { env: withToken });
  expectStatus(result, 0);
  deepStrictEqual(
    parse(result.stdout),
    {
      transcripts: [
        {
          id: "tr_list_001",
          title: "Synthetic 001",
          language: "en",
          durationSeconds: 60,
          createdAt: "2025-10-09T08:52:20.000Z",
          autoDeleteAt: null,
          tags: [],
        },
        {
          id: "tr_list_002",
          title: "Synthetic 002",
          language: "en",
          durationSeconds: 60,
          createdAt: "2025-10-09T08:51:20.000Z",
          autoDeleteAt: null,
          tags: [],
        },
      ],
    },
    `unexpected summaries: ${result.stdout}`,
  );
  expect(result.stderr === "", `stderr: ${result.stderr}`);
});

await step("jobs --json lists a completed SDK job over the wire", async () => {
  await freshMock();
  expectStatus(cli(["transcribe", sample, "--json"], { env: withToken }), 0);
  const result = cli(["jobs", "--json"], { env: withToken });
  expectStatus(result, 0);
  deepStrictEqual(
    parse(result.stdout),
    {
      jobs: [
        {
          id: "job_conf_0001",
          state: "done",
          transcriptId: "tr_conf_0001",
          error: null,
          failureKind: null,
          mode: "standard",
          declaredSeconds: 21,
          verifiedSeconds: 21,
          actualSeconds: 21,
          billableSeconds: 21,
          retryOf: null,
          createdAt: "2025-10-09T08:53:20.000Z",
          options: {
            languageCode: null,
            speakerDetection: true,
            medicalMode: false,
            multichannel: false,
            translationTargets: [],
            keyterms: false,
            prompt: false,
            autoGenerateInsights: null,
          },
        },
      ],
    },
    `unexpected job: ${result.stdout}`,
  );
  expect(result.stderr === "", `stderr: ${result.stderr}`);
});

await step("packs --json lists SDK pack prices over the wire", async () => {
  await freshMock();
  const result = cli(["packs", "--json"], { env: withToken });
  expectStatus(result, 0);
  deepStrictEqual(
    parse(result.stdout),
    {
      packs: [
        {
          id: "45min",
          seconds: 2700,
          minutes: 45,
          price: { amount: 599, currency: "USD", formatted: "$5.99" },
          bonusMinutes: 0,
          available: true,
        },
        {
          id: "300min",
          seconds: 18_000,
          minutes: 300,
          price: { amount: 3499, currency: "USD", formatted: "$34.99" },
          bonusMinutes: 0,
          available: true,
        },
        {
          id: "900min",
          seconds: 54_000,
          minutes: 900,
          price: { amount: 8999, currency: "USD", formatted: "$89.99" },
          bonusMinutes: 0,
          available: true,
        },
        {
          id: "1800min",
          seconds: 108_000,
          minutes: 1800,
          price: { amount: 15_999, currency: "USD", formatted: "$159.99" },
          bonusMinutes: 0,
          available: true,
        },
        {
          id: "6000min",
          seconds: 360_000,
          minutes: 6000,
          price: { amount: 44_999, currency: "USD", formatted: "$449.99" },
          bonusMinutes: 0,
          available: true,
        },
      ],
    },
    `unexpected packs: ${result.stdout}`,
  );
  expect(result.stderr === "", `stderr: ${result.stderr}`);
});

await step("transcript success prints the SRT golden over the wire", async () => {
  await mock("/__scenario", { mock: { listing: { count: 1 } } });
  const result = cli(["transcript", "tr_list_001", "--format", "srt"], { env: withToken });
  expectStatus(result, 0);
  expect(result.stdout === golden, "transcript stdout differs from the SRT golden");
  expect(result.stderr === "", `stderr: ${result.stderr}`);
});

await step("transcript --lang es prints the translation golden over the wire", async () => {
  await mock("/__scenario", { mock: { fixture: "translated", listing: { count: 1 } } });
  const translated = await (
    await mock("/__files/fixtures/exports/translated.txt-default.es.txt")
  ).text();
  const result = cli(["transcript", "tr_list_001", "--lang", "es"], { env: withToken });
  expectStatus(result, 0);
  expect(result.stdout === translated, "transcript stdout differs from the Spanish TXT golden");
  expect(result.stderr === "", `stderr: ${result.stderr}`);
});

for (const [name, contents] of /** @type {[string, string][]} */ ([
  ["empty.mp3", ""],
  ["unsupported.txt", "This is text, not supported audio."],
])) {
  await step(`transcribe ${name} surfaces SDK unsupported_media without requests`, async () => {
    await freshMock();
    const file = join(WORK, name);
    writeFileSync(file, contents);
    const result = cli(["transcribe", file, "--json"], { env: withToken });
    expectStatus(result, 1);
    expect(result.stdout === "", `stdout: ${result.stdout}`);
    expect(errorCode(result.stderr) === "unsupported_media", `stderr: ${result.stderr}`);
    const log = /** @type {unknown[]} */ (await mockJson("/__log"));
    expect(log.length === 0, `preflight sent requests: ${JSON.stringify(log)}`);
  });
}

await step("buy API 401 preserves SDK fields and the retry key over the wire", async () => {
  await mock("/__scenario", { mock: { purchase: [{ status: 401, error: "unauthorized" }] } });
  const key = "e2e-buy-401";
  const result = cli(["buy", "300min", "--yes", "--key", key, "--json"], { env: withToken });
  expectStatus(result, 1);
  expect(result.stdout === "", `stdout: ${result.stdout}`);
  const lines = result.stderr.trimEnd().split("\n");
  expect(lines.length === 2, `stderr: ${result.stderr}`);
  const notice = /** @type {{ type?: unknown, code?: unknown }} */ (parse(lines[0] ?? ""));
  expect(notice.type === "notice" && notice.code === "no_refund", `stderr: ${result.stderr}`);
  const report =
    /** @type {{ type?: unknown, code?: unknown, numericCode?: unknown, status?: unknown, idempotencyKey?: unknown, hint?: unknown }} */ (
      parse(lines[1] ?? "")
    );
  expect(
    report.type === "error" &&
      report.code === "unauthorized" &&
      report.numericCode === 2000 &&
      report.status === 401 &&
      report.idempotencyKey === key,
    `SDK error fields: ${result.stderr}`,
  );
  expect(
    report.hint ===
      `Your token is invalid, revoked or expired. Create a new one in the Hushscript app under Account → MCP. Changing your password revokes all tokens. The purchase may have been sent. Retry with --key ${key}: the same key never charges twice.`,
    `retry hint: ${result.stderr}`,
  );
  const log =
    /** @type {{ method: string, path: string, status: number, idempotencyKey: string | null }[]} */ (
      await mockJson("/__log")
    );
  const purchases = log.filter(
    (entry) => entry.method === "POST" && entry.path === "/v1/billing/purchase",
  );
  expect(
    purchases.length === 1 && purchases[0]?.status === 401 && purchases[0].idempotencyKey === key,
    `purchase requests: ${JSON.stringify(log)}`,
  );
});

await step("buy without --yes and without a terminal exits 2 and sends nothing", async () => {
  await freshMock();
  await mock("/__mark", {});
  const result = cli(["buy", "300min"], { env: withToken });
  expectStatus(result, 2);
  expect(result.stderr.includes("non-refundable"), "the no-refund notice was not shown");
  const log = /** @type {unknown[]} */ (await mockJson("/__log"));
  expect(log.length === 0, `the mock saw ${JSON.stringify(log)}`);
});

await step("buy --yes buys and acknowledges the notice", async () => {
  await freshMock();
  const result = cli(["buy", "300min", "--yes", "--json"], { env: withToken });
  expectStatus(result, 0);
  expect(result.stderr.includes("non-refundable"), "the no-refund notice was not shown with --yes");
  const state = await mockJson("/__state").then(
    (value) => /** @type {{ purchases: { policyAck: boolean }[] }} */ (value),
  );
  expect(
    state.purchases.length === 1 && state.purchases[0]?.policyAck === true,
    `purchases: ${JSON.stringify(state.purchases)}`,
  );
});

await step("no token anywhere exits 1 as JSON on stderr", async () => {
  await freshMock();
  const result = cli(["balance", "--json"]);
  expectStatus(result, 1);
  expect(result.stdout === "", "stdout is not empty");
  expect(errorCode(result.stderr) === "config_invalid", `stderr: ${result.stderr}`);
});

await step("an API error exits 1 with the SDK's code", async () => {
  await freshMock();
  const result = cli(["transcript", "tr_does_not_exist", "--json"], { env: withToken });
  expectStatus(result, 1);
  expect(result.stdout === "", "stdout is not empty");
  expect(typeof errorCode(result.stderr) === "string", `stderr: ${result.stderr}`);
});

await step(
  "login stores a 0600 token from stdin that later commands use, logout removes it",
  async () => {
    await freshMock();
    const login = cli(["login"], { input: `${TOKEN}\n` });
    expectStatus(login, 0);
    const file = join(WORK, "config", "hushscript", "config.json");
    expect((statSync(file).mode & 0o777) === 0o600, "the token file is not 0600");
    expect(
      !login.stdout.includes(TOKEN) && !login.stderr.includes(TOKEN),
      "login printed the token",
    );
    const balance = cli(["balance", "--json"]);
    expectStatus(balance, 0);
    const logout = cli(["logout"]);
    expectStatus(logout, 0);
    expectStatus(cli(["balance"]), 1);
  },
);

/** The environment of a CLI child that is signalled, which `cli()` cannot do because it waits for the exit. */
const childEnv = {
  PATH: process.env["PATH"] ?? "",
  XDG_CONFIG_HOME: join(WORK, "config"),
  HUSHSCRIPT_BASE_URL: BASE_URL,
  HUSHSCRIPT_TOKEN: TOKEN,
};

/**
 * Starts the CLI, waits until `ready()` says it is mid-call, signals it (each signal of `signals` in turn,
 * `gap` milliseconds apart) and returns how it ended.
 * @param {string[]} args
 * @param {NodeJS.Signals[]} signals
 * @param {() => Promise<boolean>} ready
 * @param {{ env?: Record<string, string>, gap?: number, stdin?: "ignore" | "pipe" }} [options]
 */
async function signalled(args, signals, ready, options = {}) {
  const { env = childEnv, gap = 1000, stdin = "ignore" } = options;
  const child = spawn(process.execPath, [BIN, ...args], {
    env,
    stdio: [stdin, "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  /** @type {Promise<{ code: number | null, signal: NodeJS.Signals | null }>} */
  const exit = new Promise((resolve) => {
    child.on("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
  for (let waited = 0; waited < 60_000 && !(await ready()); waited += 200) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  /** What the child had printed before each signal after the first one. */
  const before = [];
  for (const [index, signal] of signals.entries()) {
    await new Promise((resolve) => setTimeout(resolve, gap));
    if (index > 0) before.push(stderr);
    child.kill(signal);
  }
  const ended = await exit;
  return { status: ended.code, killedBy: ended.signal, stdout, stderr, before };
}

/** @param {NodeJS.Signals} signal */
async function interruptTranscribe(signal) {
  await mock("/__scenario", {
    mock: {
      account: { balance_seconds: 360_000 },
      jobFlow: [{ state: "processing", untilClock: 200 }, { state: "done" }],
    },
  });
  // Wait until the job exists and the CLI is polling it.
  const result = await signalled(["transcribe", sample, "--json"], [signal], async () => {
    const state = /** @type {{ jobs: number }} */ (await mockJson("/__state"));
    return state.jobs > 0;
  });
  const report = /** @type {{ code?: unknown, resumeToken?: unknown, hint?: unknown }} */ (
    parse(result.stderr)
  );
  return { ...result, report };
}

for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
  await step(`${signal} during transcribe prints the resume token and exits 130`, async () => {
    const { status, stderr, report } = await interruptTranscribe(signal);
    expect(status === 130, `exit ${String(status)}; stderr: ${stderr}`);
    expect(report.code === "interrupted", `stderr: ${stderr}`);
    expect(typeof report.resumeToken === "string" && report.resumeToken !== "", "no resume token");
  });
}

await step(
  "a second signal during the wind-down prints the token and the key and exits 130",
  async () => {
    await mock("/__scenario", {
      mock: {
        account: { balance_seconds: 360_000 },
        jobFlow: [{ state: "processing", untilClock: 200 }, { state: "done" }],
      },
    });
    // The preload delays AbortController.abort() by a minute, so the first signal's wind-down never ends
    // inside the test and only the second signal's own path can produce the report.
    const preload = fileURLToPath(new URL("slow-abort.mjs", import.meta.url));
    const env = { ...childEnv, NODE_OPTIONS: `--import=${preload}` };
    const started = Date.now();
    const result = await signalled(
      ["transcribe", sample, "--json"],
      ["SIGINT", "SIGINT"],
      async () => {
        const state = /** @type {{ jobs: number }} */ (await mockJson("/__state"));
        return state.jobs > 0;
      },
      { env },
    );
    expect(result.before[0] === "", `the first signal alone printed: ${result.before[0] ?? ""}`);
    expect(result.status === 130, `exit ${String(result.status)}; stderr: ${result.stderr}`);
    expect(Date.now() - started < 30_000, "the exit waited for the abort");
    const lines = result.stderr.trimEnd().split("\n");
    expect(lines.length === 1, `stderr: ${result.stderr}`);
    const report =
      /** @type {{ code?: unknown, resumeToken?: unknown, idempotencyKey?: unknown, hint?: unknown }} */ (
        parse(lines[0] ?? "")
      );
    expect(report.code === "interrupted", `stderr: ${result.stderr}`);
    expect(typeof report.resumeToken === "string" && report.resumeToken !== "", "no resume token");
    expect(
      typeof report.idempotencyKey === "string" && report.idempotencyKey !== "",
      `no idempotency key: ${result.stderr}`,
    );
    expect(
      typeof report.hint === "string" &&
        report.hint.includes(`hushscript resume ${String(report.resumeToken)} `),
      `no resume command: ${result.stderr}`,
    );
  },
);

await step("resume finishes an interrupted transcribe and prints the golden", async () => {
  const { status, stderr, report } = await interruptTranscribe("SIGINT");
  expect(status === 130, `exit ${String(status)}; stderr: ${stderr}`);
  const token = String(report.resumeToken);
  expect(
    typeof report.hint === "string" && report.hint.includes(`hushscript resume ${token} `),
    `the hint does not name the resume command: ${stderr}`,
  );
  await mock("/__clock", { advance: 300 });
  const result = cli(["resume", token, sample, "--format", "srt"], { env: withToken });
  expectStatus(result, 0);
  expect(
    result.stdout === golden,
    "stdout differs from fixtures/exports/one-speaker.srt-captions.srt",
  );
  expect(result.stderr === "", `stderr is not empty: ${result.stderr}`);
});

/**
 * A fake API for `buy`: answers the card lookup unless it is told to hold it, and always holds the purchase,
 * so the CLI is mid-purchase (or mid-lookup) when the signal lands.
 * @param {"lookup" | "purchase"} hold
 */
async function buyServer(hold) {
  /** @type {{ key: string | null, lookups: number }} */
  const seen = { key: null, lookups: 0 };
  const card = {
    id: "pm_1",
    type: "card",
    brand: "visa",
    last4: "4242",
    exp_month: 1,
    exp_year: 2099,
    email: null,
    is_default: true,
    fast_checkout_eligible: true,
  };
  const server = createServer((request, response) => {
    if (request.method === "GET") {
      seen.lookups += 1;
      if (hold === "lookup") return;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ default_id: "pm_1", methods: [card] }));
      return;
    }
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      seen.key = String(/** @type {{ idempotency_key?: unknown }} */ (parse(body)).idempotency_key);
    });
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(undefined);
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, seen, baseUrl: `http://127.0.0.1:${String(port)}` };
}

for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
  for (const hold of /** @type {const} */ (["lookup", "purchase"])) {
    await step(`${signal} while buy holds the ${hold} prints the key to retry with`, async () => {
      const { server, seen, baseUrl } = await buyServer(hold);
      try {
        const key = `e2e-key-${hold}`;
        const { status, stderr } = await signalled(
          ["buy", "300min", "--yes", "--key", key, "--json"],
          [signal],
          () => Promise.resolve(hold === "lookup" ? seen.lookups > 0 : seen.key !== null),
          { env: { ...childEnv, HUSHSCRIPT_BASE_URL: baseUrl } },
        );
        expect(status === 130, `exit ${String(status)}; stderr: ${stderr}`);
        const last = stderr.trimEnd().split("\n").at(-1) ?? "";
        const report =
          /** @type {{ type?: unknown, code?: unknown, idempotencyKey?: unknown, hint?: unknown }} */ (
            parse(last)
          );
        expect(report.type === "error" && report.code === "interrupted", `stderr: ${stderr}`);
        expect(report.idempotencyKey === key, `printed key ${String(report.idempotencyKey)}`);
        expect(
          report.hint ===
            `The purchase may have been sent. Retry with --key ${key}: the same key never charges twice.`,
          `stderr: ${stderr}`,
        );
        if (hold === "purchase") expect(seen.key === key, `sent key ${String(seen.key)}`);
        else expect(seen.key === null, "a purchase was sent");
      } finally {
        server.closeAllConnections();
        server.close();
      }
    });
  }
}

for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
  await step(`${signal} outside any request exits 130 with nothing printed`, async () => {
    // `login` waits on a stdin pipe that is never written to: nothing was sent and no interrupt window is open.
    const { status, killedBy, stdout, stderr } = await signalled(
      ["login", "--json"],
      [signal],
      () => Promise.resolve(true),
      { stdin: "pipe" },
    );
    expect(
      status === 130,
      `exit ${String(status)} (killed by ${String(killedBy)}); stderr: ${stderr}`,
    );
    expect(stdout === "" && stderr === "", `output: ${stdout} / ${stderr}`);
  });
}

await step("every stderr line under --json is JSON, the error object last", async () => {
  await freshMock();
  const buy = cli(["buy", "300min", "--yes", "--json"], { env: withToken });
  expectStatus(buy, 0);
  const noToken = cli(["balance", "--json"]);
  const usage = cli(["transcript", "tr_1", "--format", "docx", "--json"], { env: withToken });
  const login = cli(["login", "--token", TOKEN, "--json"]);
  expectStatus(login, 0);
  expectStatus(cli(["logout"]), 0);
  /** @type {[string, string, string[]][]} */
  const cases = [
    ["buy --yes", buy.stderr, ["notice"]],
    ["no token", noToken.stderr, ["error"]],
    ["usage error", usage.stderr, ["error"]],
    ["login --token", login.stderr, ["warning"]],
  ];
  for (const [name, stderr, expected] of cases) {
    const types = stderr
      .trimEnd()
      .split("\n")
      .map((line) => String(/** @type {{ type?: unknown }} */ (parse(line)).type));
    expect(
      types.join() === expected.join(),
      `${name}: stderr types ${types.join()}, wanted ${expected.join()}: ${stderr}`,
    );
  }
  const version = cli(["--version", "--json"]);
  expectStatus(version, 0);
  expect(
    /** @type {{ version?: unknown }} */ (parse(version.stdout)).version !== undefined &&
      version.stderr === "",
    `--version --json: ${version.stdout}`,
  );
  const help = cli(["--help", "--json"]);
  expectStatus(help, 0);
  expect(
    typeof (/** @type {{ help?: unknown }} */ (parse(help.stdout)).help) === "string" &&
      help.stderr === "",
    `--help --json: ${help.stdout}`,
  );
});

await step("usage errors exit 2", () => {
  expectStatus(cli(["transcript", "tr_1", "--format", "docx"], { env: withToken }), 2);
  expectStatus(cli(["frobnicate"]), 2);
});

process.exitCode = outcome.failed ? 1 : 0;
