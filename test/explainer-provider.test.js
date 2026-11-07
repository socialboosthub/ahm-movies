const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const { EventEmitter } = require("node:events");
const { startExplainerGeneration } = require("../lib/providers/llm");

test("explainer starts the existing Gemini background Interactions workflow", async () => {
  const originalRequest = https.request;
  const originalKey = process.env.GEMINI_API_KEY;
  const originalModel = process.env.GEMINI_MODEL;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_MODEL = "gemini-3.8-flash";
  let optionsSeen;
  let body = "";

  https.request = (options, onResponse) => {
    optionsSeen = options;
    const req = new EventEmitter();
    req.write = chunk => { body += chunk; };
    req.setTimeout = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      onResponse(res);
      queueMicrotask(() => {
        res.emit("data", Buffer.from(JSON.stringify({ id: "v1_background123", status: "in_progress" })));
        res.emit("end");
      });
    };
    return req;
  };

  try {
    const result = await startExplainerGeneration("How light travels", "natural", [
      { name: "Professor Nova", description: "Silver glasses, navy coat." }
    ]);
    assert.deepEqual(result, { id: "v1_background123", status: "in_progress", model: "gemini-3.8-flash" });
    assert.equal(optionsSeen.method, "POST");
    assert.match(optionsSeen.path, /v1beta\/interactions$/);
    assert.equal(optionsSeen.headers["Api-Revision"], "2026-05-20");
    const sent = JSON.parse(body);
    assert.equal(sent.model, "gemini-3.8-flash");
    assert.equal(sent.background, true);
    assert.match(sent.input, /How light travels/);
    assert.match(sent.input, /Professor Nova/);
    assert.match(sent.input, /Follow the MODE SELECTION rules above/);
    assert.doesNotMatch(sent.input, /Create an explanatory video plan, not a fictional story/);
  } finally {
    https.request = originalRequest;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = originalModel;
  }
});


test("explainer falls back when the configured Gemini model is unavailable", async () => {
  const originalRequest = https.request;
  const originalKey = process.env.GEMINI_API_KEY;
  const originalModel = process.env.GEMINI_MODEL;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_MODEL = "gemini-obsolete-model";
  const models = [];

  https.request = (options, onResponse) => {
    const req = new EventEmitter();
    req.write = chunk => {
      const body = JSON.parse(String(chunk));
      models.push(body.model);
    };
    req.setTimeout = () => {};
    req.end = () => {
      const res = new EventEmitter();
      const attempt = models.length;
      res.statusCode = attempt === 1 ? 404 : 200;
      onResponse(res);
      queueMicrotask(() => {
        const payload = attempt === 1
          ? { error: { message: "Model not found" } }
          : { id: "v1_fallback123", status: "in_progress" };
        res.emit("data", Buffer.from(JSON.stringify(payload)));
        res.emit("end");
      });
    };
    return req;
  };

  try {
    const result = await startExplainerGeneration("Why do stars shine?");
    assert.equal(result.id, "v1_fallback123");
    assert.deepEqual(models, ["gemini-obsolete-model", "gemini-3.6-flash"]);
  } finally {
    https.request = originalRequest;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = originalModel;
  }
});
