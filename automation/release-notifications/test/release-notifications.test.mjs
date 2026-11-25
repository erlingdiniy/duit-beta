import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MIN_EXCLUSIVE_VERSION_CODE,
  inspectApkBuffer,
  parseReleaseIdentity,
  validateReleaseMetadata,
  verifyRemoteApkAsset,
} from '../lib/release-validator.mjs';
import {
  CHANNEL_ID,
  TOPIC_BETA,
  TOPIC_STABLE,
  buildNotificationPlan,
  extractReleaseHighlights,
  sanitizeNotificationText,
} from '../lib/notification-builder.mjs';
import {
  createEmptyLedger,
  evaluateReleaseEligibility,
  loadLedger,
  recordTopicOutcome,
  saveLedger,
} from '../lib/dedup-store.mjs';
import {
  isAmbiguousStatus,
  isRetryableStatus,
  redactSensitive,
  sendFcmMessage,
} from '../lib/fcm-client.mjs';
import { parseArgs, runCli } from '../run.mjs';

const SEED_PATH = path.resolve(import.meta.dirname, '..', 'state-seed', 'release-notifications.json');

/**
 * Builds a minimal syntactically valid ZIP archive containing specified filenames.
 */
function buildSyntheticZip(files) {
  const localParts = [];
  const cdParts = [];
  let offset = 0;

  for (const { name, content } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const dataBuf = Buffer.from(content, 'utf8');
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt32LE(dataBuf.length, 18);
    localHeader.writeUInt32LE(dataBuf.length, 22);

    localParts.push(localHeader, nameBuf, dataBuf);

    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0);
    cdHeader.writeUInt16LE(20, 4);
    cdHeader.writeUInt16LE(20, 6);
    cdHeader.writeUInt16LE(nameBuf.length, 28);
    cdHeader.writeUInt32LE(dataBuf.length, 20);
    cdHeader.writeUInt32LE(dataBuf.length, 24);
    cdHeader.writeUInt32LE(offset, 42);
    cdParts.push(cdHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + dataBuf.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeRelease({
  tag = 'v1.2.1',
  name = 'duit. v1.2.1',
  prerelease = false,
  draft = false,
  publishedAt = '2026-12-01T10:00:00Z',
  body = "## What's New\n- **Receipt Export:** Faster PDF export for tax filing.\n- **Budget Alerts:** Refined weekly pacing reminders.\n",
  assetName = 'duit-1.2.1.apk',
  assetSize = 8_500_000,
  assetState = 'uploaded',
  sha256 = 'a'.repeat(64),
  downloadUrl = null,
  assetsOverride = null,
} = {}) {
  const url = downloadUrl ?? `https://github.com/erlingdiniy/duit-beta/releases/download/${tag}/${assetName}`;
  return {
    tag_name: tag,
    name,
    prerelease,
    draft,
    published_at: publishedAt,
    body,
    assets:
      assetsOverride ?? [
        {
          name: assetName,
          size: assetSize,
          state: assetState,
          digest: `sha256:${sha256}`,
          browser_download_url: url,
        },
      ],
  };
}

test('seed ledger blocks v1.2.0 and all prior historical releases', () => {
  const seed = loadLedger(SEED_PATH);
  assert.equal(seed.minExclusiveVersionCode, MIN_EXCLUSIVE_VERSION_CODE);
  assert.equal(seed.releases['v1.2.0'].status, 'preseeded_skip');

  const v120 = makeRelease({
    tag: 'v1.2.0',
    name: 'duit. v1.2.0',
    prerelease: false,
    assetName: 'duit-1.2.0.apk',
    assetSize: 8_450_511,
    sha256: 'e883b223504d684a0deac38acf903be149f6377f8215396a4326c43f6424075b',
  });
  const res120 = validateReleaseMetadata(v120);
  assert.equal(res120.ok, true);
  assert.equal(res120.belowFloor, true);
  assert.equal(res120.releaseInfo.versionCode, 1_002_000);

  const plan120 = buildNotificationPlan(res120.releaseInfo);
  const elig120 = evaluateReleaseEligibility(seed, res120.releaseInfo, plan120.targets, plan120.broadcastId);
  assert.equal(elig120.eligible, false);
  assert.equal(elig120.reason, 'below_or_equal_floor');

  const beta2 = makeRelease({
    tag: 'v1.2.0-beta.2',
    name: 'duit. 1.2.0-beta.2 — Public Beta',
    prerelease: true,
    assetName: 'duit-1.2.0-beta.2.apk',
    assetSize: 8_450_511,
    sha256: '1d314949a9473475a115fb8d2c686b5ff2fc92ec647e87f88f8739ba50ae4f7d',
  });
  const resBeta2 = validateReleaseMetadata(beta2);
  assert.equal(resBeta2.ok, true);
  assert.equal(resBeta2.belowFloor, true);
  assert.equal(resBeta2.releaseInfo.versionCode, 1_001_902);
});

test('future Stable v1.2.1 routes to both Stable and Beta topics with shared dedup identifiers', () => {
  const release = makeRelease();
  const meta = validateReleaseMetadata(release);
  assert.equal(meta.ok, true);
  assert.equal(meta.belowFloor, false);
  assert.equal(meta.releaseInfo.versionCode, 1_002_001);
  assert.equal(meta.releaseInfo.channel, 'stable');

  const plan = buildNotificationPlan(meta.releaseInfo);
  assert.equal(plan.channelId, CHANNEL_ID);
  assert.equal(plan.broadcastId, 'duit-release-1.2.1');
  assert.deepEqual(plan.targets, [TOPIC_STABLE, TOPIC_BETA]);
  assert.equal(plan.title, 'duit. v1.2.1 is now available');
  assert.ok(plan.body.includes('Receipt Export'));
  assert.ok(plan.body.length <= 220);

  for (const { topic, payload } of plan.messages) {
    assert.equal(payload.message.topic, topic);
    assert.equal(payload.message.android.notification.channel_id, 'duit_developer_broadcasts');
    assert.equal(payload.message.android.notification.visibility, 'PRIVATE');
    assert.equal(payload.message.android.notification.tag, 'duit-release-1.2.1');
    assert.equal(payload.message.android.collapse_key, 'duit-release-1.2.1');
    assert.equal(payload.message.data.broadcast_id, 'duit-release-1.2.1');
    assert.equal(payload.message.data.route, 'home');
    assert.equal(payload.message.data.release_channel, 'stable');
    assert.equal(payload.message.data.version_code, '1002001');
    for (const [k, v] of Object.entries(payload.message.data)) {
      assert.equal(k.trim(), k);
      assert.equal(typeof v, 'string');
    }
  }
});

test('future Beta v1.3.0-beta.1 routes exclusively to duit_beta_broadcasts', () => {
  const release = makeRelease({
    tag: 'v1.3.0-beta.1',
    name: 'duit. 1.3.0-beta.1 — Public Beta',
    prerelease: true,
    assetName: 'duit-1.3.0-beta.1.apk',
  });
  const meta = validateReleaseMetadata(release);
  assert.equal(meta.ok, true);
  assert.equal(meta.belowFloor, false);
  assert.equal(meta.releaseInfo.versionCode, 1_002_901);
  assert.equal(meta.releaseInfo.channel, 'beta');

  const plan = buildNotificationPlan(meta.releaseInfo);
  assert.deepEqual(plan.targets, [TOPIC_BETA]);
  assert.equal(plan.broadcastId, 'duit-release-1.3.0-beta.1');
  assert.equal(plan.title, 'duit. 1.3.0-beta.1 Beta is ready');
  assert.equal(plan.messages.length, 1);
  assert.equal(plan.messages[0].payload.message.topic, TOPIC_BETA);
  assert.equal(plan.messages[0].payload.message.data.release_channel, 'beta');
});

test('release metadata validator rejects malformed, mismatched, and incomplete releases', () => {
  // Draft release
  assert.equal(parseReleaseIdentity({ draft: true, prerelease: false, tag_name: 'v1.2.1' }).ok, false);
  // Prerelease flag mismatches tag
  assert.equal(parseReleaseIdentity({ draft: false, prerelease: false, tag_name: 'v1.3.0-beta.1' }).ok, false);
  assert.equal(parseReleaseIdentity({ draft: false, prerelease: true, tag_name: 'v1.2.1' }).ok, false);
  // Patch must be 0 for closed beta
  assert.equal(parseReleaseIdentity({ draft: false, prerelease: true, tag_name: 'v1.2.1-beta.1' }).ok, false);

  // Missing asset, unuploaded asset, missing digest, title version mismatch, body SHA mismatch
  assert.equal(validateReleaseMetadata(makeRelease({ assetsOverride: [] })).ok, false);
  assert.equal(validateReleaseMetadata(makeRelease({ assetName: 'wrong.apk' })).ok, false);
  assert.equal(validateReleaseMetadata(makeRelease({ assetState: 'starter' })).ok, false);
  assert.equal(validateReleaseMetadata(makeRelease({ name: 'duit. release' })).ok, false);
  assert.equal(validateReleaseMetadata(makeRelease({ assetSize: 100 })).ok, false);
  assert.equal(
    validateReleaseMetadata(makeRelease({ body: '## Notes\n- Fix.\nSHA-256 APK: ' + 'b'.repeat(64) })).ok,
    false,
  );
  assert.equal(
    validateReleaseMetadata(
      makeRelease({ downloadUrl: 'https://evil.example/duit-1.2.1.apk' }),
    ).ok,
    false,
  );
});

test('notification builder sanitizes control chars, strips boilerplate, and bounds copy length', () => {
  const messy = [
    '**duit. v1.2.1** improves offline reliability.',
    '## What\'s New',
    '- **Quick Backup:\u0007** Instant vault snapshot export with zero wait.',
    '- [Safe Sync](https://example.com) improvements across **wallets** and charts.',
    '## Asset Verification',
    '- SHA-256 APK: `' + 'a'.repeat(64) + '`',
  ].join('\n');

  const highlights = extractReleaseHighlights(messy);
  assert.equal(highlights.length, 2);
  assert.ok(!highlights.some((h) => h.includes('Asset Verification') || h.includes('aaaa')));
  assert.equal(highlights[0].includes('\u0007'), false);

  const truncated = sanitizeNotificationText('word '.repeat(80), 100);
  assert.ok(truncated.length <= 100);
  assert.ok(truncated.endsWith('…'));
});

test('ZIP/APK structural verification + HTTP download streaming validates real APK zips and rejects tampering', async (t) => {
  const validApk = buildSyntheticZip([
    { name: 'AndroidManifest.xml', content: 'manifest-binary-stub' },
    { name: 'classes.dex', content: 'dex-stub' },
    { name: 'META-INF/MANIFEST.MF', content: 'Manifest-Version: 1.0' },
  ]);
  assert.equal(inspectApkBuffer(validApk).ok, true);

  const missingManifestApk = buildSyntheticZip([{ name: 'classes.dex', content: 'dex' }]);
  assert.equal(inspectApkBuffer(missingManifestApk).ok, false);

  const notZip = Buffer.from('not-a-zip-file-at-all-just-html');
  assert.equal(inspectApkBuffer(notZip).ok, false);

  let mode = 'valid';
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/apk' });
      res.end();
      return;
    }
    if (req.url === '/bad-redirect') {
      res.writeHead(302, { Location: 'https://untrusted.attacker.invalid/duit.apk' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(mode === 'valid' ? validApk : notZip);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;

  const asset = {
    name: 'duit-1.2.1.apk',
    size: validApk.length,
    sha256: sha256Hex(validApk),
    downloadUrl: `http://127.0.0.1:${port}/redirect`,
  };

  const okRes = await verifyRemoteApkAsset(asset, {
    allowHosts: new Set(['127.0.0.1']),
    allowInsecureTestHosts: true,
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.sha256, asset.sha256);
  assert.equal(okRes.hasManifest, true);
  assert.equal(okRes.hasDex, true);

  // SHA/size mismatch check
  mode = 'corrupt';
  await assert.rejects(
    verifyRemoteApkAsset(
      { ...asset, size: notZip.length, sha256: asset.sha256 },
      { allowHosts: new Set(['127.0.0.1']), allowInsecureTestHosts: true },
    ),
    /SHA-256 mismatch/,
  );

  // Untrusted redirect host check
  await assert.rejects(
    verifyRemoteApkAsset(
      { ...asset, downloadUrl: `http://127.0.0.1:${port}/bad-redirect` },
      { allowHosts: new Set(['127.0.0.1']), allowInsecureTestHosts: true },
    ),
    /untrusted APK download host/,
  );
});

test('FCM HTTP v1 client handles retries, non-retryable errors, validate_only, and secret redaction', async (t) => {
  const requests = [];
  let scenario = 'retry-then-ok';
  let callCount = 0;

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ auth: req.headers.authorization, url: req.url, body });
    callCount += 1;

    if (scenario === 'retry-then-ok') {
      if (callCount === 1) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { status: 'UNAVAILABLE', message: 'Temporary error' } }));
        return;
      }
      if (callCount === 2) {
        res.writeHead(429, { 'Retry-After': '0', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Rate limited' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'projects/duit-beta/messages/msg-123' }));
      return;
    }

    if (scenario === 'ambiguous-500') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { status: 'INTERNAL', message: 'Backend timeout after fanout' } }));
      return;
    }

    if (scenario === 'auth-fail') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          status: 'PERMISSION_DENIED',
          message: `Bearer ${['ya29', 'test-secret-token-123456'].join('.')} rejected`,
        },
      }));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const endpointBase = `http://127.0.0.1:${server.address().port}`;
  const fakeToken = ['ya29', 'test-secret-token-123456'].join('.');

  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(500), false);
  assert.equal(isAmbiguousStatus(500), true);
  assert.equal(isAmbiguousStatus(502), true);
  assert.equal(isAmbiguousStatus(504), true);

  const okRes = await sendFcmMessage({
    projectId: 'duit-beta',
    accessToken: fakeToken,
    payload: { message: { topic: TOPIC_BETA, notification: { title: 't', body: 'b' } } },
    validateOnly: true,
    endpointBase,
    baseDelayMs: 1,
    sleepImpl: async () => {},
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.deliveryState, 'sent');
  assert.equal(okRes.ambiguous, false);
  assert.equal(okRes.attempts, 3);
  assert.equal(requests[2].body.validate_only, true);
  assert.equal(requests[2].auth, `Bearer ${fakeToken}`);

  // Live 500 must NOT auto-retry (1 attempt) and must return ambiguous=true
  scenario = 'ambiguous-500';
  const ambigRes = await sendFcmMessage({
    projectId: 'duit-beta',
    accessToken: fakeToken,
    payload: { message: { topic: TOPIC_BETA } },
    validateOnly: false,
    endpointBase,
    sleepImpl: async () => {},
  });
  assert.equal(ambigRes.ok, false);
  assert.equal(ambigRes.deliveryState, 'ambiguous');
  assert.equal(ambigRes.ambiguous, true);
  assert.equal(ambigRes.attempts, 1);
  assert.equal(ambigRes.status, 500);

  // Live network drop / timeout must NOT auto-retry (1 attempt) and must return ambiguous=true
  let netCalls = 0;
  const netDropRes = await sendFcmMessage({
    projectId: 'duit-beta',
    accessToken: fakeToken,
    payload: { message: { topic: TOPIC_BETA } },
    validateOnly: false,
    endpointBase,
    fetchImpl: async () => {
      netCalls += 1;
      throw new Error('The operation was aborted due to timeout');
    },
    sleepImpl: async () => {},
  });
  assert.equal(netCalls, 1);
  assert.equal(netDropRes.ok, false);
  assert.equal(netDropRes.deliveryState, 'ambiguous');
  assert.equal(netDropRes.ambiguous, true);
  assert.equal(netDropRes.errorCode, 'NETWORK_ERROR');

  // Non-retryable 403 must stop on attempt 1 and redact leaked secret token
  scenario = 'auth-fail';
  const failRes = await sendFcmMessage({
    projectId: 'duit-beta',
    accessToken: fakeToken,
    payload: { message: { topic: TOPIC_BETA } },
    validateOnly: false,
    endpointBase,
    sleepImpl: async () => {},
  });
  assert.equal(failRes.ok, false);
  assert.equal(failRes.deliveryState, 'failed');
  assert.equal(failRes.ambiguous, false);
  assert.equal(failRes.attempts, 1);
  assert.equal(failRes.status, 403);
  assert.equal(failRes.errorSummary.includes(fakeToken), false);
  assert.equal(redactSensitive(`Authorization: Bearer ${fakeToken}`), 'Authorization: Bearer [REDACTED]');
});

