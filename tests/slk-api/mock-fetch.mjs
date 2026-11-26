// Test-only preload (node --import). Sends Slack API calls to the local mock server.
// The shipped CLI has no destination override, so this lives only in the test harness.
const port = process.env.SLK_TEST_MOCK_PORT;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const target = String(url).replace("https://slack.com", `http://127.0.0.1:${port}`);
  return realFetch(target, init);
};
