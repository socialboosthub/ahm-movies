# AHM Studio — Master Product & Production Specification

## 1. Product vision

AHM Studio is a fully automated, AI-powered production studio for premium short-form 3D explanatory videos.

The product is NOT primarily a fictional-story generator and NOT a manual video editor. Its central purpose is to turn a user's question, topic, claim, interesting fact, hypothetical scenario, or supplied script into a complete, compelling, visually rich explanatory video.

The creative reference is the broad category of high-quality, fast-paced 3D explainer content associated with creators such as Zack D. Films. This is a quality and format reference only. AHM must develop its own original visual identity and must not copy another creator's exact scripts, assets, signature compositions, or finished videos.

The ambition is premium production quality: exceptionally clear explanations, striking 3D visuals, sophisticated camera work, intentional transitions, excellent pacing, polished sound and a strong ending. "Premium" is the quality target, not a claim that current free tools can already deliver it.

## 2. Flexible niche requirement

AHM Studio must not be locked to one niche. The user can enter any suitable explanatory topic and the system should adapt its research, script, visual language and production plan to that topic.

Potential subject areas include (but are not limited to):
- Human body, anatomy, biology and health education.
- Science, physics, chemistry, space and nature.
- Animals, wildlife and unusual natural phenomena.
- History, archaeology, mysteries and discoveries.
- Technology, engineering, machines and how things work.
- Interesting facts, myths, misconceptions and "what if" scenarios.
- Everyday processes, objects and situations explained visually.

These are examples, not a fixed category list. The user should not have to select a niche before every generation. AHM should infer the best approach from the topic and allow the user to specify a niche or tone when desired.

For factual subjects, the system must prioritize accuracy. It should distinguish established facts from uncertainty, avoid invented claims, and use trustworthy research when the topic requires it. Medical, scientific and historical explanations must not sacrifice correctness for shock value.

## 3. Core user experience

The intended workflow is simple:
1. The user enters a topic, question, idea or script.
2. The user presses Generate.
3. AHM independently researches or validates the subject as appropriate, writes the explanation, plans the visuals, generates the assets and footage, creates audio and subtitles, edits the video, performs quality checks and exports one finished video.
4. The user previews and downloads the completed MP4.

The user must not be required to:
- Write prompts for individual shots.
- Manually design or arrange scenes.
- Upload reference pictures, video clips or audio just to make a normal video.
- Record narration or character dialogue.
- Search for music or sound effects.
- Manually join clips, synchronize subtitles or edit the final video.

Optional advanced controls may be offered, but the default experience must remain hands-off.

## 4. Content and storytelling direction

AHM should create explanatory videos, not merely narrate facts over unrelated visuals. The visuals must demonstrate the explanation.

The Director should:
- Identify the central question or curiosity gap.
- Open with an immediate, compelling visual and verbal hook.
- Explain the subject in a logical sequence.
- Show mechanisms, changes, scale, cause and effect, or comparisons where relevant.
- Build curiosity and reveal information progressively.
- End with a clear answer, surprising but accurate insight, or memorable takeaway.

Use a flexible structure rather than forcing every topic into one template. A typical short may use: hook → setup → visual demonstration → deeper reveal → conclusion/kicker.

Avoid filler, generic introductions, repetitive narration, irrelevant shots and unsupported sensational claims. The explanation must remain understandable at short-form speed.

## 5. Visual quality and original art direction

The target is premium, polished, stylized-realistic 3D explanatory filmmaking. AHM should choose the most suitable visual treatment for each topic while maintaining a coherent, high-quality overall identity.

Quality expectations:
- Detailed 3D subjects, objects, environments and materials.
- Intentional composition, depth, lighting, shadows and atmosphere.
- Clear visual hierarchy: viewers should immediately understand what matters.
- Convincing motion and physically plausible actions where appropriate.
- Expressive characters when people or characters are needed.
- Accurate anatomical, mechanical, scientific or environmental representations when the subject requires them.
- Consistent appearance of recurring people, objects and locations across shots.
- Strong visual demonstrations rather than static images or generic stock footage.