test('CLI runner enforces fail-closed state, partial-failure recovery, strict dedup, and redacted logging', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duit-notify-cli-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const validApk = buildSyntheticZip([
    { name: 'AndroidManifest.xml', content: 'manifest-stub' },
    { name: 'classes.dex', content: 'dex-stub' },
  ]);
  const apkSha = sha256Hex(validApk);

  const release121 = makeRelease({
    tag: 'v1.2.1',
    name: 'duit. v1.2.1',
    prerelease: false,
    assetName: 'duit-1.2.1.apk',
    assetSize: validApk.length,
    sha256: apkSha,
  });

  const sentTopics = [];
  let betaFailureMode = '503';

  const mockServer = http.createServer(async (req, res) => {
    if (req.url === '/repos/erlingdiniy/duit-beta/releases/tags/v1.2.1' || req.url === '/repos/erlingdiniy/duit-beta/releases/tags/v1.2.2') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const tag = req.url.endsWith('v1.2.2') ? 'v1.2.2' : 'v1.2.1';
      const ver = tag.slice(1);
      res.end(JSON.stringify(makeRelease({
        tag,
        name: `duit. ${tag}`,
        prerelease: false,
        assetName: `duit-${ver}.apk`,
        assetSize: validApk.length,
        sha256: apkSha,
      })));
      return;
    }
    if (req.url === '/apk/duit-1.2.1.apk' || req.url === '/apk/duit-1.2.2.apk') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(validApk);
      return;
    }
    if (req.url === '/v1/projects/duit-beta/messages:send') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const topic = body.message.topic;
      if (topic === TOPIC_BETA && !body.validate_only) {
        if (betaFailureMode === '503') {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { status: 'UNAVAILABLE', message: 'FCM overloaded' } }));
          return;
        }
        if (betaFailureMode === '500') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { status: 'INTERNAL', message: 'Ambiguous post-accept failure' } }));
          return;
        }
      }
      sentTopics.push({
        releaseTag: body.message.data.release_tag,
        topic,
        validateOnly: Boolean(body.validate_only),
        tag: body.message.android.notification.tag,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: `projects/duit-beta/messages/${topic}-ok` }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  t.after(() => mockServer.close());
  const baseUrl = `http://127.0.0.1:${mockServer.address().port}`;
  const statePath = path.join(tmpDir, 'release-notifications.json');
  const fakeToken = ['ya29', 'test-secret-token-123456'].join('.');

  // Missing required state file must fail closed on live dispatch
  await assert.rejects(
    runCli(
      ['--mode', 'dispatch', '--no-dry-run', '--require-state-file', '--state-file', statePath, '--tag', 'v1.2.1'],
      { FCM_ACCESS_TOKEN: fakeToken, FIREBASE_PROJECT_ID: 'duit-beta', ALLOW_LIVE_FCM_DISPATCH: 'true' },
    ),
    /Required persistent state file not found/,
  );

  // Initialize state file
  saveLedger(statePath, createEmptyLedger());

  // Capture all logs to verify zero secret leaks
  const logs = [];
  const deps = {
    log: (line) => logs.push(line),
    allowHosts: new Set(['127.0.0.1']),
    allowInsecureTestHosts: true,
    minApkBytes: 50,
    downloadUrlOverride: `${baseUrl}/apk/duit-1.2.1.apk`,
    sleepImpl: async () => {},
  };
  const envDisabled = {
    GITHUB_TOKEN: ['ghs', 'supersecretgithubtoken123456'].join('_'),
    FCM_ACCESS_TOKEN: fakeToken,
    FIREBASE_PROJECT_ID: 'duit-beta',
    ALLOW_LIVE_FCM_DISPATCH: 'false',
  };
  const env = {
    ...envDisabled,
    ALLOW_LIVE_FCM_DISPATCH: 'true',
  };

  // Kill-switch disabled must fail closed before sending any live FCM broadcast
  await assert.rejects(
    runCli(
      [
        '--mode', 'dispatch', '--no-dry-run', '--require-state-file',
        '--state-file', statePath, '--tag', 'v1.2.1',
        '--github-api-base', baseUrl, '--fcm-endpoint-base', baseUrl,
      ],
      envDisabled,
      deps,
    ),
    /Live FCM dispatch is disabled/,
  );
  assert.equal(sentTopics.length, 0);

  // Run 1: Partial failure via definite non-delivery 503 (duit_announcements succeeds, duit_beta_broadcasts fails after 3 retries)
  const code1 = await runCli(
    [
      '--mode', 'dispatch', '--no-dry-run', '--require-state-file',
      '--state-file', statePath, '--tag', 'v1.2.1',
      '--github-api-base', baseUrl, '--fcm-endpoint-base', baseUrl,
    ],
    env,
    deps,
  );
  assert.equal(code1, 1);
  let saved = loadLedger(statePath);
  assert.equal(saved.releases['v1.2.1'].status, 'partial');
  assert.equal(saved.releases['v1.2.1'].topics[TOPIC_STABLE].status, 'sent');
  assert.equal(saved.releases['v1.2.1'].topics[TOPIC_BETA].status, 'failed');
  assert.equal(saved.releases['v1.2.1'].topics[TOPIC_BETA].attempts, 3);
  assert.equal(sentTopics.length, 1);

  // Run 2: Retry sends ONLY missing duit_beta_broadcasts, skips already-sent duit_announcements
  betaFailureMode = 'ok';
  const code2 = await runCli(
    [
      '--mode', 'dispatch', '--no-dry-run', '--require-state-file',
      '--state-file', statePath, '--tag', 'v1.2.1',
      '--github-api-base', baseUrl, '--fcm-endpoint-base', baseUrl,
    ],
    env,
    deps,
  );
  assert.equal(code2, 0);
  saved = loadLedger(statePath);
  assert.equal(saved.releases['v1.2.1'].status, 'sent');
  assert.equal(saved.releases['v1.2.1'].topics[TOPIC_BETA].status, 'sent');
  assert.deepEqual(
    sentTopics.map((s) => s.topic),
    [TOPIC_STABLE, TOPIC_BETA],
  );

  // Run 3: Already sent -> sends 0 additional messages
  const code3 = await runCli(
    [
      '--mode', 'dispatch', '--no-dry-run', '--require-state-file',
      '--state-file', statePath, '--tag', 'v1.2.1',
      '--github-api-base', baseUrl, '--fcm-endpoint-base', baseUrl,
    ],
    env,
    deps,
  );
  assert.equal(code3, 0);
  assert.equal(sentTopics.length, 2);

  // Ambiguous 500 on v1.2.2 Beta topic -> stops at 1 attempt, records 'ambiguous', and blocks blind automated retry
  betaFailureMode = '500';
  const ambigCode1 = await runCli(
    [
      '--mode', 'dispatch', '--no-dry-run', '--require-state-file',
      '--state-file', statePath, '--tag', 'v1.2.2',
      '--github-api-base', baseUrl, '--fcm-endpoint-base', baseUrl,
    ],
    env,
    deps,
  );
  assert.equal(ambigCode1, 1);
  saved = loadLedger(statePath);
  assert.equal(saved.releases['v1.2.2'].status, 'ambiguous');
  assert.equal(saved.releases['v1.2.2'].topics[TOPIC_BETA].status, 'ambiguous');
  assert.equal(saved.releases['v1.2.2'].topics[TOPIC_BETA].attempts, 1);
  const sendsAfterAmbig1 = sentTopics.filter((s) => s.releaseTag === 'v1.2.2').length;
  assert.equal(sendsAfterAmbig1, 1);

  betaFailureMode = 'ok';
  const ambigCode2 = await runCli(
    [
      '--mode', 'dispatch', '--no-dry-run', '--require-state-file',
      '--state-file', statePath, '--tag', 'v1.2.2',
      '--github-api-base', baseUrl, '--fcm-endpoint-base', baseUrl,
    ],
    env,
    deps,
  );
  assert.equal(ambigCode2, 0);
  assert.equal(sentTopics.filter((s) => s.releaseTag === 'v1.2.2').length, 1);

  // Logs must never contain either secret
  const joinedLogs = logs.join('\n');
  assert.equal(joinedLogs.includes(fakeToken), false);
  assert.equal(joinedLogs.includes(env.GITHUB_TOKEN), false);

  // validate-fcm sends validate_only: true without mutating ledger or sentTopics count
  const ledgerBeforeValidate = fs.readFileSync(statePath, 'utf8');
  const validateCode = await runCli(
    [
      '--mode', 'validate-fcm',
      '--state-file', statePath, '--tag', 'v1.2.1',
      '--github-api-base', baseUrl, '--fcm-endpoint-base', baseUrl,
    ],
    env,
    deps,
  );
  assert.equal(validateCode, 0);
  assert.equal(fs.readFileSync(statePath, 'utf8'), ledgerBeforeValidate);
  assert.deepEqual(
    sentTopics.filter((s) => s.validateOnly).map((s) => s.topic),
    [TOPIC_STABLE, TOPIC_BETA],
  );
  assert.equal(sentTopics.filter((s) => !s.validateOnly && s.releaseTag === 'v1.2.1').length, 2);
  assert.equal(sentTopics.filter((s) => !s.validateOnly).length, 3);

  // parseArgs safety checks
  assert.throws(() => parseArgs(['--mode', 'dispatch', '--dry-run']), /requires explicit --no-dry-run/);
  assert.throws(() => parseArgs(['--mode', 'dispatch', '--no-dry-run', '--skip-asset-download']), /cannot skip APK/);
  assert.equal(recordTopicOutcome(createEmptyLedger(), { tag: 'v9.9.9', version: '9.9.9', versionCode: 9009009, channel: 'stable', asset: { sha256: apkSha } }, 'id', [TOPIC_STABLE], TOPIC_STABLE, { ok: true, attempts: 1 }).status, 'sent');
});
