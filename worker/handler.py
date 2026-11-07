import os
import json
import time
import uuid
import base64
import subprocess
import urllib.request
import urllib.error
import tempfile
import re
from pathlib import Path

API_BASE = "https://generativelanguage.googleapis.com/v1beta"
VIDEO_MODEL = os.getenv("GEMINI_VIDEO_MODEL", "gemini-omni-1.1-flash")
TTS_MODEL = os.getenv("GEMINI_TTS_MODEL", "gemini-3.8-flash-tts")
TTS_FALLBACK_MODEL = os.getenv("GEMINI_TTS_FALLBACK_MODEL", "gemini-3.8-flash-lite-tts")
TTS_VOICE = os.getenv("GEMINI_TTS_VOICE", "Charon")
MUSIC_MODEL = os.getenv("LYRIA_MODEL", "lyria-3.5")
OUTPUT_DIR = Path(os.getenv("AHM_OUTPUT_DIR", "/tmp/ahm-output"))
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def log(message):
    print(f"[AHM] {message}", flush=True)


def api_request(path, method="GET", payload=None, timeout=900, raw=False):
    key = os.getenv("GEMINI_API_KEY", "")
    if not key:
        raise RuntimeError("GEMINI_API_KEY is missing in the RunPod worker environment.")
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request_url = path if path.startswith("https://") else API_BASE + path
    headers = {
        "x-goog-api-key": key,
        "Content-Type": "application/json",
    }
    # Interactions requests require the revision header; GenerateContent does not.
    if "/interactions" in request_url:
        headers["Api-Revision"] = "2026-05-20"
    request = urllib.request.Request(
        request_url,
        data=body,
        method=method,
        headers=headers,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = response.read()
            return data if raw else json.loads(data.decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(detail)
            detail = parsed.get("error", {}).get("message", detail)
        except Exception:
            pass
        raise RuntimeError(f"Gemini API HTTP {error.code}: {detail}") from error


def media_blocks(interaction, media_type):
    blocks = []
    for step in interaction.get("steps", []):
        if step.get("type") != "model_output":
            continue
        for block in step.get("content", []):
            if block.get("type") == media_type:
                blocks.append(block)
    return blocks


def wait_for_interaction(interaction, timeout=1200):
    if interaction.get("status") == "failed":
        raise RuntimeError("Gemini generation failed: " + json.dumps(interaction.get("errors", []))[:1000])
    if interaction.get("status") == "completed":
        return interaction
    interaction_id = interaction.get("id")
    if not interaction_id:
        raise RuntimeError("Gemini did not return an interaction ID or completed output.")
    started = time.time()
    while time.time() - started < timeout:
        time.sleep(8)
        interaction = api_request("/interactions/" + interaction_id)
        status = interaction.get("status")
        log(f"Gemini interaction {interaction_id}: {status}")
        if status == "completed":
            return interaction
        if status == "failed":
            raise RuntimeError("Gemini generation failed: " + json.dumps(interaction.get("errors", []))[:1000])
    raise TimeoutError("Gemini media generation timed out.")


def decode_media_block(block, destination):
    data = block.get("data")
    if data:
        Path(destination).write_bytes(base64.b64decode(data))
        return destination
    uri = block.get("uri")
    if uri:
        raw = api_request(uri, raw=True, timeout=900)
        Path(destination).write_bytes(raw)
        return destination
    raise RuntimeError("Gemini returned a media block without data or URI.")


def scene_duration(scene):
    try:
        value = float(scene.get("durationSec") or (float(scene.get("end", 0)) - float(scene.get("start", 0))))
    except (TypeError, ValueError):
        value = 6.0
    return max(1.0, min(10.0, value))


def _spoken_units(text):
    text = str(text or "").strip()
    if not text:
        return []
    units = [part.strip() for part in re.split(r"(?<=[.!?])\s+", text) if part.strip()]
    if len(units) == 1:
        words = units[0].split()
        if len(words) > 12:
            units = [" ".join(words[index:index + 12]) for index in range(0, len(words), 12)]
    return units or [text]


def _distribute_units(units, durations):
    buckets = [[] for _ in durations]
    if not units:
        return buckets
    weights = [
        max(1, len(str((unit.get("line") or unit.get("text") or "") if isinstance(unit, dict) else unit).split()))
        for unit in units
    ]
    total_words = sum(weights)
    total_duration = sum(durations)
    elapsed_words = 0
    elapsed_time = 0.0
    boundaries = []
    for duration in durations:
        elapsed_time += duration
        boundaries.append(elapsed_time)
    for unit, weight in zip(units, weights):
        midpoint = (elapsed_words + weight / 2) / total_words * total_duration
        bucket = next((index for index, boundary in enumerate(boundaries) if midpoint <= boundary), len(durations) - 1)
        buckets[bucket].append(unit)
        elapsed_words += weight
    return buckets


def expand_scene_segments(scenes):
    segments = []
    for scene in scenes:
        try:
            total = max(1.0, float(scene.get("durationSec") or (float(scene.get("end", 0)) - float(scene.get("start", 0)))))
        except (TypeError, ValueError):
            total = 6.0
        try:
            scene_start = float(scene.get("start", 0) or 0)
        except (TypeError, ValueError):
            scene_start = 0.0

        durations = []
        remaining = total
        while remaining > 0.01:
            length = min(10.0, remaining)
            durations.append(length)
            remaining -= length

        narration_units = _spoken_units(scene.get("narration", ""))
        dialogue = scene.get("dialogue") or []
        if isinstance(dialogue, dict):
            dialogue = [dialogue]
        dialogue_units = [line for line in dialogue if isinstance(line, dict)] if isinstance(dialogue, list) else []
        explicit_subtitles = scene.get("subtitlePhrases") or []
        subtitle_units = [str(value) for value in explicit_subtitles if str(value).strip()] if isinstance(explicit_subtitles, list) else []

        narration_parts = _distribute_units(narration_units, durations)
        dialogue_parts = _distribute_units(dialogue_units, durations)
        subtitle_parts = _distribute_units(subtitle_units, durations) if subtitle_units else [[] for _ in durations]

        elapsed = 0.0
        for part, length in enumerate(durations):
            segment = dict(scene)
            segment["durationSec"] = length
            segment["start"] = scene_start + elapsed
            segment["end"] = scene_start + elapsed + length
            segment["narration"] = " ".join(narration_parts[part])
            segment["dialogue"] = dialogue_parts[part]
            if explicit_subtitles:
                segment["subtitlePhrases"] = subtitle_parts[part]
            segment["segmentIndex"] = part
            if part:
                segment["action"] = str(scene.get("action", "")) + " Continue the same action naturally from the previous segment; do not restart or change the subject."
            segments.append(segment)
            elapsed += length
    return segments


def scene_prompt(story, scene, index, total):
    character_ids = set(scene.get("characters") or [])
    prop_ids = set(scene.get("props") or [])
    environment_id = scene.get("environment")
    cast = "\n".join(
        f"{item.get('name', 'Character')}: {item.get('description', '')}"
        for item in story.get("characters", [])
        if not character_ids or item.get("id") in character_ids
    )
    environments = "\n".join(
        f"{item.get('name', 'Environment')}: {item.get('description', '')}"
        for item in story.get("environments", [])
        if not environment_id or item.get("id") == environment_id
    )
    props = "\n".join(
        f"{item.get('name', 'Prop')}: {item.get('description', '')}"
        for item in story.get("props", [])
        if not prop_ids or item.get("id") in prop_ids
    )
    return f"""
Create one self-contained {scene_duration(scene):.0f}-second vertical 9:16 cinematic 3D animated video clip.
This is scene {index + 1} of {total} in the same complete AHM Studio explainer.
VISUAL STYLE: polished stylized-realistic 3D cinema, expressive subject animation, premium materials,
dramatic motivated lighting, dimensional environments, strong composition, crisp detail and dynamic camera.
TOPIC: {story.get('topic') or story.get('title', '')}
SCENE ACTION: {scene.get('action', '')}
VISUAL DIRECTION: {scene.get('visualPrompt', '')}
CAMERA: {scene.get('camera') or scene.get('shot', '')}
EMOTION: {scene.get('emotion', '')}
ENVIRONMENT CONTINUITY:
{environments}
CHARACTER CONTINUITY:
{cast}
PROP CONTINUITY:
{props}
SOUND: create appropriate synchronized environmental ambience and precise sound effects for this action.
Do not add narration, spoken dialogue, background music, subtitles, captions, labels, logos or watermarks.
Do not introduce unrelated scenes or montage. One coherent continuous shot with clear visible action.
Maintain the exact recurring character designs, props, lighting logic and world continuity described above.
"""


def build_video_input(prompt, reference_images=None):
    paths = list(reference_images or [])[:3]
    if not paths:
        return prompt
    content = []
    for path in paths:
        content.append({
            "type": "image",
            "mime_type": "image/jpeg",
            "data": base64.b64encode(Path(path).read_bytes()).decode("ascii"),
        })
    references = " ".join(
        f"<IMAGE_REF_{index}>@Image{index + 1}" for index in range(len(paths))
    )
    content.append({
        "type": "text",
        "text": (
            f"[# References {references}]\n" + prompt +
            "\n\nUse the supplied image(s) as visual identity references for returning characters. "
            "Preserve facial features, hair, clothing, proportions and distinctive marks. "
            "Do not copy the reference pose, framing or background."
        ),
    })
    return content


def extract_character_reference_frame(video_path, destination):
    run_ffmpeg([
        "ffmpeg", "-y", "-ss", "1", "-i", str(video_path),
        "-frames:v", "1", "-vf", "scale=512:-1", "-q:v", "4", str(destination),
    ])
    return destination


def build_video_generation_request(story, scene, index, total, reference_images=None):
    prompt = scene_prompt(story, scene, index, total)
    paths = list(reference_images or [])[:3]
    requested_duration = max(3, min(10, int(scene_duration(scene) + 0.999)))
    return {
        "model": VIDEO_MODEL,
        "input": build_video_input(prompt, paths),
        "generation_config": {
            "video_config": {
                "task": "reference_to_video" if paths else "text_to_video",
            }
        },
        "response_format": {
            "type": "video",
            "aspect_ratio": "9:16",
            "resolution": "720p",
            "duration": f"{requested_duration}s",
            "delivery": "uri",
        },
    }


def generate_video_clip(story, scene, index, total, destination, reference_images=None):
    request = build_video_generation_request(story, scene, index, total, reference_images)
    result = api_request("/interactions", "POST", request, timeout=1200)
    result = wait_for_interaction(result, timeout=1200)
    blocks = media_blocks(result, "video")
    if not blocks:
        raise RuntimeError(f"Scene {index + 1}: Gemini completed without a video output.")
    return decode_media_block(blocks[-1], destination)


def audio_block_data(interaction):
    output_audio = interaction.get("output_audio")
    if isinstance(output_audio, dict) and output_audio.get("data"):
        data = base64.b64decode(output_audio["data"])
        if data:
            return data
    blocks = media_blocks(interaction, "audio")
    for block in reversed(blocks):
        encoded = block.get("data")
        if encoded:
            data = base64.b64decode(encoded)
            if data:
                return data
    raise RuntimeError("Gemini returned no audio data.")


def build_tts_request(story, narrator_voice=None):
    characters = {str(item.get("id")): item for item in story.get("characters", []) if item.get("id")}
    turns = []
    for scene in story.get("scenes", []):
        narration = str(scene.get("narration") or "").strip()
        if narration:
            turns.append({"speaker": "Narrator", "text": narration, "style": "warm, confident documentary narration with clear diction"})
        dialogue = scene.get("dialogue") or []
        if isinstance(dialogue, dict):
            dialogue = [dialogue]
        for line in dialogue if isinstance(dialogue, list) else []:
            if not isinstance(line, dict):
                continue
            character_id = str(line.get("character") or line.get("speaker") or "")
            character = characters.get(character_id, {})
            speaker = str(character.get("name") or line.get("speaker") or character_id or "Character")
            spoken = str(line.get("line") or line.get("text") or "").strip()
            if spoken:
                turns.append({"speaker": speaker, "text": spoken, "style": "natural, expressive character dialogue"})
    if not turns:
        narration = str(story.get("narration") or "").strip()
        if narration:
            turns.append({"speaker": "Narrator", "text": narration, "style": "warm, confident documentary narration with clear diction"})
    if not turns:
        raise RuntimeError("The Director plan contains no spoken narration or dialogue.")

    speaker_order = list(dict.fromkeys(item["speaker"] for item in turns))
    voice_names = {"Charon", "Kore", "Puck", "Aoede", "Fenrir", "Zephyr", "Leda", "Orus"}

    def character_voice(name, fallback):
        item = next((value for value in story.get("characters", []) if value.get("name") == name), {})
        selected = item.get("voice")
        return selected if isinstance(selected, str) and selected in voice_names else fallback

    def voice_for(speaker):
        if speaker == "Narrator":
            selected = narrator_voice or TTS_VOICE
            return selected if selected in voice_names else TTS_VOICE
        return character_voice(speaker, "Puck")

    def single_speaker_request(turn):
        return {
            "input": [{
                "type": "user_input",
                "content": [{
                    "type": "text",
                    "text": turn["text"],
                    "annotations": [{"type": "speech_metadata", "style": turn["style"]}],
                }],
            }],
            "speech_config": [{"voice": voice_for(turn["speaker"])}],
        }

    if len(speaker_order) == 1:
        combined = dict(turns[0])
        combined["text"] = "\n\n".join(item["text"] for item in turns)
        return single_speaker_request(combined)

    # Gemini's multi-speaker TTS request supports two configured speakers.
    # For larger casts, synthesize each turn with its own voice and concatenate
    # the resulting WAVs in the original script order.
    if len(speaker_order) > 2:
        return {"segments": [single_speaker_request(turn) for turn in turns]}

    primary = "Narrator" if "Narrator" in speaker_order else speaker_order[0]
    secondary = next(name for name in speaker_order if name != primary)
    content = []
    for turn in turns:
        content.append({
            "type": "text",
            "text": turn["text"],
            "annotations": [{
                "type": "speech_metadata",
                "speaker": turn["speaker"],
                "style": turn["style"],
            }],
        })
    return {
        "input": [{"type": "user_input", "content": content}],
        "speech_config": {
            "speakers": [
                {"speaker": primary, "voice": voice_for(primary)},
                {"speaker": secondary, "voice": voice_for(secondary)},
            ]
        },
    }

def generate_tts_audio(request, destination):
    errors = []
    for model in [TTS_MODEL, TTS_FALLBACK_MODEL]:
        try:
            interaction = api_request("/interactions", "POST", {
                "model": model,
                "input": request["input"],
                "response_format": {"type": "audio"},
                "generation_config": {"speech_config": request["speech_config"]},
            }, timeout=300)
            interaction = wait_for_interaction(interaction, timeout=300)
            audio = audio_block_data(interaction)
            if audio[:4] == b"RIFF":
                Path(destination).write_bytes(audio)
            else:
                import wave
                with wave.open(str(destination), "wb") as wav:
                    wav.setnchannels(1)
                    wav.setsampwidth(2)
                    wav.setframerate(24000)
                    wav.writeframes(audio)
            return destination
        except Exception as error:
            errors.append(f"{model}: {error}")
            log(f"TTS model {model} failed: {error}")
    raise RuntimeError("Narration/dialogue generation failed. " + " | ".join(errors))


def scene_has_speech(scene):
    if str(scene.get("narration") or "").strip():
        return True
    dialogue = scene.get("dialogue") or []
    if isinstance(dialogue, dict):
        dialogue = [dialogue]
    return any(
        isinstance(line, dict) and str(line.get("line") or line.get("text") or "").strip()
        for line in dialogue
    ) if isinstance(dialogue, list) else False


def distribute_story_narration(story):
    scenes = story.get("scenes") or []
    narration = str(story.get("narration") or "").strip()
    if not scenes or not narration or any(scene_has_speech(scene) for scene in scenes):
        return
    sentences = [part.strip() for part in re.split(r"(?<=[.!?])\s+", narration) if part.strip()]
    if not sentences:
        sentences = [narration]
    chunks = [[] for _ in scenes]
    for index, sentence in enumerate(sentences):
        chunks[index % len(scenes)].append(sentence)
    for scene, chunk in zip(scenes, chunks):
        scene["narration"] = " ".join(chunk)


def concat_wav_files(paths, destination, work, filename):
    concat_file = Path(work) / filename
    concat_file.write_text("".join(f"file '{Path(path).as_posix()}'\n" for path in paths), encoding="utf-8")
    run_ffmpeg([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file),
        "-c", "copy", str(destination),
    ])
    return destination


def _tempo_filters(factor):
    factor = max(1.0, float(factor))
    filters = []
    while factor > 2.0:
        filters.append("atempo=2.0")
        factor /= 2.0
    filters.append(f"atempo={factor:.6f}")
    return filters


def _scene_speech_turns(scene):
    narration = str(scene.get("narration") or "").strip()
    phrases = scene.get("subtitlePhrases") or []
    phrases = [str(value).strip() for value in phrases if str(value).strip()] if isinstance(phrases, list) else []
    if narration:
        normalized_narration = re.sub(r"\s+", " ", narration).strip()
        normalized_phrases = re.sub(r"\s+", " ", " ".join(phrases)).strip()
        if not phrases or normalized_phrases != normalized_narration:
            phrases = _spoken_units(narration)
    turns = [{"speaker": "Narrator", "text": phrase, "style": "warm, confident documentary narration with clear diction"} for phrase in phrases]
    dialogue = scene.get("dialogue") or []
    if isinstance(dialogue, dict):
        dialogue = [dialogue]
    if isinstance(dialogue, list):
        for line in dialogue:
            if not isinstance(line, dict):
                continue
            text = str(line.get("line") or line.get("text") or "").strip()
            if text:
                turns.append({
                    "speaker": str(line.get("character") or line.get("speaker") or "Character"),
                    "text": text,
                    "style": "natural, expressive character dialogue",
                    "dialogue": line,
                })
    return turns


def write_tts_wav(story, destination, voice=None):
    scenes = story.get("scenes") or []
    work = Path(destination).parent
    if not scenes:
        request = build_tts_request(story, voice)
        if request.get("segments"):
            raw_parts = []
            for index, segment_request in enumerate(request["segments"]):
                raw = work / f"voice_turn_{index + 1:02}.wav"
                generate_tts_audio(segment_request, raw)
                raw_parts.append(raw)
                if index < len(request["segments"]) - 1:
                    silence = work / f"voice_pause_{index + 1:02}.wav"
                    run_ffmpeg(["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", "0.18", "-c:a", "pcm_s16le", str(silence)])
                    raw_parts.append(silence)
            return concat_wav_files(raw_parts, destination, work, "voice_turns.txt")
        return generate_tts_audio(request, destination)

    distribute_story_narration(story)
    voice_parts = []
    for scene_index, scene in enumerate(scenes):
        duration = scene_duration(scene)
        turns = _scene_speech_turns(scene)
        if not turns:
            fitted = work / f"voice_scene_{scene_index + 1:02}.wav"
            run_ffmpeg([
                "ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
                "-t", str(duration), "-c:a", "pcm_s16le", str(fitted),
            ])
            scene["speechDurationSec"] = 0
            scene["speechCues"] = []
            voice_parts.append(fitted)
            continue

        # Synthesize each subtitle phrase independently. Its real waveform
        # duration becomes the cue duration, eliminating word-count timing guesses.
        raw_phrases = []
        phrase_durations = []
        for phrase_index, turn in enumerate(turns):
            if turn["speaker"] == "Narrator":
                mini_scene = {"narration": turn["text"], "dialogue": []}
            else:
                mini_scene = {"narration": "", "dialogue": [turn.get("dialogue") or {
                    "character": turn["speaker"], "line": turn["text"]
                }]}
            mini_story = dict(story)
            mini_story["scenes"] = [mini_scene]
            mini_story["narration"] = ""
            request = build_tts_request(mini_story, voice)
            if request.get("segments"):
                raise RuntimeError("A single subtitle phrase unexpectedly produced multiple voice segments.")
            raw = work / f"voice_scene_{scene_index + 1:02}_phrase_{phrase_index + 1:02}_raw.wav"
            generate_tts_audio(request, raw)
            measured = probe_audio_duration(raw)
            if measured <= 0:
                raise RuntimeError("Gemini returned an empty subtitle phrase recording.")
            raw_phrases.append(raw)
            phrase_durations.append(measured)

        gap = 0.06
        total_gap = gap * max(0, len(raw_phrases) - 1)
        available_speech = max(0.1, duration - total_gap)
        total_raw_speech = sum(phrase_durations)
        tempo = max(1.0, total_raw_speech / available_speech)
        scene_parts = []
        cues = []
        cursor = float(scene.get("start", 0) or 0)

        for phrase_index, (raw, turn, raw_duration) in enumerate(zip(raw_phrases, turns, phrase_durations)):
            fitted_phrase = work / f"voice_scene_{scene_index + 1:02}_phrase_{phrase_index + 1:02}.wav"
            if tempo > 1.0001:
                run_ffmpeg([
                    "ffmpeg", "-y", "-i", str(raw), "-af", ",".join(_tempo_filters(tempo)),
                    "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", str(fitted_phrase),
                ])
            else:
                fitted_phrase = raw
            actual_duration = raw_duration / tempo
            cue_start = cursor
            cue_end = min(float(scene.get("start", 0) or 0) + duration, cue_start + actual_duration)
            cues.append({"text": turn["text"], "start": cue_start, "end": cue_end})
            scene_parts.append(fitted_phrase)
            cursor = cue_end
            if phrase_index < len(raw_phrases) - 1:
                silence = work / f"voice_scene_{scene_index + 1:02}_gap_{phrase_index + 1:02}.wav"
                run_ffmpeg([
                    "ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
                    "-t", str(gap), "-c:a", "pcm_s16le", str(silence),
                ])
                scene_parts.append(silence)
                cursor = min(float(scene.get("start", 0) or 0) + duration, cursor + gap)

        scene_raw = work / f"voice_scene_{scene_index + 1:02}_assembled.wav"
        concat_wav_files(scene_parts, scene_raw, work, f"voice_scene_{scene_index + 1:02}_phrases.txt")
        fitted = work / f"voice_scene_{scene_index + 1:02}.wav"
        fit_voice_clip(scene_raw, fitted, duration)
        scene["speechCues"] = cues
        scene["speechDurationSec"] = max(0.0, cursor - float(scene.get("start", 0) or 0))
        voice_parts.append(fitted)

    return concat_wav_files(voice_parts, destination, work, "voice_parts.txt")


def generate_music(story, destination):
    settings = story.get("productionSettings") or {}
    if not settings.get("musicEnabled", False):
        return None
    if os.getenv("LYRIA_ENABLED", "false").lower() != "true":
        raise RuntimeError("Original background music was requested, but Lyria is not enabled in the worker environment.")
    prompt = (
        "Create an original instrumental cinematic underscore for a short vertical educational explainer. "
        "No vocals, no lyrics, no recognizable existing melody. Use a memorable motif, modern orchestral "
        "hybrid textures, subtle pulse, restrained percussion and emotional rises that support narration. "
        "Keep the midrange clear for speech. Match the subject and emotional arc of this video: "
        + str(story.get("topic") or story.get("title") or "curiosity and discovery")
        + ". Make a complete instrumental track around 90 seconds with a clean ending."
    )
    interaction = api_request("/interactions", "POST", {
        "model": MUSIC_MODEL,
        "input": prompt,
    }, timeout=600)
    interaction = wait_for_interaction(interaction, timeout=600)
    Path(destination).write_bytes(audio_block_data(interaction))
    return destination


def run_ffmpeg(args):
    result = subprocess.run(args, check=False, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError("FFmpeg failed: " + result.stderr[-2500:])
    return result


def probe_audio_duration(path):
    result = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(path),
    ], check=True, capture_output=True, text=True)
    return float(result.stdout.strip())