Do not force human characters into every video. Some topics are best explained with anatomical cutaways, diagrams, machines, environments, particles, simulations, objects or abstract visualizations.

The system may use different visual modes for different topics, but the result should feel intentionally art-directed rather than like unrelated model outputs stitched together.

## 6. Camera language and transitions — critical requirement

Transitions and camera choreography are a core part of the product, not decorative extras.

The Director must plan how each shot connects to the next. Prefer visually motivated, coherent transitions such as:
- Continuous camera push-ins and pull-outs.
- Fly-throughs into or through objects, environments and cutaways.
- Match cuts based on shape, motion, colour or composition.
- Object-to-object transitions and visual reveals.
- Whip pans and fast reframing when appropriate.
- Rotating camera moves and tracking shots.
- Macro-to-wide scale changes.
- Seamless environment or cross-section transitions.
- Carefully timed impact cuts, speed ramps and brief camera shakes.
- Morphing transitions only when they preserve visual clarity and make sense.

Every transition should support the explanation, maintain spatial or conceptual continuity where possible, and avoid confusing visual jumps. Do not apply the same transition mechanically to every cut. Use purposeful variation and pacing.

Use fast cuts when they increase energy, but allow shots enough time for viewers to understand important information. Camera motion must not obscure the subject or make educational details unreadable.

## 7. Annotation and on-screen graphics

Use visual annotations when they genuinely help explain a subject:
- Green or similarly clear highlight treatments for important details, paths, mechanisms or reveals.
- Red or contrasting warning treatments for danger, impact, heat, pressure, force or risk.
- Arrows, outlines, labels, measurement guides, paths, cutaways and callouts where appropriate.

These are adaptable visual conventions, not mandatory colours for every video. Graphics must be legible, accurate and consistent with the scene. Do not bake garbled pseudo-text into generated footage. Prefer adding precise labels and typography during compositing.

## 8. Narration, dialogue and sound

The default format is a clear, engaging narrator-led explanation. Narration should sound natural, confident and appropriately expressive, with pacing suited to the visuals.

When characters appear, they may gesture, emote or demonstrate actions. Spoken character dialogue and lip-sync are optional creative choices, not a requirement for every video. Do not force dialogue into explanatory content when an external narrator is clearer.

Automatically provide:
- Narration matched to the final edit.
- Appropriate voice consistency within a video and, where configured, across a channel.
- Background music that supports the subject without overpowering speech.
- Synchronized sound effects for meaningful actions, transitions and reveals.
- Proper audio mixing, intelligibility and loudness control.

A user's own voice or voice clone may be an optional future feature, only with the user's explicit consent and the required provider support.

## 9. Subtitles and typography

Provide large, high-contrast, mobile-readable subtitles synchronized to speech. Use sensible line lengths, safe margins and emphasis for key words without cluttering the frame. Correct subtitle timing and spelling during final quality checks. Do not rely on video-generation models to render exact text; add typography in the final compositing stage.

## 10. Output contract

- Primary format: vertical 9:16 for TikTok, Reels and YouTube Shorts.
- Duration: naturally determined by the topic and script, usually around 30–60 seconds, and may extend as needed.
- Hard maximum: 120 seconds.
- No filler to reach a duration target.
- Deliverable: one complete, downloadable MP4.
- Target export: 1080×1920 when the chosen generation and rendering pipeline can support it. Do not claim 1080p if the actual source/output resolution is lower.
- Audio and subtitles must be synchronized.
- The video must begin with meaningful content and must not contain blank/black placeholder sections.

## 11. Character, object and visual continuity

When recurring characters, objects or locations are needed:
- Create reusable visual identity/reference assets.
- Reuse those references across relevant shots.
- Track important appearance details, clothing, materials, proportions and state changes.
- Maintain continuity of damage, movement, position and environment when relevant.

A reusable Character Library is a desired product capability:
- Create, save, edit, reuse and delete characters.
- Allow users to bring saved characters into future projects.
- Do not require a character for topics that are better explained without one.

The same continuity principles should apply to recurring objects, machines and environments.

## 12. AI production pipeline

The architecture should separate the following responsibilities into replaceable modules:

