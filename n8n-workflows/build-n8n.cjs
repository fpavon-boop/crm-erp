// Generates the importable n8n workflow JSONs in this folder: `node n8n-workflows/build-n8n.cjs`.
// Edit this file, not the JSONs; tests/n8n-workflows.test.ts checks the output against the CRM.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OUT = process.argv[2] || __dirname;
const uid = (seed) => {
  const h = crypto.createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

function workflow(name, nodes, edges) {
  const connections = {};
  for (const [from, to, output = 0] of edges) {
    connections[from] ??= { main: [] };
    while (connections[from].main.length <= output) connections[from].main.push([]);
    connections[from].main[output].push({ node: to, type: 'main', index: 0 });
  }
  return {
    name,
    nodes: nodes.map((n) => ({ id: uid(`${name}/${n.name}`), ...n })),
    connections,
    settings: { executionOrder: 'v1', saveManualExecutions: true },
    pinData: {},
    active: false,
    tags: [{ name: 'crm-erp-marketing' }],
  };
}

const code = (name, jsCode, position) => ({ name, type: 'n8n-nodes-base.code', typeVersion: 2, position, parameters: { jsCode } });
const note = (name, content, position, width = 420, height = 260) => ({
  name,
  type: 'n8n-nodes-base.stickyNote',
  typeVersion: 1,
  position,
  parameters: { content, width, height },
});
const ifOk = (name, position) => ({
  name,
  type: 'n8n-nodes-base.if',
  typeVersion: 2,
  position,
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
      conditions: [{ id: uid(name), leftValue: '={{ $json.ok }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      combinator: 'and',
    },
    options: {},
  },
});
const respond = (name, code, body, position) => ({
  name,
  type: 'n8n-nodes-base.respondToWebhook',
  typeVersion: 1.1,
  position,
  parameters: { respondWith: 'json', responseBody: body, options: { responseCode: code } },
});
const webhook = (name, pathName, position) => ({
  name,
  type: 'n8n-nodes-base.webhook',
  typeVersion: 2,
  position,
  webhookId: uid(`webhook/${pathName}`),
  parameters: { httpMethod: 'POST', path: pathName, responseMode: 'responseNode', options: { rawBody: true } },
});
/** POST a pre-signed raw JSON body ($json.url / $json.body / $json.timestamp / $json.signature). */
const signedPost = (name, position, extra = {}) => ({
  name,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position,
  retryOnFail: true,
  maxTries: 5,
  waitBetweenTries: 5000,
  ...extra,
  parameters: {
    method: 'POST',
    url: '={{ $json.url }}',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'x-mkt-timestamp', value: '={{ $json.timestamp }}' },
        { name: 'x-mkt-signature', value: '={{ $json.signature }}' },
      ],
    },
    sendBody: true,
    contentType: 'raw',
    rawContentType: 'application/json',
    body: '={{ $json.body }}',
    options: { timeout: 300000 },
  },
});
/** Graph/TikTok API call with a JSON body built upstream in $json.request. */
const apiCall = (name, position, auth) => ({
  name,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position,
  onError: 'continueErrorOutput',
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 5000,
  credentials: { [auth.type]: { name: auth.credential } },
  parameters: {
    method: '={{ $json.request.method || "POST" }}',
    url: '={{ $json.request.url }}',
    authentication: 'genericCredentialType',
    genericAuthType: auth.type,
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.request.body || {}) }}',
    options: { timeout: 120000 },
  },
});
const getCall = (name, position, auth, url) => ({
  name,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position,
  onError: 'continueErrorOutput',
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 5000,
  credentials: { [auth.type]: { name: auth.credential } },
  parameters: { url, authentication: 'genericCredentialType', genericAuthType: auth.type, options: {} },
});

// -----------------------------------------------------------------------------
// Shared code snippets
// -----------------------------------------------------------------------------

