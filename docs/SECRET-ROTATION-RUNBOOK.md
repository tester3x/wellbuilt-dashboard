# Provider credential rotation and cutover

vc51.9I-SEC. Local preparation is complete; every step below is a **live
operation Mike performs**. Nothing here has been executed.

> **Never paste a key value into a chat, an agent session, a terminal that
> is being transcribed, a file in this repository, or a commit message.**
> Values go directly from the provider console into Secret Manager.

## Why this exists

A local `firebase functions:list --json` dump (`functions/_phase1-deployed.json`)
sat untracked inside `functions/`. Those dumps embed every function's
`environmentVariables` verbatim, so it contained the live Anthropic and
Gemini API keys — untracked but committable, on a branch 37 commits ahead,
and uploadable on the next deploy because `firebase.json` declared no
ignore list. The file has been permanently deleted and all three
boundaries closed, but **the two keys were exposed and must be replaced.**

## Current state

| | Status |
|---|---|
| Exposed keys | Anthropic + Gemini. **Still live.** Not created, validated, changed, or revoked by this work. |
| Deployed Functions | Still carry the **old plaintext env values**. Unchanged by this packet. |
| Source | `parseJsaPdf` binds `ANTHROPIC_API_KEY` from Secret Manager. No plaintext fallback exists. |
| Gemini | No consumer in source, so **no binding was created**. |
| Firebase Web API key | Public project config by design. Not part of this incident. Do not rotate as part of it. |

## Least-privilege target

| Secret | Bound to | Rationale |
|---|---|---|
| `ANTHROPIC_API_KEY` | `parseJsaPdf` only | The only Function that constructs an Anthropic client. |
| `GEMINI_API_KEY` | *nothing* | Zero consumers found. Do not create a Secret Manager entry for it. |

If a Gemini consumer is genuinely introduced later, define it in
`functions/src/secrets.ts` and bind it to that Function alone.

## Cutover

Order matters. **Do not revoke anything until step 9.**

1. Create **one** replacement Anthropic key in the Anthropic Console.
2. Create **one** replacement Gemini key in Google AI Studio / GCP — *only
   if a Gemini consumer exists.* Today none does; skip this step and skip
   every Gemini step below.
3. Put the Anthropic value into Secret Manager. Use an interactive prompt
   so the value is never in shell history or agent output:
   ```bash
   firebase functions:secrets:set ANTHROPIC_API_KEY
   ```
4. Deploy only the bound Function, so the blast radius is one:
   ```bash
   firebase deploy --only functions:parseJsaPdf
   ```
5. Exercise the JSA PDF parse path through the app and confirm a normal
   successful extraction.
6. Check logs for the redacted markers only. A missing secret logs
   `failed-precondition` naming `ANTHROPIC_API_KEY`; an upstream failure
   logs through `redact()`. **No log line should ever contain key
   material** — if one does, stop and treat it as a new incident.
7. Confirm the deployed Function no longer carries plaintext provider env
   vars:
   ```bash
   gcloud functions describe parseJsaPdf --gen2 --region us-central1 --format=yaml
   ```
   Expect `ANTHROPIC_API_KEY` to appear as a secret reference, not a value,
   and `GEMINI_API_KEY` to be absent.
8. Redeploy the remaining Functions so the other 50 drop their unused
   plaintext `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` bindings.
9. **Now** revoke the old keys — Anthropic first, then Gemini.
10. Review each provider's usage / last-used history for activity that is
    not yours, covering the whole window the keys were on disk.
11. Regenerate a deployment inventory **without** environment values, e.g.
    `gcloud functions list --format="table(name,state,updateTime)"`. Never
    re-create a full `--json` dump inside the repository; all three ignore
    layers now block it, but the safer habit is not to generate it there.
12. Re-run the guards:
    ```bash
    node tools/test-functionsDeployBoundary.mjs && node tools/test-providerSecrets.mjs
    ```

## Rollback

- **Do not revoke old keys before step 8 verifies.** The old plaintext
  values remain live precisely so a failed cutover has somewhere to fall
  back to.
- If the replacement path fails, roll back by redeploying the previous
  revision. Roll back *code and bindings* — never by restoring key values
  into a file, an env var, or a deployment inventory.
- Never reintroduce either exposed key into source, configuration, or a
  local inventory. They are burned regardless of whether the deletion
  happened before anyone else read them.
- A failed deploy leaves the old revision serving. Verify with step 7
  before assuming the cutover took effect.

## After cutover

`parseJsaPdf` fails closed if `ANTHROPIC_API_KEY` is unset or blank,
returning `failed-precondition` that names the secret to set and carries
no value. Every other Function loads and operates normally without either
secret — proven by `tools/test-providerSecrets.mjs`.
