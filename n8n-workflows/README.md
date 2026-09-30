# n8n workflows for CRM marketing

Four ready-to-import workflows that connect the CRM's marketing module to n8n. All traffic in both directions is HMAC-signed: `x-mkt-signature: sha256=hex(HMAC_SHA256(secret, "<x-mkt-timestamp>.<raw body>"))`, with a 5-minute window.

| File | Trigger | What it does |
|---|---|---|
| `social-publish.json` | `POST /webhook/social-publish` (from the CRM) | Verifies the package, replies 202, publishes to Facebook, Instagram or TikTok, then calls back `post.published` or `post.failed`. |
| `video-render.json` | `POST /webhook/video-render` (from the CRM) | Verifies the payload, replies 202, reports `render.started`, calls your render service, then reports `render.completed` or `render.failed`. |
| `dispatch-tick.json` | Every minute | Sends a signed `POST {CRM_BASE_URL}/api/marketing/webhooks/dispatch` so the CRM dispatches due posts and queued renders. |
| `sync-metrics.json` | Every 6 hours, or run manually | Sends signed engagement metrics per post (views, clicks, likes…) to `POST {CRM_BASE_URL}/api/marketing/webhooks/metrics`. The fetch step is a **simulation**; replace it with real insights calls. |

Callbacks go to the `callback.url` inside each package, which is `{MARKETING_PUBLIC_BASE_URL}/api/marketing/webhooks/n8n`. If a package has no callback URL, the workflows fall back to `{CRM_BASE_URL}/api/marketing/webhooks/n8n`.

## 1. Environment variables

**On the n8n server** (then restart n8n):

```bash
MARKETING_N8N_OUTBOUND_SECRET=<same value as the CRM>    # verifies CRM -> n8n
MARKETING_N8N_INBOUND_SECRET=<same value as the CRM>     # signs n8n -> CRM
CRM_BASE_URL=https://crm.example.com                     # public https origin of the CRM
RENDER_API_URL=https://render.example.com/v1/render      # only for video-render
SIMULATED_POST_IDS=<post id>,<post id>                  # only for sync-metrics while it is simulated
TIKTOK_PRIVACY_LEVEL=SELF_ONLY                           # optional; PUBLIC_TO_EVERYONE once your TikTok app is audited
NODE_FUNCTION_ALLOW_BUILTIN=crypto                       # lets the Code nodes use require('crypto')
N8N_BLOCK_ENV_ACCESS_IN_NODE=false                       # lets the Code nodes read $env
```

**In the CRM** (see `.env.example`): set `MARKETING_ENABLED=true` and `N8N_MARKETING_WEBHOOK_URL=https://n8n.example.com/webhook`. The CRM appends `/social-publish` and `/video-render` to that URL itself. Also set the two `MARKETING_N8N_*_SECRET` values and `MARKETING_PUBLIC_BASE_URL`, plus `MARKETING_MEDIA_URL_SECRET` so n8n and the platforms can fetch images.

Generate each secret with `openssl rand -hex 32`. Use different values for the outbound and inbound secrets.

## 2. Credentials

Create these in n8n under **Credentials → New**. Use the names below and import picks them up automatically; otherwise select them on the flagged nodes.

| Name | Type | Values |
|---|---|---|
| `Meta Graph API (access_token)` | Query Auth | Name `access_token`, Value = a long-lived **Page** access token with `pages_manage_posts` and `instagram_content_publish`. |
| `TikTok Content Posting (Bearer)` | Header Auth | Name `Authorization`, Value `Bearer <access token with video.publish>`. |
| `Render API (header)` | Header Auth | Whatever header your render provider needs (e.g. `Authorization: Bearer …`). |

Platform tokens live **only in n8n**, never in the CRM. The CRM's social account records store the Page ID or Instagram business account ID as `externalAccountId`, and the n8n credential **name** as `n8nCredentialRef`.

## 3. Import and activate

1. In n8n, go to **Workflows → Import from File** and import each JSON.
2. Open each workflow and fix any credential warnings (step 2).
3. For `video-render.json`, adapt the **Render service** node to your provider. It must return `{ url (https), width, height, durationSec, sizeBytes?, mimeType? }`. Providers that render asynchronously (Creatomate, Shotstack…) need a poll loop added before **Build render.completed**.
4. **Activate** `social-publish` and `video-render` first, then `dispatch-tick`. Deduplication uses workflow static data, which only persists for active workflows.

## 4. Check it works

- **Dispatch:** the dispatch-tick executions should show a `200` response with `{ "ran": true, ... }`. A `401` means the inbound secret doesn't match; a `503` means marketing is disabled in the CRM.
- **End-to-end:** in the CRM, approve a post and schedule it one minute out.
  - n8n should log a `social-publish` execution.
  - The post then moves to **Published**, with a permalink, in *Marketing → Social posts*.
  - A `Reject` response node firing means the signature or schema check failed; its response body gives the reason.
- **Contract tests:** `npx vitest run tests/n8n-workflows.test.ts` checks that these workflows' signing matches the CRM's.

## Limitations

- Posts use the first media item only; carousels are not supported yet.
- Instagram waits 5 s (image) or 60 s (reel) before publishing. A long video that's still processing fails, and you can retry it from the CRM.
- TikTok `PULL_FROM_URL` requires the media domain (`MARKETING_PUBLIC_BASE_URL`) to be verified in your TikTok developer app.
- One Meta credential serves every Page it has tokens for. For separate business accounts, duplicate the branch with another credential.
- `sync-metrics` only simulates platform data. The CRM endpoint accepts `{ eventId, postId, periodStart, periodEnd, metrics: { impressions, reach, views, clicks, likes, comments, shares, saves, conversions } }` for **PUBLISHED** posts (404 unknown post, 422 not published). Engagements are stored as likes + comments + shares + saves, and the per-type breakdown is kept in `raw`.