1. Topic understanding and research — classify the subject, identify claims and gather/verify facts when needed.
2. Explainer Director — create the hook, narration/script, explanatory beats and creative direction.
3. Visual planner — produce a timed shot list, asset roster, camera instructions, transition plan and annotation plan.
4. Asset generation — create consistent subjects, objects, environments and visual references.
5. Video generation — produce genuine moving footage or suitable rendered simulations for each planned shot/sequence.
6. Voice and audio — generate narration, music and sound effects.
7. Subtitle generation — create accurate, timed captions.
8. Compositor/editor — assemble footage, transitions, overlays, audio and subtitles into one video.
9. Quality control — verify factual consistency, visual continuity, shot coverage, playback, resolution, duration, audio and subtitle sync.
10. Delivery — provide the final downloadable MP4 and generation status.

A story/script planner alone is not a video generator. A folder of still images, slideshow, black video or placeholder MP4 must never be presented as completed AI-generated video footage.

## 13. Free-first operating principles

The project should prioritize free and open-source tools, free API tiers and no-cost infrastructure wherever practical.

- Do not activate paid API tiers, subscriptions, GPU instances, cloud compute or billing without the user's explicit approval.
- Do not start or rent a paid GPU instance without approval.
- Clearly disclose free-tier quotas, queues, model restrictions, resolution limits and other constraints.
- Optimize the workflow for repeated testing within legitimate free quotas.
- Do not promise unlimited free generation or premium output if the available providers cannot deliver it.
- Keep providers modular so alternatives can be evaluated without rebuilding the product.
- Prefer a real, lower-resolution or shorter generation with clear disclosure over a fake high-quality result.

The ambition remains premium quality. Free-first is a cost constraint and engineering strategy, not permission to misrepresent output quality.

## 14. Product interface

The interface should be simple, polished and mobile-first.

Core areas:
- Create: enter a topic, question, idea or script and generate.
- Director/production status: show understandable progress without exposing unnecessary technical complexity.
- Character Library: manage reusable characters.
- Projects/My Videos: view, preview and download completed videos.
- Settings: manage permitted provider keys and preferences securely.

Do not make the user configure individual shots, models, prompts or editing timelines for the normal workflow.

## 15. Engineering and delivery rules

- Inspect the existing repository and architecture before making changes.
- Preserve useful working functionality.
- Work on the designated feature branch unless the user approves another branch or a merge.
- Keep secrets server-side; never expose API keys in frontend code, commits or logs.
- Test the actual end-to-end workflow, not just UI buttons or isolated endpoints.
- Report what is implemented, what is tested, what is blocked and what remains unfinished.
- Never claim a feature works unless it has been verified.
- Design provider adapters and job orchestration so the generation stack can evolve.
- Account for long-running jobs, retries, status tracking, storage and deployment constraints.
- Do not introduce paid dependencies or services without explicit approval.

## 16. Current implementation status (must be kept honest)

The current branch has an initial Gemini-powered story-planning foundation and a connected planning UI. This is only a first step and is not the finished AHM product.

At the time of this specification update:
- Story planning integration: implemented as an initial foundation; must be tested with a valid key and current API requirements.
- Backend story planning endpoint: implemented.
- Story-plan UI: implemented.
- Real 3D asset generation: not yet implemented as a complete workflow.
- Genuine AI video generation: not yet implemented as a complete workflow.
- Camera/transition production engine: not yet implemented.
- Automated narration, music and sound pipeline: not yet implemented end-to-end.
- Final MP4 assembly and delivery: not yet implemented end-to-end.
- Reusable character library: not yet implemented.

The next engineering work must align the existing story planner with the flexible explainer-video vision, then build and verify the genuine visual-generation and end-to-end production pipeline.

## 17. Definition of success

AHM Studio succeeds when a non-technical user can enter almost any suitable explanatory topic, press Generate, and receive one complete, accurate, visually impressive, well-paced, premium-feeling 3D explainer video with intentional transitions, narration, music, sound effects and readable subtitles — without manually producing or editing the scenes.

The system should support repeated testing and continuous quality improvement, stay free-first where possible, and be honest about any limitations imposed by available models and infrastructure.