def fit_voice_clip(source, destination, duration):
    source_duration = probe_audio_duration(source)
    if source_duration <= 0:
        raise RuntimeError("TTS returned an empty audio clip.")
    filters = []
    spoken_duration = min(source_duration, duration)
    if source_duration > duration:
        factor = source_duration / duration
        while factor > 2.0:
            filters.append("atempo=2.0")
            factor /= 2.0
        while factor < 0.5:
            filters.append("atempo=0.5")
            factor /= 0.5
        filters.append(f"atempo={factor:.5f}")
        spoken_duration = duration
    filters.extend(["apad", f"atrim=duration={duration}"])
    run_ffmpeg([
        "ffmpeg", "-y", "-i", str(source), "-af", ",".join(filters),
        "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", str(destination),
    ])
    return spoken_duration


def make_srt(story, destination):
    def stamp(seconds):
        milliseconds = max(0, int(round(seconds * 1000)))
        hours, remainder = divmod(milliseconds, 3600000)
        minutes, remainder = divmod(remainder, 60000)
        seconds_part, millis = divmod(remainder, 1000)
        return f"{hours:02}:{minutes:02}:{seconds_part:02},{millis:03}"

    rows = []
    cue = 1
    for scene in story.get("scenes", []):
        timed_cues = scene.get("speechCues")
        if isinstance(timed_cues, list) and timed_cues:
            for item in timed_cues:
                if not isinstance(item, dict):
                    continue
                phrase = str(item.get("text") or "").strip()
                start = float(item.get("start", 0) or 0)
                end = float(item.get("end", start) or start)
                if phrase and end > start:
                    rows.append(f"{cue}\n{stamp(start)} --> {stamp(end)}\n{phrase}\n")
                    cue += 1
            continue

        # Compatibility for older worker jobs and hand-authored timing fixtures.
        narration = str(scene.get("narration") or "").strip()
        dialogue = scene.get("dialogue") or []
        if isinstance(dialogue, dict):
            dialogue = [dialogue]
        dialogue_phrases = [
            str(line.get("line") or line.get("text") or "").strip()
            for line in dialogue if isinstance(line, dict)
        ] if isinstance(dialogue, list) else []
        phrases = list(scene.get("subtitlePhrases") or re.findall(r"[^.!?]+[.!?]?", narration))
        if not narration:
            phrases = []
        phrases.extend(dialogue_phrases)
        phrases = [str(value).strip() for value in phrases if str(value).strip()]
        if not phrases:
            continue
        start = float(scene.get("start", 0))
        scene_end = float(scene.get("end", start + 4))
        speech_duration = float(scene.get("speechDurationSec", scene_end - start))
        if speech_duration <= 0:
            continue
        end = min(scene_end, start + speech_duration)
        weights = [max(1, len(value.split())) for value in phrases]
        total = sum(weights)
        cursor = start
        for index, phrase in enumerate(phrases):
            next_cursor = end if index == len(phrases) - 1 else cursor + (end - start) * weights[index] / total
            rows.append(f"{cue}\n{stamp(cursor)} --> {stamp(next_cursor)}\n{phrase}\n")
            cue += 1
            cursor = next_cursor
    Path(destination).write_text("\n".join(rows), encoding="utf-8")
    return destination


