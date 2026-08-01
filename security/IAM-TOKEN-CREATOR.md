# IAM least-privilege for createCustomToken (signBlob)

**Project:** `wellbuilt-sync`  
**Date:** 2026-08-01  
**Status:** Applied and verified in production

## Runtime identity

| Item | Value |
|------|--------|
| Gen2 runtime service account | `559487114498-compute@developer.gserviceaccount.com` |
| Token signing identity | Same SA (Admin SDK `createCustomToken` signs as the runtime SA) |
| IAM Credentials API | `iamcredentials.googleapis.com` = **ENABLED** |
| JSON keys downloaded | **None** |
| Project-wide Owner/Editor grant | **None** for this purpose |

## Before (empty SA resource policy)

```json
{
  "etag": "ACAB",
  "bindings": []
}
```

(Resource: `projects/wellbuilt-sync/serviceAccounts/559487114498-compute@developer.gserviceaccount.com`)

## After (scoped Token Creator self-bind)

```json
{
  "version": 1,
  "etag": "BwZX86Xp3gs=",
  "bindings": [
    {
      "role": "roles/iam.serviceAccountTokenCreator",
      "members": [
        "serviceAccount:559487114498-compute@developer.gserviceaccount.com"
      ]
    }
  ]
}
```

## Exact operation

Resource-scoped only (not project IAM):

```text
gcloud iam service-accounts add-iam-policy-binding \
  559487114498-compute@developer.gserviceaccount.com \
  --project=wellbuilt-sync \
  --member="serviceAccount:559487114498-compute@developer.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"
```

API enablement:

```text
gcloud services enable iamcredentials.googleapis.com --project=wellbuilt-sync
```

Verified 2026-08-01 via `projects.serviceAccounts.getIamPolicy` (HTTP 200) and live
`authenticateDriver` returning `mintMethod=custom_token`.
