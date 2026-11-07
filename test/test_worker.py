import tempfile
import unittest
from pathlib import Path

from worker.handler import (
    expand_scene_segments,
    media_blocks,
    make_srt,
    scene_duration,
    scene_prompt,
    build_tts_request,
    build_video_input,
    build_video_generation_request,
    audio_block_data,
    generate_music,
    handler,
    api_request,
)


class AHMWorkerTests(unittest.TestCase):
    def test_long_scenes_are_split_into_supported_video_clips(self):
        scenes = [{"durationSec": 24, "action": "A camera flies through a tunnel."}]
        result = expand_scene_segments(scenes)
        self.assertEqual([item["durationSec"] for item in result], [10, 10, 4])
        self.assertIn("Continue the same action", result[1]["action"])

    def test_short_scene_duration_is_preserved_for_final_trim(self):
        self.assertEqual(scene_duration({"durationSec": 1}), 1)
        self.assertEqual(scene_duration({"durationSec": 40}), 10)

    def test_scene_prompt_keeps_style_and_continuity(self):
        story = {
            "title": "Speed of Light",
            "characters": [
                {"id": "char_1", "name": "Scientist", "description": "Blue coat, silver glasses"},
                {"id": "char_2", "name": "Unrelated Guide", "description": "Red hat and green scarf"},
            ],
            "environments": [{"name": "Lab", "description": "Dark blue physics laboratory"}],
            "props": [{"name": "Photon", "description": "Glowing golden particle"}],
        }
        scene = {"durationSec": 6, "action": "A photon races past the camera.", "visualPrompt": "Macro shot", "characters": ["char_1"]}
        prompt = scene_prompt(story, scene, 0, 4)
        self.assertIn("vertical 9:16", prompt)
        self.assertIn("Blue coat, silver glasses", prompt)
        self.assertIn("Glowing golden particle", prompt)
        self.assertNotIn("Unrelated Guide", prompt)
        self.assertIn("Do not add", prompt)

    def test_single_character_dialogue_uses_the_character_voice(self):
        story = {
            "characters": [{"id": "char_1", "name": "Elias", "voice": "Fenrir"}],
            "scenes": [{"dialogue": [{"character": "char_1", "line": "I will find the answer."}]}],
        }
        request = build_tts_request(story, "Charon")
        self.assertEqual(request["speech_config"], [{"voice": "Fenrir"}])
        spoken = request["input"][0]["content"][0]["text"]
        self.assertEqual(spoken, "I will find the answer.")
        self.assertNotIn("Read the following", spoken)
        self.assertEqual(request["input"][0]["content"][0]["annotations"][0]["style"], "natural, expressive character dialogue")

    def test_long_scene_segments_keep_unique_narration_dialogue_and_timing(self):
        scene = {
            "start": 5,
            "end": 18,
            "durationSec": 13,
            "narration": "First discovery sentence. Second discovery sentence. Third discovery sentence.",
            "dialogue": [
                {"character": "a", "line": "Look at the first result!"},
                {"character": "b", "line": "Now check the second result!"},
                {"character": "a", "line": "We finally understand it."},
            ],
        }
        result = expand_scene_segments([scene])
        self.assertEqual([item["durationSec"] for item in result], [10, 3])
        self.assertEqual([item["start"] for item in result], [5, 15])
        self.assertEqual([item["end"] for item in result], [15, 18])
        combined_narration = " ".join(item["narration"] for item in result)
        self.assertEqual(combined_narration, scene["narration"])
        combined_dialogue = [line for item in result for line in item["dialogue"]]
        self.assertEqual(combined_dialogue, scene["dialogue"])

    def test_three_or_more_speakers_are_rendered_as_individual_voice_turns(self):
        story = {
            "characters": [
                {"id": "one", "name": "Elias", "voice": "Puck"},
                {"id": "two", "name": "Mara", "voice": "Kore"},
            ],
            "scenes": [{
                "narration": "The story begins.",
                "dialogue": [
                    {"character": "one", "line": "I found it."},
                    {"character": "two", "line": "Show me."},
                ],
            }],
        }
        request = build_tts_request(story, "Charon")
        self.assertEqual(len(request["segments"]), 3)
        self.assertEqual(request["segments"][0]["speech_config"], [{"voice": "Charon"}])
        self.assertEqual(request["segments"][1]["speech_config"], [{"voice": "Puck"}])
        self.assertEqual(request["segments"][2]["speech_config"], [{"voice": "Kore"}])

    def test_video_generation_request_sets_duration_aspect_and_task(self):
        story = {"title": "Light", "topic": "Light", "scenes": []}
        request = build_video_generation_request(
            story,
            {"durationSec": 4, "action": "A photon crosses space."},
            0,
            1,
        )
        self.assertEqual(request["model"], "gemini-omni-1.1-flash")
        self.assertEqual(request["generation_config"]["video_config"]["task"], "text_to_video")
        self.assertEqual(request["response_format"]["aspect_ratio"], "9:16")
        self.assertEqual(request["response_format"]["duration"], "4s")
        self.assertEqual(request["response_format"]["delivery"], "uri")

    def test_video_generation_request_uses_reference_to_video_for_character_images(self):
        import tempfile
        with tempfile.TemporaryDirectory() as temp:
            reference = Path(temp) / "character.jpg"
            reference.write_bytes(b"jpeg")
            request = build_video_generation_request(
                {"title": "Story", "characters": []},
                {"durationSec": 2, "action": "A character waves."},
                0,
                1,
                [reference],
            )
        self.assertEqual(request["generation_config"]["video_config"]["task"], "reference_to_video")
        self.assertEqual(request["response_format"]["duration"], "3s")
        self.assertIn("<IMAGE_REF_0>@Image1", request["input"][-1]["text"])

    def test_video_input_attaches_character_reference_images(self):
        import base64
        with tempfile.TemporaryDirectory() as temp:
            image_path = Path(temp) / "character.jpg"
            image_path.write_bytes(b"fake-jpeg-bytes")
            result = build_video_input("A cinematic scene", [image_path])
        self.assertIsInstance(result, list)
        self.assertEqual(result[0]["type"], "image")
        self.assertEqual(result[0]["mime_type"], "image/jpeg")
        self.assertEqual(base64.b64decode(result[0]["data"]), b"fake-jpeg-bytes")
        self.assertEqual(result[-1]["type"], "text")
        self.assertIn("visual identity references", result[-1]["text"])

    def test_story_dialogue_uses_two_distinct_character_voices(self):
        story = {
            "characters": [{"id": "char_1", "name": "Elias", "voice": "Puck"}],
            "scenes": [{
                "narration": "The night sky begins to glow.",
                "dialogue": [{"character": "char_1", "line": "Look at the stars!"}],
            }],
        }
        request = build_tts_request(story, "Charon")
        self.assertNotIn("mode", request["speech_config"])
        self.assertEqual(len(request["speech_config"]["speakers"]), 2)
        self.assertEqual(request["speech_config"]["speakers"][0], {"speaker": "Narrator", "voice": "Charon"})
        self.assertEqual(request["speech_config"]["speakers"][1], {"speaker": "Elias", "voice": "Puck"})
        content = request["input"][0]["content"]
        self.assertEqual(content[0]["annotations"][0]["speaker"], "Narrator")
        self.assertEqual(content[1]["annotations"][0]["speaker"], "Elias")

    def test_audio_block_data_prefers_documented_output_audio(self):
        import base64
        expected = b"RIFFfake-wav"
        interaction = {"output_audio": {"data": base64.b64encode(expected).decode("ascii")}}
        self.assertEqual(audio_block_data(interaction), expected)

    def test_media_blocks_only_reads_model_output(self):
        interaction = {
            "steps": [
                {"type": "user_input", "content": [{"type": "video", "data": "wrong"}]},
                {"type": "model_output", "content": [{"type": "video", "data": "right"}]},
            ]
        }
        self.assertEqual(media_blocks(interaction, "video"), [{"type": "video", "data": "right"}])

    def test_music_is_off_by_default_and_paid_generation_is_guarded(self):
        self.assertIsNone(generate_music({"productionSettings": {"musicEnabled": False}}, "/tmp/unused.mp3"))
        previous = __import__("os").environ.get("LYRIA_ENABLED")
        __import__("os").environ["LYRIA_ENABLED"] = "false"
        try:
            with self.assertRaisesRegex(RuntimeError, "Lyria is not enabled"):
                generate_music({"productionSettings": {"musicEnabled": True}}, "/tmp/unused.mp3")
        finally:
            if previous is None:
                __import__("os").environ.pop("LYRIA_ENABLED", None)
            else:
                __import__("os").environ["LYRIA_ENABLED"] = previous

    def test_interactions_api_requests_include_revision_header(self):
        import os
        from unittest.mock import patch

        previous = os.environ.get("GEMINI_API_KEY")
        os.environ["GEMINI_API_KEY"] = "test-key"
        captured = []

        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                return False
            def read(self):
                return b"{}"

        def fake_urlopen(request, timeout):
            captured.append(request)
            return Response()

        try:
            with patch("urllib.request.urlopen", fake_urlopen):
                api_request("/interactions", "POST", {"model": "test"})
                api_request("/models/test:generateContent", "POST", {"contents": []})
            interaction_headers = {key.lower(): value for key, value in captured[0].header_items()}
            generate_headers = {key.lower(): value for key, value in captured[1].header_items()}
            self.assertEqual(interaction_headers["api-revision"], "2026-05-20")
            self.assertNotIn("api-revision", generate_headers)
        finally:
            if previous is None:
                os.environ.pop("GEMINI_API_KEY", None)
            else:
                os.environ["GEMINI_API_KEY"] = previous

    def test_worker_raises_failures_so_RunPod_marks_the_job_failed(self):
        import os
        previous = os.environ.pop("GEMINI_API_KEY", None)
        try:
            with self.assertRaisesRegex(RuntimeError, "GEMINI_API_KEY is missing"):
                handler({"input": {"story": {"scenes": [{"action": "A scene"}]}}})
        finally:
            if previous is not None:
                os.environ["GEMINI_API_KEY"] = previous

    def test_subtitles_use_measured_speech_phrase_timestamps(self):
        story = {
            "scenes": [{
                "start": 4,
                "end": 8,
                "narration": "The light is moving.",
                "speechDurationSec": 2,
                "subtitlePhrases": ["The light is moving."],
                "speechCues": [
                    {"text": "The light", "start": 4.0, "end": 4.42},
                    {"text": "is moving.", "start": 4.48, "end": 5.31},
                ],
            }]
        }
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "measured.srt"
            make_srt(story, path)
            content = path.read_text(encoding="utf-8")
        self.assertIn("00:00:04,000 --> 00:00:04,420", content)
        self.assertIn("00:00:04,480 --> 00:00:05,310", content)
        self.assertNotIn("00:00:04,000 --> 00:00:05,000", content)

    def test_subtitles_use_scene_timing_and_preserve_phrases(self):
        story = {
            "scenes": [
                {
                    "start": 0,
                    "end": 6,
                    "speechDurationSec": 3,
                    "narration": "Light moves fast. It crosses space.",
                    "subtitlePhrases": ["Light moves fast.", "It crosses space."],
                    "dialogue": [{"character": "char_1", "line": "Watch closely!"}],
                }
            ]
        }
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "captions.srt"
            make_srt(story, path)
            content = path.read_text(encoding="utf-8")
        self.assertIn("00:00:00,000 -->", content)
        self.assertIn("Light moves fast.", content)
        self.assertIn("It crosses space.", content)
        self.assertIn("Watch closely!", content)
        self.assertIn("00:00:03,000", content)
        self.assertNotIn("00:00:06,000", content)


if __name__ == "__main__":
    unittest.main()
