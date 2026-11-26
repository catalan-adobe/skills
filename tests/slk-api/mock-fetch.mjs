// Test-only preload (node --import). Sends Slack API calls to the local mock server.
// It also shortens the deadline the CLI itself asks for through AbortSignal.timeout(), and it
// refuses a request that has no deadline or an absurdly long one. Removing or breaking the CLI's
// own deadline therefore fails the tests, instead of being hidden by a deadline set here.
const port = process.env.SLK_TEST_MOCK_PORT;
const testMs = Number(process.env.SLK_TEST_TIMEOUT_MS);
const MAX_SANE_MS = 60_000;

const requested = [];
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms) => {
  requested.push(ms);
  return realTimeout(testMs ? Math.min(ms, testMs) : ms);
};

const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  if (!init?.signal || requested.length === 0 || requested.some((ms) => ms > MAX_SANE_MS)) {
    return Promise.reject(new TypeError("test harness: the CLI sent a request without a sane deadline"));
  }
  return realFetch(String(url).replace("https://slack.com", `http://127.0.0.1:${port}`), init);
};