const verify = (schema) => `// Verifies the CRM's HMAC signature (MARKETING_N8N_OUTBOUND_SECRET) over the RAW body:
// signature = "sha256=" + hex(HMAC_SHA256(secret, timestamp + "." + rawBody)), 5-minute window.
// Also enforces the payload schema, matches x-mkt-job-id, and dedupes on the Idempotency-Key.
const crypto = require('crypto');
const secret = $env.MARKETING_N8N_OUTBOUND_SECRET;
const item = $input.first();
const headers = item.json.headers || {};
const fail = (status, reason) => [{ json: { ok: false, status, reason } }];

let raw;
try {
  raw = (await this.helpers.getBinaryDataBuffer(0, 'data')).toString('utf8');
} catch (e) {
  // Webhook "Raw Body" disabled: the CRM sends canonical JSON, which re-serializes identically.
  raw = JSON.stringify(item.json.body);
}

if (!secret || secret.length < 32) return fail(500, 'MARKETING_N8N_OUTBOUND_SECRET is not set on n8n');
const ts = headers['x-mkt-timestamp'];
const sig = headers['x-mkt-signature'];
if (!ts || !sig) return fail(401, 'missing signature headers');
if (!/^\\d{1,12}$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return fail(401, 'stale or invalid timestamp');
const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(ts + '.' + raw).digest('hex');
const a = Buffer.from(String(sig));
const b = Buffer.from(expected);
if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail(401, 'bad signature');

let pkg;
try {
  pkg = JSON.parse(raw);
} catch (e) {
  return fail(400, 'body is not JSON');
}
if (pkg.schema !== '${schema}') return fail(400, 'unexpected schema ' + pkg.schema);
if (headers['x-mkt-job-id'] && headers['x-mkt-job-id'] !== pkg.jobId) return fail(400, 'job id header does not match body');

// At-least-once delivery from the CRM: answer 409 for a job we already accepted
// (the CRM treats 409 as delivered). Static data persists for ACTIVE workflows.
const store = $getWorkflowStaticData('global');
store.jobs = store.jobs || {};
const key = headers['idempotency-key'] || pkg.jobId;
if (store.jobs[key]) return fail(409, 'duplicate job ' + key);
store.jobs[key] = Date.now();
const keys = Object.keys(store.jobs);
if (keys.length > 1000) keys.sort((x, y) => store.jobs[x] - store.jobs[y]).slice(0, keys.length - 1000).forEach((k) => delete store.jobs[k]);

return [{ json: { ok: true, jobId: pkg.jobId, pkg } }];`;

/** Builds + signs one CRM callback event from $json.event (type/data). */
const signCallback = (verifyNode) => `// Signs a CRM callback with MARKETING_N8N_INBOUND_SECRET. The body sent must be
// byte-identical to the signed string, so the HTTP node sends it as a raw body.
// eventId is stable per execution + event type, so n8n retries dedupe in the CRM.
const crypto = require('crypto');
const secret = $env.MARKETING_N8N_INBOUND_SECRET;
if (!secret || secret.length < 32) throw new Error('MARKETING_N8N_INBOUND_SECRET is not set on n8n');
const pkg = $('${verifyNode}').first().json.pkg;
const url = (pkg.callback && pkg.callback.url) || (($env.CRM_BASE_URL || '').replace(/\\/$/, '') + '/api/marketing/webhooks/n8n');
if (!/^https?:\\/\\//.test(url)) throw new Error('No callback URL: set MARKETING_PUBLIC_BASE_URL in the CRM or CRM_BASE_URL in n8n');

const { type, data } = $input.first().json.event;
const event = { eventId: $execution.id + ':' + type, type, jobId: pkg.jobId, data };
const body = JSON.stringify(event);
const timestamp = Math.floor(Date.now() / 1000).toString();
const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex');
return [{ json: { url, body, timestamp, signature, event } }];`;

const errorText = `const err = $input.first().json.error;
const msg = typeof err === 'string' ? err : (err && (err.message || err.description)) || JSON.stringify($input.first().json).slice(0, 1000);`;

// -----------------------------------------------------------------------------
// 1. Social publish
// -----------------------------------------------------------------------------

const V1 = 'Verify CRM signature';
const GRAPH = 'https://graph.facebook.com/v21.0';
const meta = { type: 'httpQueryAuth', credential: 'Meta Graph API (access_token)' };
const tiktok = { type: 'httpHeaderAuth', credential: 'TikTok Content Posting (Bearer)' };

