# AHM Movies

Automatic movie recap creator: upload one full-length movie, analyse the complete story, create a faithful recap script, select matching shots from the original footage, generate narration and synchronized captions, then export three 3:4 MP4 episodes.

## Current status
The current web page is an upload and workflow preview. It supports local video selection, metadata preview, and playback. It does **not** yet upload or process the movie. AI analysis, shot matching, narration, subtitle timing, long-running video processing, storage, and MP4 exports require backend services that are not configured.

## Intended processing pipeline
1. Upload original movie to durable object storage using resumable/multipart upload.
2. Extract audio and scene/keyframe metadata with FFmpeg.
3. Transcribe dialogue and analyse the complete timeline; build a timestamped story outline including the ending.
4. Write narration grounded in those events and retrieve matching source timestamps.
5. Generate narration audio; align captions to the generated narration.
6. Use FFmpeg to cut only source-movie footage, mix narration, burn captions, render 3:4, and split into three narrative episodes.
7. Store and provide three downloadable MP4s.

Do not claim a recap is ready until the complete pipeline succeeds.
