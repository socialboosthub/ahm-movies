const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeStoryPackage } = require("../lib/providers/llm");

test("Director normalizes scene timing to a continuous timeline", () => {
  const story = normalizeStoryPackage({
    title: "The Secret Beneath the Lake",
    durationSec: 60,
    narration: "A short story.",
    scenes: [
      { narration: "Noah found a strange key beneath the lake." },
      { narration: "He unlocked the old door and freed the shadows." },
      { narration: "His own shadow returned at the end." }
    ]
  });
  assert.equal(story.scenes[0].start, 0);
  assert.equal(story.scenes.at(-1).end, 60);
  for (let i = 0; i < story.scenes.length - 1; i++) {
    assert.equal(story.scenes[i].end, story.scenes[i + 1].start);
    assert.ok(story.scenes[i].durationSec > 0);
  }
});

test("Director creates short subtitle phrases without changing narration words", () => {
  const source = "Noah sold his shadow. His mother could no longer recognize him!";
  const story = normalizeStoryPackage({
    title: "The Shadow",
    durationSec: 40,
    narration: source,
    scenes: [{ narration: source }]
  });
  const phrases = story.scenes[0].subtitlePhrases;
  assert.ok(phrases.length > 1);
  assert.equal(phrases.join(" "), source);
});

test("Director clamps invalid duration to the supported 30–120 second range", () => {
  const story = normalizeStoryPackage({
    title: "Test",
    durationSec: 500,
    scenes: [{ narration: "One scene." }]
  });
  assert.equal(story.durationSec, 120);
  assert.equal(story.scenes[0].end, 120);
});


test("Director repairs dialogue split across scene boundaries", () => {
  const story = normalizeStoryPackage({
    title: "The Boy Who Sold His Shadow",
    durationSec: 60,
    scenes: [
      { narration: "This time, when his mother opened the door, she immediately recognized him. “My son!" },
      { narration: "” she cried, hugging him tightly." },
      { narration: "Noah held her close and whispered: “Mother, I learned something. Some things are worth more than all the gold in the world." },
      { narration: "”" }
    ]
  });
  assert.equal(story.scenes.length, 2);
  assert.equal(story.scenes[0].narration, "This time, when his mother opened the door, she immediately recognized him. “My son! ” she cried, hugging him tightly.");
  assert.match(story.scenes[1].narration, /all the gold in the world\.”$/);
  assert.ok(story.scenes.every(scene => scene.narration.trim().length > 1));
});

test("Director never leaves a punctuation-only scene", () => {
  const story = normalizeStoryPackage({
    title: "Test",
    durationSec: 30,
    scenes: [
      { narration: "He ran home." },
      { narration: "”" }
    ]
  });
  assert.equal(story.scenes.length, 1);
  assert.equal(story.scenes[0].narration, "He ran home.");
});


test("Director preserves a complete spoken quotation when Gemini splits it", () => {
  const story = normalizeStoryPackage({
    title: "The Boy Who Sold His Shadow",
    durationSec: 45,
    scenes: [
      { narration: "Noah held his mother close and whispered: “Mother, I learned something." },
      { narration: "Some things are worth more than all the gold in the world.”" }
    ]
  });
  assert.equal(story.scenes.length, 1);
  assert.match(story.scenes[0].narration, /^Noah held/);
  assert.match(story.scenes[0].narration, /world.”$/);
});

test("Director subtitle splitting counts real words and preserves the original text", () => {
  const { splitSubtitlePhrases } = require("../lib/providers/llm");
  const source = "Noah ran home. His mother opened the door.";
  const phrases = splitSubtitlePhrases(source);
  assert.ok(phrases.length >= 2);
  assert.equal(phrases.join(" "), source);
});


test("Director preserves dialogue-led scenes without turning visual actions into narration", () => {
  const story = normalizeStoryPackage({
    title: "The Missing Letter",
    contentMode: "story",
    durationSec: 30,
    scenes: [{
      action: "Mara opens the old wooden door and freezes.",
      narration: "",
      dialogue: [{ character: "mara", line: "You came back." }]
    }]
  });
  assert.equal(story.contentMode, "story");
  assert.equal(story.scenes.length, 1);
  assert.equal(story.scenes[0].narration, "");
  assert.equal(story.scenes[0].action, "Mara opens the old wooden door and freezes.");
  assert.equal(story.scenes[0].dialogue[0].line, "You came back.");
});