const social = workflow(
  'CRM Marketing · Social publish',
  [
    note(
      'About',
      '## CRM → n8n: social publish\nReceives `marketing.social.publish/v1` packages from the CRM dispatcher at `POST /webhook/social-publish`, verifies the HMAC signature, answers **202** immediately, publishes to Facebook / Instagram / TikTok, then calls the CRM back with a signed `post.published` or `post.failed` event.\n\nThe CRM only sends ADMIN-approved, safeguard-checked posts. See `n8n-workflows/README.md`.',
      [-260, -260],
      520,
      240
    ),
    webhook('CRM webhook', 'social-publish', [0, 100]),
    code(V1, verify('marketing.social.publish/v1'), [220, 100]),
    ifOk('Signature OK?', [440, 100]),
    respond('Reject', '={{ $json.status }}', '={{ JSON.stringify({ error: $json.reason }) }}', [660, 300]),
    respond('Accept (202)', 202, '={{ JSON.stringify({ accepted: true, jobId: $json.jobId }) }}', [660, 20]),
    code(
      'Route by platform',
      `// One item per platform branch; media[0] decides photo vs video (carousels post the first item).
const pkg = $input.first().json.pkg;
const media = (pkg.media || [])[0] || null;
const caption = pkg.post.caption || '';
const acct = pkg.account.externalAccountId;
let request = null;
if (pkg.platform === 'FACEBOOK') {
  if (media && media.type === 'VIDEO') request = { url: '${GRAPH}/' + acct + '/videos', body: { file_url: media.url, description: caption } };
  else if (media) request = { url: '${GRAPH}/' + acct + '/photos', body: { url: media.url, caption } };
  else request = { url: '${GRAPH}/' + acct + '/feed', body: { message: caption } };
} else if (pkg.platform === 'INSTAGRAM') {
  if (media && media.type === 'VIDEO') request = { url: '${GRAPH}/' + acct + '/media', body: { media_type: 'REELS', video_url: media.url, caption } };
  else if (media) request = { url: '${GRAPH}/' + acct + '/media', body: { image_url: media.url, caption } };
} else if (pkg.platform === 'TIKTOK') {
  if (media && media.type === 'VIDEO') {
    request = {
      url: 'https://open.tiktokapis.com/v2/post/publish/video/init/',
      body: {
        post_info: { title: caption.slice(0, 2200), privacy_level: $env.TIKTOK_PRIVACY_LEVEL || 'SELF_ONLY', disable_comment: false, disable_duet: false, disable_stitch: false },
        source_info: { source: 'PULL_FROM_URL', video_url: media.url },
      },
    };
  }
}
const unsupported = request ? null : pkg.platform + ' needs ' + (pkg.platform === 'TIKTOK' ? 'a video' : 'an image or video') + ' for this workflow';
return [{ json: { platform: pkg.platform, isVideo: !!(media && media.type === 'VIDEO'), request, unsupported } }];`,
      [880, 20]
    ),
    {
      name: 'Platform',
      type: 'n8n-nodes-base.switch',
      typeVersion: 3,
      position: [1100, 20],
      parameters: {
        rules: {
          values: ['FACEBOOK', 'INSTAGRAM', 'TIKTOK'].map((p) => ({
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [{ id: uid('sw' + p), leftValue: '={{ $json.unsupported ? "UNSUPPORTED" : $json.platform }}', rightValue: p, operator: { type: 'string', operation: 'equals' } }],
              combinator: 'and',
            },
            renameOutput: true,
            outputKey: p,
          })),
        },
        options: { fallbackOutput: 'extra', renameFallbackOutput: 'Unsupported' },
      },
    },
    apiCall('Facebook: publish', [1340, -200], meta),
    code(
      'Facebook: result',
      `const r = $input.first().json;
const id = r.post_id || r.id;
if (!id) throw new Error('Facebook returned no post id: ' + JSON.stringify(r).slice(0, 500));
return [{ json: { event: { type: 'post.published', data: { externalPostId: String(id), permalink: 'https://www.facebook.com/' + id } } } }];`,
      [1560, -220]
    ),
    apiCall('Instagram: create container', [1340, 20], meta),
    {
      name: 'Instagram: wait for processing',
      type: 'n8n-nodes-base.wait',
      typeVersion: 1.1,
      position: [1560, 0],
      webhookId: uid('wait/ig'),
      parameters: { resume: 'timeInterval', amount: "={{ $('Route by platform').first().json.isVideo ? 60 : 5 }}", unit: 'seconds' },
    },
    code(
      'Instagram: publish request',
      `const pkg = $('${V1}').first().json.pkg;
const creationId = $('Instagram: create container').first().json.id;
return [{ json: { request: { url: '${GRAPH}/' + pkg.account.externalAccountId + '/media_publish', body: { creation_id: creationId } } } }];`,
      [1780, 0]
    ),
    apiCall('Instagram: publish', [2000, 0], meta),
    getCall('Instagram: permalink', [2220, -20], meta, `=${GRAPH}/{{ $json.id }}?fields=permalink`),
    code(
      'Instagram: result',
      `const id = $('Instagram: publish').first().json.id;
const permalink = $input.first().json.permalink;
return [{ json: { event: { type: 'post.published', data: permalink ? { externalPostId: String(id), permalink } : { externalPostId: String(id) } } } }];`,
      [2440, -40]
    ),
    apiCall('TikTok: publish', [1340, 240], tiktok),
    code(
      'TikTok: result',
      `// TikTok publishes asynchronously; the publish_id is the stable external reference.
const r = $input.first().json;
const err = r.error && r.error.code && r.error.code !== 'ok' ? r.error : null;
if (err) throw new Error('TikTok: ' + err.code + ' ' + (err.message || ''));
const id = r.data && r.data.publish_id;
if (!id) throw new Error('TikTok returned no publish_id: ' + JSON.stringify(r).slice(0, 500));
return [{ json: { event: { type: 'post.published', data: { externalPostId: String(id) } } } }];`,
      [1560, 220]
    ),
    code(
      'Build post.failed',
      `// Any failed platform call (after retries), unsupported media, or a result node error.
${errorText}
const unsupported = $('Route by platform').first().json.unsupported;
return [{ json: { event: { type: 'post.failed', data: { error: String(unsupported || msg).slice(0, 4000) } } } }];`,
      [2440, 440]
    ),
    code('Sign callback', signCallback(V1), [2700, 100]),
    signedPost('Send callback to CRM', [2920, 100]),
  ].map((n) => (['Facebook: result', 'Instagram: result', 'TikTok: result'].includes(n.name) ? { ...n, onError: 'continueErrorOutput' } : n)),
  [
    ['CRM webhook', V1],
    [V1, 'Signature OK?'],
    ['Signature OK?', 'Accept (202)', 0],
    ['Signature OK?', 'Reject', 1],
    ['Accept (202)', 'Route by platform'],
    ['Route by platform', 'Platform'],
    ['Platform', 'Facebook: publish', 0],
    ['Platform', 'Instagram: create container', 1],
    ['Platform', 'TikTok: publish', 2],
    ['Platform', 'Build post.failed', 3],
    ['Facebook: publish', 'Facebook: result', 0],
    ['Facebook: publish', 'Build post.failed', 1],
    ['Facebook: result', 'Sign callback', 0],
    ['Facebook: result', 'Build post.failed', 1],
    ['Instagram: create container', 'Instagram: wait for processing', 0],
    ['Instagram: create container', 'Build post.failed', 1],
    ['Instagram: wait for processing', 'Instagram: publish request'],
    ['Instagram: publish request', 'Instagram: publish'],
    ['Instagram: publish', 'Instagram: permalink', 0],
    ['Instagram: publish', 'Build post.failed', 1],
    ['Instagram: permalink', 'Instagram: result', 0],
    // Published but permalink lookup failed: still report success (without permalink).
    ['Instagram: permalink', 'Instagram: result', 1],
    ['Instagram: result', 'Sign callback', 0],
    ['Instagram: result', 'Build post.failed', 1],
    ['TikTok: publish', 'TikTok: result', 0],
    ['TikTok: publish', 'Build post.failed', 1],
    ['TikTok: result', 'Sign callback', 0],
    ['TikTok: result', 'Build post.failed', 1],
    ['Build post.failed', 'Sign callback'],
    ['Sign callback', 'Send callback to CRM'],
  ]
);

