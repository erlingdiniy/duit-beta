import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_REPO,
  MIN_EXCLUSIVE_VERSION_CODE,
  MIN_APK_BYTES,
  validateReleaseMetadata,
  verifyRemoteApkAsset,
} from './lib/release-validator.mjs';
import { buildNotificationPlan } from './lib/notification-builder.mjs';
import {
  evaluateReleaseEligibility,
  loadLedger,
  recordTopicOutcome,
  saveLedger,
} from './lib/dedup-store.mjs';
import { redactSensitive, sendFcmMessage } from './lib/fcm-client.mjs';

const VALID_MODES = new Set(['plan', 'validate-fcm', 'dispatch']);
const BUNDLED_SEED_PATH = path.resolve(import.meta.dirname, 'state-seed', 'release-notifications.json');

export function parseArgs(argv) {
  const opts = {
    mode: 'plan',
    repo: DEFAULT_REPO,
    tag: '',
    releaseFile: '',
    stateFile: '',
    requireStateFile: false,
    skipAssetDownload: false,
    dryRun: true,
    explicitNoDryRun: false,
    githubOutput: '',
    githubSummary: '',
    githubApiBase: 'https://api.github.com',
    fcmEndpointBase: 'https://fcm.googleapis.com',
    minApkBytes: MIN_APK_BYTES,
    allowInsecureTestHosts: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for flag "${arg}".`);
      i += 1;
      return argv[i];
    };

    switch (arg) {
      case '--mode':
        opts.mode = next();
        break;
      case '--repo':
        opts.repo = next();
        break;
      case '--tag':
        opts.tag = next();
        break;
      case '--release-file':
        opts.releaseFile = next();
        break;
      case '--state-file':
        opts.stateFile = next();
        break;
      case '--require-state-file':
        opts.requireStateFile = true;
        break;
      case '--skip-asset-download':
        opts.skipAssetDownload = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--no-dry-run':
        opts.dryRun = false;
        opts.explicitNoDryRun = true;
        break;
      case '--github-output':
        opts.githubOutput = next();
        break;
      case '--github-summary':
        opts.githubSummary = next();
        break;
      case '--github-api-base':
        opts.githubApiBase = next();
        break;
      case '--fcm-endpoint-base':
        opts.fcmEndpointBase = next();
        break;
      default:
        throw new Error(`Unknown CLI argument: "${arg}".`);
    }
  }

  if (!VALID_MODES.has(opts.mode)) {
    throw new Error(`Invalid --mode "${opts.mode}". Expected plan, validate-fcm, or dispatch.`);
  }
  if (opts.mode === 'dispatch') {
    if (!opts.explicitNoDryRun || opts.dryRun) {
      throw new Error('Mode "dispatch" requires explicit --no-dry-run.');
    }
    if (opts.skipAssetDownload) {
      throw new Error('Mode "dispatch" cannot skip APK integrity download verification.');
    }
    if (!opts.requireStateFile || !opts.stateFile) {
      throw new Error('Mode "dispatch" requires both --require-state-file and --state-file.');
    }
  } else if (opts.mode === 'validate-fcm') {
    if (opts.skipAssetDownload) {
      throw new Error('Mode "validate-fcm" cannot skip APK integrity download verification.');
    }
  }

  return opts;
}

export async function fetchGitHubRelease({
  repo,
  tag,
  githubToken = '',
  githubApiBase = 'https://api.github.com',
  fetchImpl = fetch,
}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'duit-release-notifications/1.0',
  };
  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`;
  }

  if (tag) {
    const url = new URL(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, githubApiBase).toString();
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      throw new Error(`GitHub release lookup failed for tag "${tag}" (HTTP ${res.status}).`);
    }
    return res.json();
  }

  const listUrl = new URL(`/repos/${repo}/releases?per_page=10`, githubApiBase).toString();
  const res = await fetchImpl(listUrl, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    throw new Error(`GitHub releases listing failed for ${repo} (HTTP ${res.status}).`);
  }
  const releases = await res.json();
  if (!Array.isArray(releases)) {
    throw new Error('GitHub releases listing did not return an array.');
  }
  const latestNonDraft = releases.find((r) => r && r.draft === false);
  if (!latestNonDraft) {
    throw new Error(`No published release found for ${repo}.`);
  }
  return latestNonDraft;
}

