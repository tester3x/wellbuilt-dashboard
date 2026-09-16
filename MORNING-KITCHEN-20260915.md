# Morning kitchen page

Live: https://wellbuilt-sync.web.app/kitchen/

Source: `public/kitchen/index.html` and `public/kitchen/morning-kitchen.png` on `feat/dashboard-morning-kitchen-20260915`, based on `50b89900f62e6ab85d8d65c9b9394d5936ef6fee`.

This is a generated still photograph with browser-rendered water highlights, drifting dust and a subtle foliage movement, not a generated video. No sound or network dependencies. Motion pauses offscreen, supports reduced motion, and has a manual pause button. The responsive crop keeps the faucet visible. Pause and mobile rendering were checked in the browser.

## Deployment / integration

Added to the existing Firebase Hosting site without rebuilding the Dashboard. All 304 existing deployed file hashes and Hosting configuration were retained; only two /kitchen/ files were added. No Functions or rules changed.

Previous Hosting version: `f8d1df217779b705`.
New Hosting version: `31f95626816fdfdf`.
Release: `1789517027302000`.

**Cherry-pick this page into the next Dashboard release before deploying Hosting again**, or the next full static export will omit it. Do not deploy this historical base as a whole Dashboard release.

## Artwork

Built-in image_gen tool, copied into the project from its generated output. Final generation prompt:

Use case: photorealistic-natural. Create a wide 16:9 full-screen webpage background photograph of a calm comfortable lived-in kitchen in morning sun. Static camera, eye-level, natural oak counter, cream cabinets, ceramic mug, deep farmhouse sink, graceful brass faucet centered slightly right, a tall window just behind the sink throwing warm diagonal rays into the room, two small leafy plants on the sill, soft linen curtain. Cozy understated real home, tactile materials, cinematic natural exposure, no people, text, logos or UI. Faucet spout and sink fully visible near the center so mobile cropping preserves them. A very thin trickle of water from the faucet. Sparse dust catching the light. This is a still plate for subtle browser animation; keep architectural lines crisp, no motion blur. Landscape 1536x864 or similar wide aspect ratio.

## Breeze update

Window edit generated with the built-in image tool, saved as `public/kitchen/morning-kitchen-breeze.png`; original retained. Prompt: preserve exact kitchen framing and objects, change only the left casement behind the plant to crack inward a few inches with a narrow visible gap. Plant stays positioned for browser animation.

Increased water highlight speed/contrast and dust size/drift; added left-plant sway. Checked responsive appearance and pause/play controls. Published Hosting version `db88bd5dbcc9ae21`, release `1789517391058000`. Changed only `/kitchen/index.html`, added the new artwork, retained all other prior file hashes and Hosting configuration.

## Character details

Built-in image edit added the TicketTime pink piggy bank, Rascal beside the mug, a fish bowl on the right counter, and the ETC digital host in the wall frame. Edit target was the breeze kitchen; references were ETC `rascal_sprites_v2.png`, `etc_digital_host_v1.png`, and TicketTime `tickettime-pig-icon-1024.png`. Prompt required exact kitchen framing/faucet/plant geometry, naturally sized scattered objects in matching morning light, one hamster without a wheel, and the recognizable host portrait inside the existing frame. Saved `public/kitchen/morning-kitchen-friends.png`; prior versions retained. Animation code unchanged.

Published version `f0f4a0619817a86c`, release `1789517717493000`. Changed only kitchen HTML and added the new plate; all other deployed file hashes/config retained. Current source must accompany the next full Dashboard deployment.

## Motion refinement

Smaller dust motes (0.55–1.09 source pixels), stronger descending water highlights, and three small individually masked leaf tips replace full-plant rotation. JavaScript syntax passed. Live version `adb8f6f2f5caa3db`.

A concurrent full Dashboard release `06b9cf178a26e8e9` omitted the kitchen files. The initial deployment check stopped without releasing; kitchen HTML/art were then added to that latest release, preserving all 304 existing Dashboard file hashes/config. The Dashboard release owner must include this branch's `public/kitchen/` in subsequent builds to keep the page online.