// -----------------------------------------------------------------------------
// 2. Video render
// -----------------------------------------------------------------------------

const V2 = 'Verify CRM signature';
const CREATOMATE_RENDERS = 'https://api.creatomate.com/v1/renders';
const render = workflow(
  'CRM Marketing · Video render',
  [
    note(
      'About',
      '## CRM → n8n: video render (Creatomate)\nReceives `marketing.video.render/v1` payloads at `POST /webhook/video-render`, verifies the HMAC signature, answers **202** and reports `render.started`.\n\nThen it starts a Creatomate render of `CREATOMATE_TEMPLATE_ID` (elements `Product_Name`, `Price`, `Product_Image`) with this execution\'s **Wait** URL as `webhook_url`, and pauses until Creatomate calls it (30 min limit). It then **re-fetches the render from the Creatomate API** (the webhook body is unsigned, so it is not trusted) and reports `render.completed` or `render.failed`.',
      [-260, -320],
      600,
      300
    ),
    webhook('CRM webhook', 'video-render', [0, 100]),
    code(V2, verify('marketing.video.render/v1'), [220, 100]),
    ifOk('Signature OK?', [440, 100]),
    respond('Reject', '={{ $json.status }}', '={{ JSON.stringify({ error: $json.reason }) }}', [660, 300]),
    respond('Accept (202)', 202, '={{ JSON.stringify({ accepted: true, jobId: $json.jobId }) }}', [660, 20]),
    code('Build render.started', `return [{ json: { event: { type: 'render.started', data: {} } } }];`, [880, 20]),
    code('Sign render.started', signCallback(V2), [1100, 20]),
    signedPost('Send render.started', [1320, 20], { onError: 'continueRegularOutput' }),
    {
      ...code(
        'Creatomate modifications',
        `// Maps the CRM render payload onto the Creatomate template's elements:
// Product_Name / Price come from the CRM template fields (price already formatted,
// promo price preferred), Product_Image from the first IMAGE asset in the scenes.
if (!$env.CREATOMATE_API_KEY || !$env.CREATOMATE_TEMPLATE_ID) throw new Error('Set CREATOMATE_API_KEY and CREATOMATE_TEMPLATE_ID on n8n');
const pkg = $('${V2}').first().json.pkg;
const fields = (pkg.template && pkg.template.fields) || {};
const image = (pkg.scenes || []).map((s) => s.asset).find((a) => a && a.type === 'IMAGE');
if (!image) throw new Error('The Creatomate template needs Product_Image: add an IMAGE asset to a scene');
return [{ json: { title: fields.product_name || pkg.project.title, price: fields.promo_price || fields.price || '', imageUrl: image.url } }];`,
        [1540, 20]
      ),
      onError: 'continueErrorOutput',
    },
    {
      name: 'Creatomate: create render',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [1760, 0],
      // Not retried: a retry would start (and bill) a second render.
      onError: 'continueErrorOutput',
      parameters: {
        method: 'POST',
        url: CREATOMATE_RENDERS,
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'Authorization', value: '=Bearer {{ $env["CREATOMATE_API_KEY"] }}' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody:
          '={{ JSON.stringify({ template_id: $env["CREATOMATE_TEMPLATE_ID"], webhook_url: $execution.resumeUrl, modifications: { Product_Name: $json.title, Price: $json.price, Product_Image: $json.imageUrl } }) }}',
        options: { timeout: 60000 },
      },
    },
    {
      name: 'Wait for Creatomate webhook',
      type: 'n8n-nodes-base.wait',
      typeVersion: 1.1,
      position: [1980, -20],
      webhookId: uid('wait/creatomate'),
      // Resumes when Creatomate POSTs to $execution.resumeUrl; gives up after 30 minutes.
      parameters: { resume: 'webhook', httpMethod: 'POST', limitWaitTime: true, limitType: 'afterTimeInterval', resumeAmount: 30, resumeUnit: 'minutes', options: {} },
    },
    {
      name: 'Creatomate: fetch render',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [2200, -20],
      onError: 'continueErrorOutput',
      retryOnFail: true,
      maxTries: 3,
      waitBetweenTries: 5000,
      parameters: {
        url: `=${CREATOMATE_RENDERS}/{{ $('Creatomate: create render').first().json.id }}`,
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'Authorization', value: '=Bearer {{ $env["CREATOMATE_API_KEY"] }}' }] },
        options: { timeout: 60000 },
      },
    },
    {
      ...code(
        'Build render.completed',
        `// Uses the render as returned by Creatomate's API (the webhook body is not trusted).
const r = $input.first().json;
if (r.status !== 'succeeded') throw new Error('Creatomate render ' + r.id + ' is ' + r.status + (r.error_message ? ': ' + r.error_message : ''));
const data = {
  url: r.url,
  mimeType: !r.output_format || r.output_format === 'mp4' ? 'video/mp4' : 'video/' + r.output_format,
  width: Number(r.width),
  height: Number(r.height),
  durationSec: Number(r.duration),
};
if (r.file_size) data.sizeBytes = Number(r.file_size);
if (!/^https:\\/\\//.test(data.url || '')) throw new Error('Render output url must be https, got ' + data.url);
for (const k of ['width', 'height', 'durationSec']) if (!(data[k] > 0)) throw new Error('Render output missing ' + k);
return [{ json: { event: { type: 'render.completed', data } } }];`,
        [2420, -60]
      ),
      onError: 'continueErrorOutput',
    },
    code(
      'Build render.failed',
      `${errorText}
return [{ json: { event: { type: 'render.failed', data: { error: String(msg).slice(0, 4000) } } } }];`,
      [2420, 220]
    ),
    code('Sign result', signCallback(V2), [2660, 60]),
    signedPost('Send result to CRM', [2880, 60]),
  ],
  [
    ['CRM webhook', V2],
    [V2, 'Signature OK?'],
    ['Signature OK?', 'Accept (202)', 0],
    ['Signature OK?', 'Reject', 1],
    ['Accept (202)', 'Build render.started'],
    ['Build render.started', 'Sign render.started'],
    ['Sign render.started', 'Send render.started'],
    ['Send render.started', 'Creatomate modifications'],
    ['Creatomate modifications', 'Creatomate: create render', 0],
    ['Creatomate modifications', 'Build render.failed', 1],
    ['Creatomate: create render', 'Wait for Creatomate webhook', 0],
    ['Creatomate: create render', 'Build render.failed', 1],
    ['Wait for Creatomate webhook', 'Creatomate: fetch render'],
    ['Creatomate: fetch render', 'Build render.completed', 0],
    ['Creatomate: fetch render', 'Build render.failed', 1],
    ['Build render.completed', 'Sign result', 0],
    ['Build render.completed', 'Build render.failed', 1],
    ['Build render.failed', 'Sign result'],
    ['Sign result', 'Send result to CRM'],
  ]
);

