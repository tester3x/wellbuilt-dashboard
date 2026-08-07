/**
 * vc51.9I-RECOVERY4 — photo-compliance Functions, restored.
 *
 * `validatePhotoCompliance` and `suggestPhotoCriteria` are LIVE and were
 * absent from this branch's source: a whole-codebase deploy from here
 * would have deleted them. Restored byte-faithfully from the qualified
 * historical implementation (identical on origin/clean-rebuild and
 * safe/payroll-billing-contract), moved into a self-contained module
 * rather than back into index.ts, with exactly three security
 * corrections and no behavior change:
 *
 *   1. Provider keys come from Secret Manager, not process.env. There is
 *      no plaintext fallback; a missing selected-provider secret fails
 *      closed via readSecret().
 *   2. The Gemini key travels in the `x-goog-api-key` HEADER. It was
 *      previously appended to the request URL as `?key=...`, which puts
 *      a live credential into request logs, error traces, and any proxy
 *      in between.
 *   3. Provider failures are logged through redact() so no credential
 *      shape can reach Cloud Logging.
 *
 * Both Functions switch provider at runtime via
 * PHOTO_COMPLIANCE_PROVIDER (default 'claude'), so either can genuinely
 * invoke either provider. Binding both secrets to both is therefore
 * least privilege at the Function boundary — parseJsaPdf stays
 * Anthropic-only, and the well-catalog and split-family Functions bind
 * neither. PHOTO_COMPLIANCE_PROVIDER itself is ordinary non-credential
 * config and stays on process.env.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { ANTHROPIC_API_KEY, GEMINI_API_KEY, readSecret, logRedacted } from './secrets';
import { createAnthropicClient } from './ai/anthropicClient';

const firestoreDb = admin.firestore();

// ───────────────────────────────────────────────────────────────────────────
// Photo compliance — match a driver's captured photo against a customer's
// required-photo spec (sample image + description) using a vision model. Returns
// { pass, score, reason }. The driver app is NEVER blocked on this: it validates
// online and asks for a retake on fail; offline it queues the photo as
// "pending" and calls this later. Requirement specs live in
// photo_requirements/{customerId}.requirements[] (sampleStoragePath + threshold).
//
// Provider is switchable via PHOTO_COMPLIANCE_PROVIDER in functions/.env:
//   'claude' (default) — uses ANTHROPIC_API_KEY (already configured, no billing
//                        blocker). Vision via @anthropic-ai/sdk.
//   'gemini'           — uses GEMINI_API_KEY. Cheapest; re-enable once that
//                        project's billing/credits are restored. REST via global
//                        fetch (no extra dependency).
// The Firestore data model + the { pass, score, reason } contract + the WB T app
// are identical for either provider.
// ───────────────────────────────────────────────────────────────────────────
const GEMINI_VISION_MODEL = 'gemini-2.0-flash';
const CLAUDE_VISION_MODEL = 'claude-sonnet-4-6';

// Per-token USD rates (input, output) for rough per-call cost estimation in the
// metrics log. Update if model/pricing changes — these only affect the logged
// estimatedCostUsd, never behavior.
const VISION_RATES: Record<string, { in: number; out: number }> = {
  'claude-sonnet-4-6': { in: 3 / 1e6, out: 15 / 1e6 },
  'gemini-2.0-flash': { in: 0.10 / 1e6, out: 0.40 / 1e6 },
};

export const validatePhotoCompliance = httpsV2.onCall(
  // Runtime provider switch means either provider is reachable.
  { timeoutSeconds: 60, memory: '512MiB', secrets: [ANTHROPIC_API_KEY, GEMINI_API_KEY] },
  async (request) => {
    const { customerId, requirementId, photoBase64, mimeType, ticketId, invoiceId, driverId, photoStoragePath, companyId, lat, lng, captureTime } = (request.data || {}) as {
      customerId?: string;
      requirementId?: string;
      photoBase64?: string;
      mimeType?: string;
      // Optional client context for the audit record (nullable).
      ticketId?: string;
      invoiceId?: string;
      driverId?: string;
      photoStoragePath?: string;
      companyId?: string;
      // Phase 2 weather context — photo location + capture time (nullable).
      lat?: number;
      lng?: number;
      captureTime?: string;
    };

    if (!customerId || !requirementId || !photoBase64) {
      throw new httpsV2.HttpsError('invalid-argument', 'customerId, requirementId and photoBase64 are required');
    }

    // Provider selection — default Claude (working key, no billing blocker).
    const provider = (process.env.PHOTO_COMPLIANCE_PROVIDER || 'claude').toLowerCase();

    // Audit context — captured as the requirement loads; written (non-blocking)
    // to photo_requirements/{customerId}/validation_audits at the end / on error.
    // Snapshots the EXACT criteria/threshold/version used, so later spec edits
    // don't rewrite history. Never stores image bytes (metadata only).
    let requirementLabel: string | null = null;
    let requirementVersion: number | null = null;
    let criteriaTextUsed: string | null = null;
    let thresholdUsed: number | null = null;
    let requiredCount: number | null = null;
    let phaseUsed: string | null = null;
    const writeAudit = async (fields: Record<string, any>) => {
      try {
        await firestoreDb
          .collection('photo_requirements').doc(customerId)
          .collection('validation_audits').add({
            customerId,
            requirementId,
            requirementLabel,
            requirementVersion,
            criteriaTextUsed,
            proofHintUsed: null,
            thresholdUsed,
            requiredCount,
            phase: phaseUsed,
            ticketId: ticketId || null,
            invoiceId: invoiceId || null,
            driverId: driverId || null,
            companyId: companyId || null,
            photoStoragePath: photoStoragePath || null,
            createdAt: admin.firestore.Timestamp.now(),
            ...fields,
          });
      } catch (e: any) {
        console.warn('[validatePhotoCompliance] audit write failed (non-blocking):', e?.message);
      }
    };

    // 1. Load the requirement spec (single source of truth).
    const specSnap = await firestoreDb.collection('photo_requirements').doc(customerId).get();
    if (!specSnap.exists) {
      throw new httpsV2.HttpsError('not-found', `No photo_requirements for customerId=${customerId}`);
    }
    const spec = specSnap.data() as any;
    const requirement = Array.isArray(spec.requirements)
      ? spec.requirements.find((r: any) => r.id === requirementId)
      : null;
    if (!requirement) {
      throw new httpsV2.HttpsError('not-found', `Requirement ${requirementId} not found for customer ${customerId}`);
    }
    const description: string = requirement.description || requirement.label || 'the required photo';
    const threshold: number = typeof requirement.threshold === 'number' ? requirement.threshold : 80;
    // Snapshot the exact criteria/settings used for the audit record.
    requirementLabel = requirement.label || requirementId;
    requirementVersion = typeof spec.version === 'number' ? spec.version : null;
    criteriaTextUsed = description;
    thresholdUsed = threshold;
    requiredCount = typeof requirement.requiredCount === 'number' ? requirement.requiredCount : 1;
    phaseUsed = requirement.phase || 'any';

    // 2. Resolve the reference (sample) image → base64. Prefer admin Storage
    //    download by path; fall back to fetching a sampleUrl.
    let refBase64: string | null = null;
    let refMime = 'image/jpeg';
    try {
      if (requirement.sampleStoragePath) {
        const file = admin.storage().bucket().file(requirement.sampleStoragePath);
        const [buf] = await file.download();
        refBase64 = buf.toString('base64');
        const [meta] = await file.getMetadata().catch(() => [{ contentType: 'image/jpeg' }] as any);
        if (meta?.contentType) refMime = meta.contentType;
      } else if (requirement.sampleUrl) {
        const resp = await fetch(requirement.sampleUrl);
        if (resp.ok) {
          const ab = await resp.arrayBuffer();
          refBase64 = Buffer.from(ab).toString('base64');
          refMime = resp.headers.get('content-type') || 'image/jpeg';
        }
      }
    } catch (e: any) {
      console.warn('[validatePhotoCompliance] reference image load failed:', e?.message);
    }

    // 3. Build the prompt (shared across providers). Reference image (if
    //    available) anchors the visual; the description is the semantic spec.
    //
    //    TWO SEPARATE JUDGMENTS (do not conflate):
    //    (A) ACCEPTANCE — is the required target AND its immediate surrounding
    //        area DOCUMENTED well enough for a human to review? This is the only
    //        thing that gates pass/retake.
    //    (B) CONCERN — does the photo show anything dispatch/admin should review
    //        (wetness, pooling, sheen, possible spill, active flow)? This is
    //        metadata only; it NEVER fails the photo.
    const prompt =
      `You are reviewing a field-documentation photo for an oilfield water-hauling app.\n` +
      `The REQUIRED photo must DOCUMENT: "${description}".\n` +
      (refBase64
        ? `The first image is a REFERENCE example of a correct photo. The second image is the CANDIDATE taken by the driver.\n`
        : `The image is the CANDIDATE taken by the driver (no reference example — judge against the description).\n`) +
      `\nMake TWO SEPARATE judgments:\n` +
      `\n1) ACCEPTANCE (gates pass/retake). Ask ONLY: "Is the required target AND the immediate surrounding area documented clearly enough for a human to review?"\n` +
      `   accepted = false ONLY for proof/framing problems: wrong subject; the target is not visible; a required connection/cap/hose/truck part is not visible; the immediate surrounding ground/area is not visible; too far away; too blurry/dark/blocked to review.\n` +
      `   accepted = true otherwise — even if the scene looks messy, wet, or imperfect.\n` +
      `   DO NOT set accepted=false because of: wet ground, puddles, mud, rainwater, standing water, pooling, possible spill, oil sheen, or overflow evidence. A photo that clearly documents a wet/spilled condition is GOOD evidence and must be ACCEPTED.\n` +
      `   accepted=false is RARE. Use it ONLY for: the wrong subject, a photo of the floorboard/feet, the sky, an obviously accidental frame, or the required proof CONCLUSIVELY absent. Night, rain, steam, glare, snow, fog, dust, and dirty equipment are NOT failures — if the required thing is plausibly present but hard to confirm, set accepted=TRUE (it becomes a review), NOT a retake.\n` +
      `   score (integer 0-100) = how clearly the target + immediate area are DOCUMENTED (framing, distance, focus, lighting, visibility). It is about REVIEWABILITY, not about condition. Blurry/far/blocked = low score.\n` +
      `\n2) CONCERN (metadata only, never fails). Ask: "Is there anything dispatch/admin should review?"\n` +
      `   concernLevel: "none" | "low" | "medium" | "high".\n` +
      `   - none: clean, nothing notable.\n` +
      `   - low: minor/ambiguous wetness or dampness that could easily be weather/washdown.\n` +
      `   - medium: localized wetness/staining/trail near the connection or equipment that is not obviously weather.\n` +
      `   - high: active fluid flowing/leaking, heavy fresh pooling around the connection, or obvious overflow/spill.\n` +
      `   redFlag = true when concernLevel is medium or high (something a human should look at). Otherwise false.\n` +
      `   concernReason = one short sentence describing the concern, or null when concernLevel is none.\n` +
      `\nREASON WORDING (critical — a truck driver reads this on location):\n` +
      `   Write "reason" as <= 12 words, plain spoken English, prescriptive. State the MISSING proof and, when accepted=false, how to fix it. NAME the specific missing thing (hose connection, Getty lid, ground at the hookup, trailer, etc.).\n` +
      `   - accepted=true AND concernLevel none/low: keep it minimal — "" or "Looks good."\n` +
      `   - accepted=true but hard to confirm (glare/steam/night/angle): "Couldn't confirm <thing>."\n` +
      `   - accepted=false: "<thing> not visible — move closer." (or the real fix: back up, wipe lens, get the connection in frame).\n` +
      `   Do NOT describe the image or list what it contains. NO software words: appears, image, photo, depicts, frame, confidence, analysis, detected, "unable to determine", "the image shows". No essays, no second sentence of narration.\n` +
      `\nRespond ONLY with JSON, no prose:\n` +
      `{"accepted": <true|false>, "score": <integer 0-100>, "reason": "<<=12 words: missing proof + fix; no image description>", "concernLevel": "none|low|medium|high", "concernReason": "<sentence or null>", "redFlag": <true|false>}`;

    const candidateMime = mimeType || 'image/jpeg';
    let modelText: string;
    let usedModel: string;
    let usageIn = 0, usageOut = 0, cacheReadTokens = 0;

    // Structured per-call metrics line — one JSON object, greppable in Cloud
    // Logging as [photo-compliance-metrics]. Covers cost (tokens) + outcome.
    const logMetrics = (extra: Record<string, any>) => {
      try {
        console.log('[photo-compliance-metrics] ' + JSON.stringify({
          provider, model: usedModel, customerId, requirementId,
          hadReference: !!refBase64, ...extra,
        }));
      } catch {}
    };

    // ── Global non-direct-photo guard (anti-cheat / anti-embarrassment) ──────
    // Before scoring criteria, reject OBVIOUS non-field proof: screenshot, photo
    // of a phone/tablet/computer screen, gallery/app-viewer image, UI overlays
    // from another device/app, a photo of a printed or on-screen displayed
    // image, or an edited/collaged image. Conservative — only rejects when
    // clearly non-direct (high confidence). Real field conditions (mud, dust,
    // blur, low light, glare, rain/snow, dirty lens, vibration, awkward angle)
    // are DIRECT and pass through to normal scoring. Fails OPEN on any guard
    // error so a legit photo is never blocked. Not a dashboard setting; not
    // per-requirement; runs for every validation.
    {
      const guardPrompt =
        `You are checking whether a photo is a DIRECT camera photo taken in the field, or a NON-DIRECT image.\n` +
        `NON-DIRECT means: a screenshot; a photo of a phone/tablet/computer screen; a gallery or in-app viewer image; ` +
        `UI overlays/chrome from another device or app; a photo of a printed photo or an image displayed on a screen; or an edited/collaged image.\n` +
        `ALLOW normal oilfield reality as DIRECT: mud, dust, blur, low light, glare, rain, snow, dirty lens, vibration, awkward angle, field clutter.\n` +
        `Be conservative — only say it is non-direct when it is OBVIOUS.\n` +
        `Respond ONLY with JSON: {"direct": <true|false>, "confidence": <integer 0-100>, "reason": "<short>"}.`;
      try {
        const g = await runVisionText(provider, guardPrompt, [{ base64: photoBase64, mime: candidateMime }]);
        let gText = g.text.trim();
        if (gText.startsWith('```')) gText = gText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
        const gParsed = JSON.parse(gText);
        const isDirect = gParsed.direct !== false;
        const gConf = Math.max(0, Math.min(100, Math.round(Number(gParsed.confidence) || 0)));
        if (!isDirect && gConf >= 80) {
          const gRate = VISION_RATES[g.model] || { in: 0, out: 0 };
          const gCost = Number((g.usageIn * gRate.in + g.usageOut * gRate.out).toFixed(6));
          const reason = 'Screen photo not allowed — retake a real field photo.';
          logMetrics({ model: g.model, verdict: 'fail', failType: 'non_direct_photo', score: 0, inputTokens: g.usageIn, outputTokens: g.usageOut, estimatedCostUsd: gCost });
          await writeAudit({ provider, model: g.model, verdict: 'fail', failType: 'non_direct_photo', score: 0, reason, inputTokens: g.usageIn, outputTokens: g.usageOut, estimatedCostUsd: gCost });
          return {
            pass: false,
            passed: false,
            accepted: false,
            outcome: 'retake' as const,
            score: 0,
            threshold,
            reason,
            concernLevel: 'none',
            concernReason: null,
            redFlag: false,
            weatherContextUsed: false,
            weatherSummary: null,
            failType: 'non_direct_photo',
            requirementId,
            provider,
            model: g.model,
            inputTokens: g.usageIn,
            outputTokens: g.usageOut,
            estimatedCostUsd: gCost,
            hadReference: !!refBase64,
            validatedAt: new Date().toISOString(),
          };
        }
      } catch (e: any) {
        // Fail OPEN — never block a legit photo because the guard errored/unparsed.
        console.warn('[validatePhotoCompliance] non-direct guard skipped:', e?.message);
      }
    }

    if (provider === 'gemini') {
      // ── Gemini (REST, global fetch) ──────────────────────────────────────
      const apiKey = readSecret(GEMINI_API_KEY);
      usedModel = GEMINI_VISION_MODEL;
      const parts: any[] = [{ text: prompt }];
      if (refBase64) {
        parts.push({ text: 'REFERENCE:' });
        parts.push({ inline_data: { mime_type: refMime, data: refBase64 } });
        parts.push({ text: 'CANDIDATE:' });
      }
      parts.push({ inline_data: { mime_type: candidateMime, data: photoBase64 } });
      try {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify({
              contents: [{ parts }],
              generationConfig: { temperature: 0, responseMimeType: 'application/json' },
            }),
          },
        );
        if (!resp.ok) {
          const errBody = await resp.text().catch(() => '');
          throw new Error(`Gemini HTTP ${resp.status}: ${errBody.slice(0, 300)}`);
        }
        const json: any = await resp.json();
        modelText = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const um = json?.usageMetadata || {};
        usageIn = Number(um.promptTokenCount) || 0;
        usageOut = Number(um.candidatesTokenCount) || 0;
        if (!modelText) throw new Error('Gemini returned no text');
      } catch (err: any) {
        logRedacted('validatePhotoCompliance.gemini', err);
        const errorReason = String(err?.message || '').slice(0, 200);
        const errorCode = err?.code || err?.status || 'gemini_error';
        logMetrics({ verdict: 'error', errorCode, errorReason });
        await writeAudit({ provider, model: usedModel, verdict: 'error', errorCode, errorReason, inputTokens: usageIn, outputTokens: usageOut });
        throw new httpsV2.HttpsError('internal', 'Photo validation failed: ' + err?.message);
      }
    } else {
      // ── Claude vision (@anthropic-ai/sdk, existing ANTHROPIC_API_KEY) ─────
      const client = createAnthropicClient();
      usedModel = CLAUDE_VISION_MODEL;
      const content: any[] = [{ type: 'text', text: prompt }];
      if (refBase64) {
        content.push({ type: 'text', text: 'REFERENCE:' });
        content.push({ type: 'image', source: { type: 'base64', media_type: refMime, data: refBase64 } });
        content.push({ type: 'text', text: 'CANDIDATE:' });
      }
      content.push({ type: 'image', source: { type: 'base64', media_type: candidateMime, data: photoBase64 } });
      try {
        const message = await client.messages.create({
          model: CLAUDE_VISION_MODEL,
          max_tokens: 300,
          messages: [{ role: 'user', content }],
        });
        const textBlock = message.content.find((b: any) => b.type === 'text');
        modelText = typeof textBlock?.text === 'string' ? textBlock.text : '';
        usageIn = Number(message.usage?.input_tokens) || 0;
        usageOut = Number(message.usage?.output_tokens) || 0;
        cacheReadTokens = Number((message.usage as any)?.cache_read_input_tokens) || 0;
        if (!modelText) throw new Error('Claude returned no text');
      } catch (err: any) {
        logRedacted('validatePhotoCompliance.claude', err);
        const errorReason = String(err?.message || '').slice(0, 200);
        const errorCode = err?.status || err?.code || 'claude_error';
        logMetrics({ verdict: 'error', errorCode, errorReason });
        await writeAudit({ provider, model: usedModel, verdict: 'error', errorCode, errorReason, inputTokens: usageIn, outputTokens: usageOut });
        throw new httpsV2.HttpsError('internal', 'Photo validation failed: ' + err?.message);
      }
    }

    // 4. Parse the two-part judgment. ACCEPTANCE gates pass/retake; CONCERN is
    //    metadata only and never fails the photo.
    let accepted = false;
    let score = 0;
    let reason = '';
    let concernLevel: 'none' | 'low' | 'medium' | 'high' = 'none';
    let concernReason: string | null = null;
    let redFlag = false;
    try {
      let s = modelText.trim();
      if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      const parsed = JSON.parse(s);
      score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)));
      reason = String(parsed.reason || '').slice(0, 200);
      accepted = parsed.accepted === true;
      const lvl = String(parsed.concernLevel || 'none').toLowerCase();
      concernLevel = (['none', 'low', 'medium', 'high'].includes(lvl) ? lvl : 'none') as 'none' | 'low' | 'medium' | 'high';
      concernReason = parsed.concernReason && String(parsed.concernReason).toLowerCase() !== 'null'
        ? String(parsed.concernReason).slice(0, 200) : null;
      // redFlag follows the model, but force it on for medium/high so a concern
      // is never silently dropped even if the model forgets the flag.
      redFlag = parsed.redFlag === true || concernLevel === 'medium' || concernLevel === 'high';
    } catch (e: any) {
      console.error('[validatePhotoCompliance] JSON parse failed. Raw:', modelText.slice(0, 300));
      logMetrics({ verdict: 'error', errorCode: 'parse_error', errorReason: modelText.slice(0, 120), inputTokens: usageIn, outputTokens: usageOut });
      await writeAudit({ provider, model: usedModel, verdict: 'error', errorCode: 'parse_error', errorReason: modelText.slice(0, 120), inputTokens: usageIn, outputTokens: usageOut });
      throw new httpsV2.HttpsError('internal', 'Could not parse validation result');
    }

    // ── Phase 2: weather context ─────────────────────────────────────────────
    // Reduce false red flags from rain. Only matters when there is a wetness
    // concern to explain (low/medium). NEVER touches a high concern (active
    // flow/overflow stays redFlag regardless of weather). Best-effort; any
    // failure leaves the image-only verdict untouched.
    let weatherContextUsed = false;
    let weatherSummary: string | null = null;
    const latNum = typeof lat === 'number' ? lat : parseFloat(String(lat));
    const lngNum = typeof lng === 'number' ? lng : parseFloat(String(lng));
    const haveLoc = Number.isFinite(latNum) && Number.isFinite(lngNum) && !(latNum === 0 && lngNum === 0);
    if (haveLoc && (concernLevel === 'low' || concernLevel === 'medium')) {
      // Prior-24h precipitation via Open-Meteo (free, no key), cached per
      // ~1km cell + hour so a whole pad in one hour costs one API call.
      const getPrior24hPrecipMm = async (latN: number, lngN: number, captureIso: string): Promise<number | null> => {
        const cap = new Date(captureIso);
        const t = isNaN(cap.getTime()) ? new Date() : cap;
        const latR = Math.round(latN * 100) / 100;
        const lngR = Math.round(lngN * 100) / 100;
        const hourBucket = t.toISOString().slice(0, 13).replace(/[-:T]/g, ''); // YYYYMMDDHH
        const cacheRef = firestoreDb.collection('weather_cache').doc(`${latR}_${lngR}_${hourBucket}`);
        try {
          const c = await cacheRef.get();
          if (c.exists && typeof (c.data() as any)?.precip24hMm === 'number') return (c.data() as any).precip24hMm;
        } catch { /* cache miss → fetch */ }
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${latR}&longitude=${lngR}&hourly=precipitation&past_days=2&forecast_days=1&timezone=GMT`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const j: any = await res.json();
        const times: string[] = j?.hourly?.time || [];
        const precs: number[] = j?.hourly?.precipitation || [];
        const endMs = t.getTime();
        const startMs = endMs - 24 * 3600 * 1000;
        let sum = 0;
        for (let i = 0; i < times.length; i++) {
          const ms = new Date(times[i] + 'Z').getTime(); // GMT hourly stamps
          if (ms >= startMs && ms <= endMs) sum += (precs[i] || 0);
        }
        const precip24hMm = Math.round(sum * 100) / 100;
        try {
          await cacheRef.set({ precip24hMm, lat: latR, lng: lngR, hourBucket, fetchedAt: admin.firestore.Timestamp.now() });
        } catch { /* non-blocking */ }
        return precip24hMm;
      };
      try {
        const precipMm = await getPrior24hPrecipMm(latNum, lngNum, captureTime || new Date().toISOString());
        if (precipMm != null) {
          weatherContextUsed = true;
          const inches = precipMm / 25.4;
          const RAIN_MM = 2.5; // ~0.1" in prior 24h is enough to explain wet ground
          if (precipMm >= RAIN_MM) {
            // Rain likely explains the wetness → downgrade one concern level.
            // Entry is guaranteed low|medium, so the result is none|low → not a
            // red flag either way.
            concernLevel = concernLevel === 'medium' ? 'low' : 'none';
            redFlag = false;
            if (concernLevel === 'none') concernReason = null;
            weatherSummary = `Recent rainfall (${inches.toFixed(2)} in last 24h) likely explains wet ground.`;
          } else {
            weatherSummary = `No significant recent rainfall (${inches.toFixed(2)} in last 24h).`;
          }
        }
      } catch (e: any) {
        console.warn('[validatePhotoCompliance] weather lookup skipped:', e?.message);
      }
    }

    // Pass = the photo documents the target+area (accepted) AND is clear enough
    // to review (score meets the requirement's framing-confidence threshold).
    // Condition (wet/spill) lives in concern*, never here.
    const pass = accepted && score >= threshold;
    // 6/20/2026 — driver-facing reason must never contradict the verdict. The
    // model writes "reason" for its ACCEPTANCE judgment (e.g. "Looks good." when
    // accepted/clean) but the photo can still FAIL on score < threshold
    // (framing/clarity below the bar). Showing "Looks good." on a FAIL left
    // drivers reshooting blind (field 6/18-6/19). When the fail is purely
    // score-based (accepted=true but score<threshold) AND the model's reason is
    // empty or non-actionable/positive, replace it with an actionable clarity
    // message that names the target. accepted=false reasons (real missing proof)
    // and already-actionable score-fail reasons (e.g. "Couldn't confirm hose
    // fully seated…") are preserved untouched.
    const NON_ACTIONABLE_REASON = /^\s*(looks good|good|ok|okay|fine|all good|clear|nice)\.?\s*$/i;
    let driverReason = reason;
    if (!pass && accepted && score < threshold && (!reason || NON_ACTIONABLE_REASON.test(reason))) {
      const tgt = requirementLabel || 'the required detail';
      driverReason = `Not clear enough — move closer and hold steady so ${tgt} is sharp, then retake.`;
    }
    // 3-light verdict for the client (advisory mode). Decided here so client +
    // dashboard agree. retake = proof/framing problem; review = accepted but a
    // human should look (concern); verified = clean accepted photo.
    const outcome: 'verified' | 'review' | 'retake' = !pass ? 'retake' : (redFlag ? 'review' : 'verified');
    const rate = VISION_RATES[usedModel] || { in: 0, out: 0 };
    const estimatedCostUsd = Number((usageIn * rate.in + usageOut * rate.out).toFixed(6));
    logMetrics({
      verdict: pass ? 'pass' : 'fail',
      score, threshold,
      inputTokens: usageIn, outputTokens: usageOut, cacheReadTokens,
      estimatedCostUsd,
    });
    await writeAudit({
      provider, model: usedModel,
      verdict: pass ? 'pass' : 'fail',
      accepted, score, reason,           // raw model reason (forensic)
      driverReason,                      // reason actually shown to the driver
      concernLevel, concernReason, redFlag,
      weatherContextUsed, weatherSummary,
      estimatedCostUsd, inputTokens: usageIn, outputTokens: usageOut,
    });

    return {
      pass,             // backward-compat alias of `passed`/`accepted`-gated result
      passed: pass,
      accepted,
      outcome,          // 'verified' | 'review' | 'retake' (advisory 3-light)
      score,
      threshold,
      reason: driverReason,   // driver-facing reason (never "Looks good." on a fail)
      concernLevel,
      concernReason,
      redFlag,
      weatherContextUsed,
      weatherSummary,
      requirementId,
      provider,
      model: usedModel,
      inputTokens: usageIn,
      outputTokens: usageOut,
      estimatedCostUsd,
      hadReference: !!refBase64,
      validatedAt: new Date().toISOString(),
    };
  },
);

// ───────────────────────────────────────────────────────────────────────────
// Photo compliance — AI criteria drafting helper (Phase C-lite).
//
// Given a customer's sample/reference photo, draft field-friendly CRITERIA text
// for that required photo so admins don't have to write it from scratch. This is
// a DRAFTING helper only — the dashboard fills the criteria field; the admin
// reviews/edits/saves. It does NOT touch validatePhotoCompliance, WB T, or the
// data model. Same provider switch (Claude default / Gemini via env).
// ───────────────────────────────────────────────────────────────────────────

/**
 * Single-prompt vision call returning the model's raw text + token usage.
 * Used only by suggestPhotoCriteria (validatePhotoCompliance is left untouched).
 */
async function runVisionText(
  provider: string,
  prompt: string,
  images: { base64: string; mime: string }[],
): Promise<{ text: string; model: string; usageIn: number; usageOut: number }> {
  if (provider === 'gemini') {
    const apiKey = readSecret(GEMINI_API_KEY);
    const parts: any[] = [{ text: prompt }];
    for (const img of images) parts.push({ inline_data: { mime_type: img.mime, data: img.base64 } });
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } }),
      },
    );
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`Gemini HTTP ${resp.status}: ${errBody.slice(0, 300)}`);
    }
    const json: any = await resp.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const um = json?.usageMetadata || {};
    return { text, model: GEMINI_VISION_MODEL, usageIn: Number(um.promptTokenCount) || 0, usageOut: Number(um.candidatesTokenCount) || 0 };
  }
  // Claude (default)
  const client = createAnthropicClient();
  const content: any[] = [{ type: 'text', text: prompt }];
  for (const img of images) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.base64 } });
  const message = await client.messages.create({ model: CLAUDE_VISION_MODEL, max_tokens: 400, messages: [{ role: 'user', content }] });
  const textBlock = message.content.find((b: any) => b.type === 'text');
  const text = typeof textBlock?.text === 'string' ? textBlock.text : '';
  return { text, model: CLAUDE_VISION_MODEL, usageIn: Number(message.usage?.input_tokens) || 0, usageOut: Number(message.usage?.output_tokens) || 0 };
}

export const suggestPhotoCriteria = httpsV2.onCall(
  // Same runtime provider switch (shared runVisionText helper).
  { timeoutSeconds: 60, memory: '512MiB', secrets: [ANTHROPIC_API_KEY, GEMINI_API_KEY] },
  async (request) => {
    const { customerId, requirementId, sampleStoragePath, sampleUrl, label, phase, hint } = (request.data || {}) as {
      customerId?: string;
      requirementId?: string;
      sampleStoragePath?: string;
      sampleUrl?: string;
      label?: string;
      phase?: string;
      hint?: string;
    };

    const provider = (process.env.PHOTO_COMPLIANCE_PROVIDER || 'claude').toLowerCase();

    // Resolve the sample image → base64. Prefer an explicit storage path, then a
    // URL, then look it up on the requirement doc.
    let path = sampleStoragePath || '';
    let url = sampleUrl || '';
    if (!path && !url && customerId && requirementId) {
      const snap = await firestoreDb.collection('photo_requirements').doc(customerId).get();
      const req = snap.exists ? (snap.data() as any).requirements?.find((r: any) => r.id === requirementId) : null;
      path = req?.sampleStoragePath || '';
      url = req?.sampleUrl || '';
    }

    let imgBase64: string | null = null;
    let imgMime = 'image/jpeg';
    try {
      if (path) {
        const file = admin.storage().bucket().file(path);
        const [buf] = await file.download();
        imgBase64 = buf.toString('base64');
        const [meta] = await file.getMetadata().catch(() => [{ contentType: 'image/jpeg' }] as any);
        if (meta?.contentType) imgMime = meta.contentType;
      } else if (url) {
        const resp = await fetch(url);
        if (resp.ok) {
          imgBase64 = Buffer.from(await resp.arrayBuffer()).toString('base64');
          imgMime = resp.headers.get('content-type') || 'image/jpeg';
        }
      }
    } catch (e: any) {
      console.warn('[suggestPhotoCriteria] sample load failed:', e?.message);
    }
    if (!imgBase64) {
      throw new httpsV2.HttpsError('not-found', 'No sample image available to analyze. Upload a sample first.');
    }

    const ctx: string[] = [];
    if (label) ctx.push(`The label (PRIMARY intent) is "${label}".`);
    if (phase && phase !== 'any') ctx.push(`It is taken at the ${phase} stage of the job.`);
    if (hint) ctx.push(`What the admin is trying to prove (use this as the main intent): ${hint}`);

    const prompt =
      `You help an oilfield water-hauling company write SIMPLE criteria for a required driver photo. ` +
      `The LABEL (and the admin's "trying to prove" hint, if given) is the real intent. The SAMPLE image is only an EXAMPLE of the subject — it is NOT a source of extra mandatory requirements.\n` +
      (ctx.length ? ctx.join(' ') + '\n' : '') +
      `Write criteria describing ONLY what must be REASONABLY VISIBLE to satisfy that intent. Hard rules:\n` +
      `- Do NOT invent requirements that are not clearly necessary. Do NOT infer hidden intent from the sample.\n` +
      `- Do NOT require object state (open/closed, full/empty, on/off), exact angle, framing, lighting, or extra details UNLESS the label or hint explicitly implies that purpose.\n` +
      `- Do NOT add operational conditions (e.g. "no spill or leak", "lid closed", "gauge legible") unless the label or hint clearly implies that purpose.\n` +
      `- Prefer the simplest visible-evidence criteria: the subject named by the label must be reasonably visible / identifiable.\n` +
      `- Always allow field conditions (mud, snow, ice, darkness, rain, glare, dust, clutter) as long as the subject is still reasonably identifiable. No beauty shots.\n` +
      `Examples:\n` +
      `- Label "Rockstar Can" (sample: a can) → "Photo must show a Rockstar energy drink can that is reasonably visible and identifiable. Low light, glare, or background clutter are acceptable if the can can still be reasonably identified." (Do NOT require the can to be open or the top/pull-tab visible.)\n` +
      `- Label "Getty Box After Load" (sample: closed box) → only then is lid/spill relevant: "Getty box after load completion with the lid closed. The Getty box and surrounding ground should be reasonably visible to confirm no visible spill or leak. Mud, snow, ice, darkness, or other field conditions are acceptable if the box and surrounding condition can still be reasonably seen."\n` +
      `Respond ONLY with JSON: {"criteria": "<1-3 sentence description>", "suggestedThreshold": <integer 60-85>, "notes": "<one short optional tip for the admin>"}.`;

    let modelText: string;
    let usedModel: string;
    let usageIn = 0, usageOut = 0;
    try {
      const r = await runVisionText(provider, prompt, [{ base64: imgBase64, mime: imgMime }]);
      modelText = r.text;
      usedModel = r.model;
      usageIn = r.usageIn;
      usageOut = r.usageOut;
      if (!modelText) throw new Error('Model returned no text');
    } catch (err: any) {
      logRedacted('suggestPhotoCriteria.vision', err);
      throw new httpsV2.HttpsError('internal', 'Criteria suggestion failed: ' + err?.message);
    }

    let criteria = '';
    let suggestedThreshold: number | undefined;
    let notes: string | undefined;
    try {
      let s = modelText.trim();
      if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      const parsed = JSON.parse(s);
      criteria = String(parsed.criteria || '').slice(0, 600);
      if (typeof parsed.suggestedThreshold === 'number') suggestedThreshold = Math.max(0, Math.min(100, Math.round(parsed.suggestedThreshold)));
      if (parsed.notes) notes = String(parsed.notes).slice(0, 200);
    } catch (e: any) {
      // Model returned prose, not JSON — use it directly as the criteria draft.
      criteria = modelText.trim().slice(0, 600);
    }
    if (!criteria) throw new httpsV2.HttpsError('internal', 'Could not draft criteria from the sample');

    const rate = VISION_RATES[usedModel] || { in: 0, out: 0 };
    const estimatedCostUsd = Number((usageIn * rate.in + usageOut * rate.out).toFixed(6));
    console.log('[photo-compliance-metrics] ' + JSON.stringify({
      fn: 'suggestPhotoCriteria', provider, model: usedModel, customerId, requirementId,
      inputTokens: usageIn, outputTokens: usageOut, estimatedCostUsd,
    }));

    return { criteria, suggestedThreshold, notes, provider, model: usedModel, estimatedCostUsd };
  },
);

