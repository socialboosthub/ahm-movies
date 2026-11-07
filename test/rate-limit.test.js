const test = require("node:test");
const assert = require("node:assert/strict");
const app = require("../server");

let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

test("video generation endpoint rate-limits repeated jobs from one IP", async () => {
  const send = () => fetch(baseUrl + "/api/explainer/video", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": "203.0.113.77",
    },
    body: JSON.stringify({ story: null }),
  });
  for (let index = 0; index < 3; index++) {
    const response = await send();
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.match(body.error, /AI Director plan/);
  }

  const limited = await send();
  const limitedBody = await limited.json();
  assert.equal(limited.status, 429);
  assert.match(limitedBody.error, /too many requests/);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
});