// -----------------------------------------------------------------------------
// 3. Scheduled dispatch trigger
// -----------------------------------------------------------------------------

const dispatch = workflow(
  'CRM Marketing · Dispatch tick (every minute)',
  [
    note(
      'About',
      '## n8n → CRM: dispatcher tick\nEvery minute, POSTs a signed empty JSON body to `{CRM_BASE_URL}/api/marketing/webhooks/dispatch` (HMAC with `MARKETING_N8N_INBOUND_SECRET`). The CRM then sends due posts and queued renders to the other two workflows. Overlapping ticks are safe (the CRM holds a lock and answers `{ ran: false, reason: \"LOCKED\" }`).',
      [-260, -280],
      520,
      220
    ),
    {
      name: 'Every minute',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, 0],
      parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } },
    },
    code(
      'Sign tick',
      `const crypto = require('crypto');
const secret = $env.MARKETING_N8N_INBOUND_SECRET;
const base = ($env.CRM_BASE_URL || '').replace(/\\/$/, '');
if (!secret || secret.length < 32) throw new Error('MARKETING_N8N_INBOUND_SECRET is not set on n8n');
if (!/^https?:\\/\\//.test(base)) throw new Error('CRM_BASE_URL is not set on n8n');
const body = '{}';
const timestamp = Math.floor(Date.now() / 1000).toString();
const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex');
return [{ json: { url: base + '/api/marketing/webhooks/dispatch', body, timestamp, signature } }];`,
      [220, 0]
    ),
    // No retries: the next tick a minute later is the retry.
    { ...signedPost('Run CRM dispatcher', [440, 0]), retryOnFail: false, maxTries: undefined, waitBetweenTries: undefined },
  ],
  [
    ['Every minute', 'Sign tick'],
    ['Sign tick', 'Run CRM dispatcher'],
  ]
);