def normalize_clip(source, destination, duration, ambience_path):
    run_ffmpeg([
        "ffmpeg", "-y", "-i", str(source),
        "-vf", "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,fps=24,setsar=1,tpad=stop_mode=clone:stop_duration=10",
        "-an", "-t", str(duration), "-c:v", "libx264", "-preset", "veryfast",
        "-crf", "21", "-pix_fmt", "yuv420p", str(destination),
    ])
    try:
        run_ffmpeg([
            "ffmpeg", "-y", "-i", str(source), "-vn",
            "-af", f"volume=0.32,apad,atrim=duration={duration}",
            "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", str(ambience_path),
        ])
    except RuntimeError:
        run_ffmpeg([
            "ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
            "-t", str(duration), "-c:a", "pcm_s16le", str(ambience_path),
        ])


def assemble_final_video(normalized, ambience, voice, music, subtitles, total_duration, work, destination, music_volume=0.12):
    if not normalized or not ambience:
        raise RuntimeError("The video assembly step received no generated scenes or scene audio.")
    concat_file = Path(work) / "clips.txt"
    concat_file.write_text("".join(f"file '{Path(path).as_posix()}'\n" for path in normalized), encoding="utf-8")
    video_only = Path(work) / "picture.mp4"
    run_ffmpeg(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file), "-c", "copy", str(video_only)])

    ambience_list = Path(work) / "ambience.txt"
    ambience_list.write_text("".join(f"file '{Path(path).as_posix()}'\n" for path in ambience), encoding="utf-8")
    ambience_all = Path(work) / "ambience.wav"
    run_ffmpeg(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(ambience_list), "-c", "copy", str(ambience_all)])

    filter_parts = [
        "[1:a]volume=1.0[voice]",
        "[2:a]volume=0.25[fx]",
    ]
    inputs = ["-i", str(video_only), "-i", str(voice), "-i", str(ambience_all)]
    labels = ["[voice]", "[fx]"]
    if music:
        inputs.extend(["-stream_loop", "-1", "-i", str(music)])
        music_volume = min(0.35, max(0.0, float(music_volume)))
        filter_parts.append(f"[3:a]volume={music_volume:.3f}[music]")
        labels.append("[music]")
    filter_parts.append("".join(labels) + f"amix=inputs={len(labels)}:duration=longest:dropout_transition=2,loudnorm=I=-16:LRA=11:TP=-1.5[audio]")
    subtitle_filter = "subtitles=" + str(subtitles).replace(":", "\\:").replace("'", "\\'") + ":force_style='FontName=DejaVu Sans,FontSize=30,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=4,Shadow=1,Alignment=2,MarginV=100'"
    command = ["ffmpeg", "-y", *inputs, "-filter_complex", ";".join(filter_parts),
               "-vf", subtitle_filter, "-map", "0:v:0", "-map", "[audio]",
               "-t", str(total_duration), "-c:v", "libx264", "-preset", "veryfast",
               "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
               "-movflags", "+faststart", str(destination)]
    run_ffmpeg(command)
    return destination


