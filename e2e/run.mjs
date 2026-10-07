// Runs the built binary (dist/index.js) against the conformance mock this container shares a network with.
// The mock accepts any bearer token that starts with "hsr" and serves the one-speaker transcript for a finished job.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

await step("Ctrl-C during transcribe prints the resume token and exits 130", async () => {
  await mock("/__scenario", {
    mock: { account: { balance_seconds: 360_000 }, jobFlow: [{ state: "processing" }] },
  });
  const child = spawn(process.execPath, [BIN, "transcribe", sample, "--json"], {
    env: {
      PATH: process.env["PATH"] ?? "",
      XDG_CONFIG_HOME: join(WORK, "config"),
      HUSHSCRIPT_BASE_URL: BASE_URL,
      HUSHSCRIPT_TOKEN: TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  /** @type {Promise<number | null>} */
  const exit = new Promise((resolve) => child.on("close", resolve));
  // Wait until the job exists and the CLI is polling it, then interrupt.
  for (let waited = 0; waited < 60_000; waited += 200) {
    const state = /** @type {{ jobs: number }} */ (await mockJson("/__state"));
    if (state.jobs > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  child.kill("SIGINT");
  const status = await exit;
  expect(status === 130, `exit ${String(status)}; stderr: ${stderr}`);
  const report = /** @type {{ code?: unknown, resumeToken?: unknown }} */ (parse(stderr));
  expect(report.code === "interrupted", `stderr: ${stderr}`);
  expect(typeof report.resumeToken === "string" && report.resumeToken !== "", "no resume token");
});

await step("usage errors exit 2", () => {
  expectStatus(cli(["transcript", "tr_1", "--format", "docx"], { env: withToken }), 2);
  expectStatus(cli(["frobnicate"]), 2);
});

process.exitCode = outcome.failed ? 1 : 0;