// -----------------------------------------------------------------------------
// 4. Metrics sync (simulated platform insights → signed CRM metrics webhook)
// -----------------------------------------------------------------------------

const metrics = workflow(
  'CRM Marketing · Sync metrics (simulated)',
  [
    note(
      'About',
      '## Platform → n8n → CRM: engagement metrics\nEvery 6 hours (or manually), builds yesterday\'s (UTC) metrics per post and POSTs each one, HMAC-signed with `MARKETING_N8N_INBOUND_SECRET`, to `{CRM_BASE_URL}/api/marketing/webhooks/metrics`.\n\n**Simulation:** \"Fetch platform metrics\" generates deterministic sample numbers for the CRM post ids in `SIMULATED_POST_IDS` (comma-separated, PUBLISHED posts). Replace it with real insights calls (Graph API `/{media-id}/insights`, TikTok `video/query`) returning the same item shape.',
      [-260, -320],
      560,
      280
    ),
    {
      name: 'Every 6 hours',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, 0],
      parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 6 }] } },
    },
    { name: 'Run manually', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 200], parameters: {} },
    code(
      'Fetch platform metrics',
      `// SIMULATION: deterministic per (post, day), so re-runs report the same numbers
// (the CRM dedupes them) and a new day produces a new period row.
const crypto = require('crypto');
const ids = String($env.SIMULATED_POST_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!ids.length) throw new Error('Set SIMULATED_POST_IDS on n8n (comma-separated CRM social post ids)');

const end = new Date();
end.setUTCHours(0, 0, 0, 0); // yesterday, UTC, as a closed 24h period
const start = new Date(end.getTime() - 86400000);

return ids.map((postId) => {
  const seed = crypto.createHash('sha256').update(postId + ':' + start.toISOString()).digest();
  const r = (i, max) => seed.readUInt16BE(i) % max;
  const impressions = 500 + r(0, 5000);
  const reach = Math.round(impressions * (0.6 + r(2, 30) / 100));
  const metrics = {
    impressions,
    reach,
    views: Math.round(reach * 0.8),
    clicks: r(4, Math.max(1, Math.round(impressions * 0.05))),
    likes: r(6, 400),
    comments: r(8, 60),
    shares: r(10, 40),
    saves: r(12, 30),
  };
  return { json: { postId, periodStart: start.toISOString(), periodEnd: end.toISOString(), metrics, raw: { simulated: true } } };
});`,
      [240, 100]
    ),
    code(
      'Sign metrics',
      `// One signed request per post. eventId = post + period + content hash: n8n retries and
// re-runs dedupe in the CRM, while corrected numbers for the same period still apply.
const crypto = require('crypto');
const secret = $env.MARKETING_N8N_INBOUND_SECRET;
const base = ($env.CRM_BASE_URL || '').replace(/\\/$/, '');
if (!secret || secret.length < 32) throw new Error('MARKETING_N8N_INBOUND_SECRET is not set on n8n');
if (!/^https?:\\/\\//.test(base)) throw new Error('CRM_BASE_URL is not set on n8n');

return $input.all().map(({ json: m }) => {
  const hash = crypto.createHash('sha256').update(JSON.stringify(m.metrics)).digest('hex').slice(0, 16);
  const payload = { eventId: 'metrics:' + m.postId + ':' + m.periodStart + ':' + hash, postId: m.postId, periodStart: m.periodStart, periodEnd: m.periodEnd, metrics: m.metrics, raw: m.raw };
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex');
  return { json: { url: base + '/api/marketing/webhooks/metrics', body, timestamp, signature, postId: m.postId } };
});`,
      [480, 100]
    ),
    // One post's bad data (404 unknown post, 422 unpublished) must not stop the others.
    signedPost('Send to CRM', [720, 100], { onError: 'continueRegularOutput' }),
  ],
  [
    ['Every 6 hours', 'Fetch platform metrics'],
    ['Run manually', 'Fetch platform metrics'],
    ['Fetch platform metrics', 'Sign metrics'],
    ['Sign metrics', 'Send to CRM'],
  ]
);

fs.mkdirSync(OUT, { recursive: true });
for (const [file, wf] of [
  ['social-publish.json', social],
  ['video-render.json', render],
  ['dispatch-tick.json', dispatch],
  ['sync-metrics.json', metrics],
]) {
  fs.writeFileSync(path.join(OUT, file), JSON.stringify(wf, null, 2) + '\n');
  console.log(file, wf.nodes.length, 'nodes');
}