function writeGitHubOutputs(outputPath, outputs) {
  if (!outputPath) return;
  const lines = Object.entries(outputs).map(([key, val]) => {
    const safeVal = String(val ?? '').replace(/[\r\n]/g, ' ');
    return `${key}=${safeVal}`;
  });
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

function writeGitHubSummary(summaryPath, lines) {
  if (!summaryPath) return;
  fs.appendFileSync(summaryPath, `${lines.join('\n')}\n\n`, 'utf8');
}

function safeLog(logFn, message, secrets = []) {
  logFn(redactSensitive(message, secrets));
}

export async function runCli(argv, env = process.env, deps = {}) {
  const log = deps.log ?? console.log;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleepImpl = deps.sleepImpl;
  const opts = parseArgs(argv);

  const githubToken = env.GITHUB_TOKEN ?? '';
  const fcmAccessToken = env.FCM_ACCESS_TOKEN ?? '';
  const projectId = env.FIREBASE_PROJECT_ID || 'duit-beta';
  const secrets = [githubToken, fcmAccessToken].filter(Boolean);

  if (env.GITHUB_ACTIONS === 'true' && fcmAccessToken) {
    log(`::add-mask::${fcmAccessToken}`);
  }

  let ledger;
  let ledgerSource = opts.stateFile || BUNDLED_SEED_PATH;
  if (opts.stateFile && fs.existsSync(opts.stateFile)) {
    ledger = loadLedger(opts.stateFile);
  } else if (opts.requireStateFile) {
    throw new Error(`Required persistent state file not found: "${opts.stateFile}". Failing closed.`);
  } else {
    safeLog(log, `[WARN] State file missing at "${opts.stateFile || '(none)'}"; reading bundled seed (${BUNDLED_SEED_PATH}).`, secrets);
    ledger = loadLedger(BUNDLED_SEED_PATH);
    ledgerSource = BUNDLED_SEED_PATH;
  }

  let release;
  if (opts.releaseFile) {
    release = JSON.parse(fs.readFileSync(opts.releaseFile, 'utf8').replace(/^\uFEFF/, ''));
  } else {
    release = await fetchGitHubRelease({
      repo: opts.repo,
      tag: opts.tag,
      githubToken,
      githubApiBase: opts.githubApiBase,
      fetchImpl,
    });
  }

  const meta = validateReleaseMetadata(release, {
    repo: opts.repo,
    minExclusiveVersionCode: ledger.minExclusiveVersionCode ?? MIN_EXCLUSIVE_VERSION_CODE,
    minApkBytes: deps.minApkBytes ?? opts.minApkBytes,
  });

  if (!meta.ok) {
    safeLog(log, `[ERROR] Release metadata validation failed (${release?.tag_name ?? 'unknown'}):`, secrets);
    for (const err of meta.errors) safeLog(log, `  - ${err}`, secrets);
    writeGitHubOutputs(opts.githubOutput, {
      should_dispatch: 'false',
      has_payloads: 'false',
      release_tag: release?.tag_name ?? '',
      skip_reason: 'metadata_validation_failed',
      state_changed: 'false',
    });
    return 1;
  }

  for (const warn of meta.warnings) {
    safeLog(log, `[WARN] ${warn}`, secrets);
  }

  const info = meta.releaseInfo;
  let apkResult = null;
  if (opts.skipAssetDownload) {
    safeLog(log, `[PLAN] Skipping remote APK binary stream check (--skip-asset-download set for plan mode).`, secrets);
  } else {
    apkResult = await verifyRemoteApkAsset(info.asset, {
      allowHosts: deps.allowHosts,
      allowInsecureTestHosts: Boolean(deps.allowInsecureTestHosts),
      fetchImpl,
      downloadUrlOverride: deps.downloadUrlOverride ?? null,
    });
    safeLog(
      log,
      `[OK] Verified APK binary ${info.asset.name} (${apkResult.bytes} B, sha256=${apkResult.sha256}, entries=${apkResult.zipEntries}, manifest=${apkResult.hasManifest}, dex=${apkResult.hasDex}).`,
      secrets,
    );
  }

  const plan = buildNotificationPlan(info);
  const eligibility = evaluateReleaseEligibility(ledger, info, plan.targets, plan.broadcastId);

  safeLog(log, `[PLAN] repo=${info.repo} tag=${info.tag} channel=${info.channel} versionCode=${info.versionCode} broadcastId=${plan.broadcastId}`, secrets);
  safeLog(log, `[PLAN] ledger=${ledgerSource} eligible=${eligibility.eligible} reason=${eligibility.reason} targets=${plan.targets.join(',')} pending=${eligibility.pendingTopics.join(',') || 'none'}`, secrets);
  safeLog(log, `[PLAN] channelId=${plan.channelId} title="${plan.title}" body="${plan.body}"`, secrets);

  const summaryLines = [
    `### duit. Release Notification (${opts.mode})`,
    `- **Release:** \`${info.tag}\` (${info.channel}, versionCode \`${info.versionCode}\`)`,
    `- **APK Asset:** \`${info.asset.name}\` (\`${info.asset.size}\` B, sha256 \`${info.asset.sha256}\`${apkResult ? ', binary + ZIP verified' : ', metadata verified'})`,
    `- **Broadcast ID:** \`${plan.broadcastId}\` (channel \`${plan.channelId}\`)`,
    `- **Targets:** \`${plan.targets.join('`, `')}\``,
    `- **Eligibility:** \`${eligibility.eligible ? 'ELIGIBLE' : 'SKIPPED'}\` (\`${eligibility.reason}\`)`,
    `- **Pending Topics:** \`${eligibility.pendingTopics.length ? eligibility.pendingTopics.join('`, `') : 'none'}\``,
  ];

  if (opts.mode === 'plan') {
    for (const msg of plan.messages) {
      safeLog(log, `[DRY-RUN PAYLOAD topic=${msg.topic}] ${JSON.stringify(msg.payload)}`, secrets);
    }
    writeGitHubOutputs(opts.githubOutput, {
      should_dispatch: eligibility.eligible ? 'true' : 'false',
      has_payloads: plan.messages.length > 0 ? 'true' : 'false',
      release_tag: info.tag,
      channel: info.channel,
      version_code: String(info.versionCode),
      broadcast_id: plan.broadcastId,
      skip_reason: eligibility.eligible ? '' : eligibility.reason,
      state_changed: 'false',
    });
    writeGitHubSummary(opts.githubSummary, summaryLines);
    return 0;
  }

  if (opts.mode === 'validate-fcm') {
    if (!fcmAccessToken) {
      throw new Error('FCM_ACCESS_TOKEN environment variable is required for --mode validate-fcm.');
    }
    const validateTargets = eligibility.pendingTopics.length > 0 ? eligibility.pendingTopics : plan.targets;
    let allOk = true;
    for (const topic of validateTargets) {
      const entry = plan.messages.find((m) => m.topic === topic);
      const res = await sendFcmMessage({
        projectId,
        accessToken: fcmAccessToken,
        payload: entry.payload,
        validateOnly: true,
        endpointBase: deps.fcmEndpointBase ?? opts.fcmEndpointBase,
        fetchImpl,
        sleepImpl,
      });
      safeLog(
        log,
        `[FCM VALIDATE_ONLY topic=${topic}] ok=${res.ok} status=${res.status} attempts=${res.attempts}${res.errorSummary ? ` err=${res.errorSummary}` : ''}`,
        secrets,
      );
      if (!res.ok) allOk = false;
    }
    writeGitHubOutputs(opts.githubOutput, {
      should_dispatch: 'false',
      has_payloads: 'true',
      release_tag: info.tag,
      channel: info.channel,
      version_code: String(info.versionCode),
      broadcast_id: plan.broadcastId,
      skip_reason: 'validate_only',
      state_changed: 'false',
    });
    writeGitHubSummary(opts.githubSummary, [...summaryLines, `- **FCM validate_only:** \`${allOk ? 'PASSED' : 'FAILED'}\``]);
    return allOk ? 0 : 1;
  }

  // Live dispatch mode (--mode dispatch --no-dry-run --require-state-file)
  if (env.ALLOW_LIVE_FCM_DISPATCH !== 'true') {
    throw new Error('Live FCM dispatch is disabled (ALLOW_LIVE_FCM_DISPATCH != true). Failing closed.');
  }

  if (!eligibility.eligible || eligibility.pendingTopics.length === 0) {
    safeLog(log, `[SKIP] Release ${info.tag} is not eligible for live dispatch (${eligibility.reason}).`, secrets);
    writeGitHubOutputs(opts.githubOutput, {
      should_dispatch: 'false',
      has_payloads: 'true',
      release_tag: info.tag,
      channel: info.channel,
      version_code: String(info.versionCode),
      broadcast_id: plan.broadcastId,
      skip_reason: eligibility.reason,
      state_changed: 'false',
    });
    writeGitHubSummary(opts.githubSummary, summaryLines);
    return 0;
  }

  if (!fcmAccessToken) {
    throw new Error('FCM_ACCESS_TOKEN environment variable is required for --mode dispatch.');
  }

  let anyFailure = false;
  let stateChanged = false;
  const results = [];

  for (const topic of eligibility.pendingTopics) {
    const entry = plan.messages.find((m) => m.topic === topic);
    const res = await sendFcmMessage({
      projectId,
      accessToken: fcmAccessToken,
      payload: entry.payload,
      validateOnly: false,
      endpointBase: deps.fcmEndpointBase ?? opts.fcmEndpointBase,
      fetchImpl,
      sleepImpl,
    });
    recordTopicOutcome(ledger, info, plan.broadcastId, plan.targets, topic, res);
    saveLedger(opts.stateFile, ledger);
    stateChanged = true;
    results.push({ topic, ...res });
    safeLog(
      log,
      `[FCM SEND topic=${topic}] state=${res.deliveryState ?? (res.ok ? 'sent' : 'failed')} ok=${res.ok} ambiguous=${Boolean(res.ambiguous)} status=${res.status} attempts=${res.attempts}${res.messageName ? ` msg=${res.messageName}` : ''}${res.errorSummary ? ` err=${res.errorSummary}` : ''}`,
      secrets,
    );
    if (!res.ok) anyFailure = true;
  }

  writeGitHubOutputs(opts.githubOutput, {
    should_dispatch: 'true',
    has_payloads: 'true',
    release_tag: info.tag,
    channel: info.channel,
    version_code: String(info.versionCode),
    broadcast_id: plan.broadcastId,
    skip_reason: '',
    state_changed: String(stateChanged),
  });
  writeGitHubSummary(opts.githubSummary, [
    ...summaryLines,
    `- **Live Dispatch Results:** ${results.map((r) => `\`${r.topic}\`: ${r.ambiguous ? 'AMBIGUOUS (verify before retry)' : r.ok ? 'SENT' : 'FAILED'}`).join(', ')}`,
  ]);

  return anyFailure ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      const secrets = [process.env.GITHUB_TOKEN, process.env.FCM_ACCESS_TOKEN].filter(Boolean);
      console.error(`[FATAL] ${redactSensitive(err?.message ?? String(err), secrets)}`);
      process.exitCode = 1;
    });
}
