import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, "/app")
import handler
from handler import assemble_final_video, make_srt, normalize_clip, probe_audio_duration, run_ffmpeg


def main():
    with tempfile.TemporaryDirectory(prefix="ahm-ffmpeg-smoke-") as temp:
        work = Path(temp)
        normalized = []
        ambience = []
        for index, color in enumerate(("blue", "orange"), start=1):
            raw = work / f"raw_{index}.mp4"
            video = work / f"video_{index}.mp4"
            fx = work / f"fx_{index}.wav"
            run_ffmpeg([
                "ffmpeg", "-y",
                "-f", "lavfi", "-i", f"color=c={color}:s=360x640:r=24:d=2",
                "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
                "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-c:a", "aac", str(raw),
            ])
            normalize_clip(raw, video, 2, fx)
            normalized.append(video)
            ambience.append(fx)

        story = {
            "title": "AHM Audio Sync Test",
            "narration": "The first narration.",
            "characters": [{"id": "char_1", "name": "Elias", "voice": "Puck"}],
            "scenes": [
                {"start": 0, "end": 2, "durationSec": 2, "narration": "The first narration.", "subtitlePhrases": ["The first narration."]},
                {"start": 2, "end": 4, "durationSec": 2, "dialogue": [{"character": "char_1", "line": "Look at that!"}]},
            ],
        }
        generated_audio = {"count": 0}

        def fake_tts_generation(_request, destination):
            duration = 3 if generated_audio["count"] == 0 else 1
            frequency = 660 if generated_audio["count"] == 0 else 550
            generated_audio["count"] += 1
            run_ffmpeg([
                "ffmpeg", "-y", "-f", "lavfi", "-i",
                f"sine=frequency={frequency}:sample_rate=24000:duration={duration}",
                "-c:a", "pcm_s16le", "-ar", "24000", "-ac", "1", str(destination),
            ])
            return destination

        handler.generate_tts_audio = fake_tts_generation
        voice = work / "voice.wav"
        handler.write_tts_wav(story, voice, "Charon")
        assert generated_audio["count"] == 2
        assert abs(probe_audio_duration(voice) - 4) < 0.1
        assert abs(story["scenes"][0]["speechDurationSec"] - 2) < 0.1
        assert abs(story["scenes"][1]["speechDurationSec"] - 1) < 0.1

        subtitles = work / "captions.srt"
        make_srt(story, subtitles)
        subtitle_text = subtitles.read_text(encoding="utf-8")
        assert "Look at that!" in subtitle_text
        assert "00:00:02,000 --> 00:00:03,000" in subtitle_text

        music = work / "music.wav"
        run_ffmpeg([
            "ffmpeg", "-y", "-f", "lavfi", "-i",
            "sine=frequency=220:sample_rate=48000:duration=1",
            "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", str(music),
        ])
        final = work / "final.mp4"
        assemble_final_video(normalized, ambience, voice, music, subtitles, 4, work, final)

        probe = subprocess.run([
            "ffprobe", "-v", "error", "-show_entries",
            "stream=codec_type,codec_name,width,height", "-show_entries",
            "format=duration", "-of", "json", str(final),
        ], check=True, capture_output=True, text=True)
        result = json.loads(probe.stdout)
        video_stream = next(stream for stream in result["streams"] if stream["codec_type"] == "video")
        audio_stream = next(stream for stream in result["streams"] if stream["codec_type"] == "audio")
        duration = float(result["format"]["duration"])
        assert video_stream["codec_name"] == "h264", video_stream
        assert video_stream["width"] == 720 and video_stream["height"] == 1280, video_stream
        assert audio_stream["codec_name"] == "aac", audio_stream
        assert 3.8 <= duration <= 4.2, duration
        assert final.stat().st_size > 10000
        print("AHM FFmpeg smoke test passed:", video_stream, audio_stream, "duration", duration)


if __name__ == "__main__":
    main()
