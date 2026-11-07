const https = require("https");

function requestJSON(url, headers, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request({ hostname: target.hostname, path: target.pathname + target.search, method: "POST", headers: { "Content-Type": "application/json", ...headers } }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { const error = new Error("Gemini returned an unreadable response."); error.statusCode = res.statusCode || 502; return reject(error); }
        if (res.statusCode >= 400) { const error = new Error(parsed.error?.message || `Gemini TTS failed (HTTP ${res.statusCode}).`); error.statusCode = res.statusCode; return reject(error); }
        resolve(parsed);
      });
    });
    req.on("error", reject);
    req.setTimeout(90000, () => req.destroy(new Error("AI voice generation timed out. Please try again.")));
    req.write(JSON.stringify(body)); req.end();
  });
}

const ALLOWED_VOICES = new Set(["Kore", "Puck", "Charon", "Aoede", "Fenrir", "Zephyr", "Leda", "Orus"]);

function pcmToWav(pcm, sampleRate = 24000, channels = 1) {
  const header = Buffer.alloc(44), byteRate = sampleRate * channels * 2;
  header.write("RIFF",0); header.writeUInt32LE(36 + pcm.length,4); header.write("WAVE",8);
  header.write("fmt ",12); header.writeUInt32LE(16,16); header.writeUInt16LE(1,20); header.writeUInt16LE(channels,22);
  header.writeUInt32LE(sampleRate,24); header.writeUInt32LE(byteRate,28); header.writeUInt16LE(channels*2,32); header.writeUInt16LE(16,34);
  header.write("data",36); header.writeUInt32LE(pcm.length,40);
  return Buffer.concat([header,pcm]);
}

async function generateFreeVoiceover({ text, voice = "Kore", style }) {
  const transcript = String(text || "").trim();
  if (!transcript) throw new Error("There is no narration text to speak.");
  if (transcript.length > 9000) throw new Error("Narration is too long for one free voice request. Shorten the story and try again.");
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) { const error = new Error("Free AI narration needs GEMINI_API_KEY configured on the server."); error.code = "VOICE_PROVIDER_NOT_CONFIGURED"; throw error; }
  const selectedVoice = ALLOWED_VOICES.has(voice) ? voice : "Kore";
  const model = process.env.GEMINI_FREE_TTS_MODEL || "gemini-2.5-flash-preview-tts";
  const direction = String(style || "Expressive, natural cinematic narration with clear diction and emotional emphasis.").slice(0,300);
  const result = await requestJSON(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {}, {
    contents: [{ role: "user", parts: [{ text: `Read the following story aloud. Voice direction: ${direction}\n\n${transcript}` }] }],
    generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } } } }
  });
  const parts = (result.candidates || []).flatMap(candidate => candidate.content?.parts || []).filter(part => part.inlineData?.data);
  if (!parts.length) {
    const reason = result.promptFeedback?.blockReason || result.candidates?.[0]?.finishReason;
    throw new Error(reason ? `Gemini did not generate narration (${reason}).` : "Gemini returned no audio. Check that the API key has Gemini API access and that the TTS model is available.");
  }
  const pcm = Buffer.concat(parts.map(part => Buffer.from(part.inlineData.data,"base64")));
  if (pcm.length < 1000) throw new Error("Gemini returned an empty or incomplete voice recording. Please retry.");
  const wav = pcmToWav(pcm,24000,1);
  return { audioBase64:wav.toString("base64"), mimeType:"audio/wav", model, sampleRate:24000, durationSeconds:pcm.length/48000 };
}

module.exports = { generateFreeVoiceover };