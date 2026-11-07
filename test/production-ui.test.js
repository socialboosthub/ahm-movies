const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("AI Director polls Gemini background plans and the primary render action uses the full worker", () => {
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  assert.match(source, /fetch\("\/api\/explainer\/plan\/" \+ encodeURIComponent\(started\.jobId\)\)/);
  assert.match(source, /const fullVideoReady = videoStatus\?\.status === "ready"/);
  assert.match(source, /\$\("renderBtn"\)\.disabled = !fullVideoReady/);
  assert.match(source, /\$\("renderBtn"\)\.addEventListener\("click", \(\) => \{[\s\S]*?generateFullVideo\(\);/);
  assert.doesNotMatch(source, /Render free sample video/);
  assert.doesNotMatch(source, /\$\("renderBtn"\)\.addEventListener\("click", \(\) => \{\s*\/\/ Free-first sample path[\s\S]*?renderVideo\(\);/);
});
