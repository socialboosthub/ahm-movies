const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const { EventEmitter } = require("node:events");
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

test("explainer API starts Gemini background planning and returns the completed plan when polled", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousModel = process.env.GEMINI_MODEL;
  process.env.GEMINI_API_KEY = "gemini-test";
  process.env.GEMINI_MODEL = "gemini-3.8-flash";

  const originalRequest = https.request;
  let sentBody = "";
  let sentOptions;
  https.request = (options, callback) => {
    sentOptions = options;
    const req = new EventEmitter();
    req.write = chunk => { sentBody += chunk; };
    req.setTimeout = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      callback(res);
      const story = {
        title: "The Speed of Light",
        topic: "Speed of light",
        durationSec: 45,
        narration: "Light travels at an extraordinary speed.",
        scenes: [
          { start: 0, end: 45, narration: "Light travels at an extraordinary speed.", action: "A beam of light races through space.", visualPrompt: "A luminous beam in a dark space laboratory.", subtitlePhrases: ["Light travels at an extraordinary", "speed."] }
        ],
        characters: [
          { id: "char_1", name: "Professor Nova", description: "Silver glasses and a navy coat." }
        ],
      };
      const payload = options.method === "POST"
        ? { id: "v1_testjob123", status: "in_progress" }
        : {
            id: "v1_testjob123",
            status: "completed",
            steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(story) }] }]
          };
      queueMicrotask(() => {
        res.emit("data", Buffer.from(JSON.stringify(payload)));
        res.emit("end");
      });
    };
    return req;
  };

  try {
    const response = await fetch(baseUrl + "/api/explainer/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: "Speed of light",
        characterReferences: [
          { name: "Professor Nova", description: "Silver glasses, navy coat, curly black hair." }
        ],
      }),
    });
    const started = await response.json();
    assert.equal(response.status, 202);
    assert.equal(started.ok, true);
    assert.equal(started.status, "in_progress");
    assert.equal(started.jobId, "v1_testjob123");
    assert.equal(sentOptions.method, "POST");
    assert.match(sentOptions.path, /v1beta\/interactions$/);
    assert.equal(sentOptions.headers["Api-Revision"], "2026-05-20");
    const sent = JSON.parse(sentBody);
    assert.equal(sent.model, "gemini-3.8-flash");
    assert.equal(sent.background, true);
    assert.match(sent.input, /Speed of light/);
    assert.match(sent.input, /Professor Nova/);
    assert.match(sent.input, /Silver glasses, navy coat, curly black hair/);

    const completedResponse = await fetch(baseUrl + "/api/explainer/plan/" + started.jobId);
    const completed = await completedResponse.json();
    assert.equal(completedResponse.status, 200);
    assert.equal(completed.status, "completed");
    assert.equal(completed.story.scenes.length, 1);
    assert.deepEqual(completed.story.scenes[0].subtitlePhrases, ["Light travels at an extraordinary", "speed."]);
    assert.equal(completed.video.status, "not_configured");
  } finally {
    https.request = originalRequest;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = previousModel;
  }
});