def upload_to_supabase(file_path, job_id):
    base = os.getenv("SUPABASE_URL", "").rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    bucket = os.getenv("SUPABASE_BUCKET", "ahm-videos")
    if not base or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for durable video downloads.")
    object_path = f"{job_id}/final.mp4"
    bucket_request = urllib.request.Request(
        f"{base}/storage/v1/bucket",
        data=json.dumps({"id": bucket, "name": bucket, "public": False}).encode("utf-8"),
        method="POST",
        headers={"Authorization": f"Bearer {key}", "apikey": key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(bucket_request, timeout=60) as response:
            response.read()
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        if error.code != 409 and "already exists" not in detail.lower():
            raise RuntimeError(f"Could not prepare Supabase storage bucket: {detail}") from error

    headers = {
        "Authorization": f"Bearer {key}",
        "apikey": key,
        "Content-Type": "video/mp4",
        "x-upsert": "true",
    }
    url = f"{base}/storage/v1/object/{bucket}/{object_path}"
    body = Path(file_path).read_bytes()
    request = urllib.request.Request(url, data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            response.read()
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Supabase video upload failed (HTTP {error.code}): {detail}") from error

    signed_url = f"{base}/storage/v1/object/sign/{bucket}/{object_path}"
    signed_request = urllib.request.Request(
        signed_url,
        data=json.dumps({"expiresIn": 604800}).encode("utf-8"),
        method="POST",
        headers={"Authorization": f"Bearer {key}", "apikey": key, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(signed_request, timeout=60) as response:
        signed = json.loads(response.read().decode("utf-8"))
    path = signed.get("signedURL") or signed.get("signedUrl")
    if not path:
        raise RuntimeError("Supabase did not return a signed download URL.")
    return path if path.startswith("http") else base + path


def process_job(event):
    payload = event.get("input", event) if isinstance(event, dict) else {}
    story = payload.get("story") or {}
    scenes = story.get("scenes") or []
    if not scenes:
        raise ValueError("The video job needs a complete AI Director scene plan.")
    scenes = expand_scene_segments(scenes)
    if not os.getenv("GEMINI_API_KEY"):
        raise RuntimeError("GEMINI_API_KEY is missing in the RunPod worker environment.")

    job_id = str(payload.get("job_id") or uuid.uuid4())
    log(f"Starting complete AHM production: {job_id} ({len(scenes)} scenes)")
    with tempfile.TemporaryDirectory(prefix="ahm-") as temp:
        work = Path(temp)
        normalized = []
        ambience = []
        planned_duration = float(story.get("durationSec") or 45)
        scene_end = max((float(scene.get("end", 0) or 0) for scene in scenes), default=0)
        total_duration = min(120, max(30, int(max(planned_duration, scene_end))))
        character_references = {}
        for index, scene in enumerate(scenes):
            duration = scene_duration(scene)
            raw = work / f"scene_{index + 1:02}.mp4"
            video = work / f"normalized_{index + 1:02}.mp4"
            fx = work / f"ambience_{index + 1:02}.wav"
            scene_character_ids = scene.get("characters") or []
            reference_images = [
                character_references[character_id]
                for character_id in scene_character_ids
                if character_id in character_references
            ][:3]
            log(f"Generating cinematic scene {index + 1}/{len(scenes)}")
            generate_video_clip(story, scene, index, len(scenes), raw, reference_images)
            for character_id in scene_character_ids:
                if character_id not in character_references:
                    reference_path = work / f"character_{str(character_id).replace('/', '_')}.jpg"
                    try:
                        extract_character_reference_frame(raw, reference_path)
                        character_references[character_id] = reference_path
                    except Exception as error:
                        log(f"Could not create visual reference for {character_id}: {error}")
            normalize_clip(raw, video, duration, fx)
            normalized.append(video)
            ambience.append(fx)

        voice = work / "narration.wav"
        settings = story.get("productionSettings") or {}
        write_tts_wav(story, voice, settings.get("voice"))
        music = generate_music(story, work / "music.mp3")
        subtitles = make_srt(story, work / "captions.srt")
        final = work / "final.mp4"
        music_volume = float(settings.get("musicVolume", 0.12) or 0)
        assemble_final_video(normalized, ambience, voice, music, subtitles, total_duration, work, final, music_volume)

        final_url = upload_to_supabase(final, job_id)
        log(f"Production complete: {job_id}")
        return {
            "job_id": job_id,
            "status": "completed",
            "finalVideoUrl": final_url,
            "durationSec": total_duration,
            "sceneCount": len(scenes),
            "audio": {
                "narration": "generated",
                "sceneSoundEffects": "generated_with_video",
                "backgroundMusic": "generated" if music else "not_enabled",
            },
            "format": "mp4",
            "resolution": "720x1280",
        }


def handler(event):
    try:
        return process_job(event)
    except Exception as error:
        log(f"JOB FAILED: {error}")
        # Let RunPod mark the job as FAILED so the website can display the
        # provider's real error instead of treating an error object as a video.
        raise


if __name__ == "__main__":
    import runpod
    runpod.serverless.start({"handler": handler})
