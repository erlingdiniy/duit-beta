import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_REPO, MIN_EXCLUSIVE_VERSION_CODE } from './release-validator.mjs';

const VALID_RELEASE_STATUSES = new Set(['preseeded_skip', 'sent', 'partial', 'failed', 'ambiguous']);
const VALID_TOPIC_STATUSES = new Set(['sent', 'failed', 'ambiguous']);

/**
 * Validates and normalizes the persistent release notification dedup ledger.
 */
export function validateLedger(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Dedup ledger must be a JSON object.');
  }
  if (raw.schemaVersion !== 1) {
    throw new Error(`Unsupported ledger schemaVersion: ${String(raw.schemaVersion)}.`);
  }
  if (typeof raw.repository !== 'string' || !raw.repository) {
    throw new Error('Dedup ledger repository field is required.');
  }
  if (!Number.isInteger(raw.minExclusiveVersionCode) || raw.minExclusiveVersionCode < MIN_EXCLUSIVE_VERSION_CODE) {
    throw new Error(
      `Ledger minExclusiveVersionCode (${String(raw.minExclusiveVersionCode)}) cannot be lower than ${MIN_EXCLUSIVE_VERSION_CODE}.`,
    );
  }
  if (!raw.releases || typeof raw.releases !== 'object' || Array.isArray(raw.releases)) {
    throw new Error('Dedup ledger releases map must be an object.');
  }

  for (const [tag, entry] of Object.entries(raw.releases)) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Invalid ledger entry for tag "${tag}".`);
    }
    if (!VALID_RELEASE_STATUSES.has(entry.status)) {
      throw new Error(`Invalid ledger status "${String(entry.status)}" for tag "${tag}".`);
    }
    if (entry.topics !== undefined) {
      if (!entry.topics || typeof entry.topics !== 'object' || Array.isArray(entry.topics)) {
        throw new Error(`Invalid topics object for tag "${tag}".`);
      }
      for (const [topic, tState] of Object.entries(entry.topics)) {
        if (!tState || !VALID_TOPIC_STATUSES.has(tState.status)) {
          throw new Error(`Invalid topic "${topic}" status in ledger for tag "${tag}".`);
        }
      }
    }
  }

  return raw;
}

export function loadLedger(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  return validateLedger(JSON.parse(text));
}

export function createEmptyLedger({
  repo = DEFAULT_REPO,
  minExclusiveVersionCode = MIN_EXCLUSIVE_VERSION_CODE,
  nowIso = new Date().toISOString(),
} = {}) {
  return {
    schemaVersion: 1,
    repository: repo,
    minExclusiveVersionCode,
    updatedAt: nowIso,
    releases: {},
  };
}

/**
 * Atomically persists sorted, deterministic ledger JSON with zero credential fields.
 */
export function saveLedger(filePath, ledger, nowIso = new Date().toISOString()) {
  const validated = validateLedger(ledger);
  const sortedReleases = {};
  const entries = Object.entries(validated.releases).sort(([, a], [, b]) => {
    const codeDiff = (b.versionCode ?? 0) - (a.versionCode ?? 0);
    return codeDiff !== 0 ? codeDiff : String(a.tag).localeCompare(String(b.tag));
  });
  for (const [k, v] of entries) {
    sortedReleases[k] = v;
  }

  const out = {
    ...validated,
    updatedAt: nowIso,
    releases: sortedReleases,
  };

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpFile = `${filePath}.tmp`;
  fs.writeFileSync(tmpFile, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpFile, filePath);
  return out;
}

/**
 * Determines whether a release should dispatch notifications and which topics remain pending.
 */
export function evaluateReleaseEligibility(ledger, releaseInfo, targetTopics, broadcastId) {
  const effectiveFloor = Math.max(MIN_EXCLUSIVE_VERSION_CODE, ledger.minExclusiveVersionCode ?? MIN_EXCLUSIVE_VERSION_CODE);
  if (releaseInfo.versionCode <= effectiveFloor) {
    return {
      eligible: false,
      reason: 'below_or_equal_floor',
      pendingTopics: [],
      alreadySentTopics: [],
    };
  }

  const matchingEntry =
    ledger.releases[releaseInfo.tag] ??
    Object.values(ledger.releases).find(
      (entry) =>
        entry.versionCode === releaseInfo.versionCode ||
        (broadcastId && entry.broadcastId === broadcastId),
    ) ??
    null;

  if (!matchingEntry) {
    return {
      eligible: true,
      reason: 'new_release',
      pendingTopics: [...targetTopics],
      alreadySentTopics: [],
    };
  }

  if (matchingEntry.status === 'preseeded_skip') {
    return {
      eligible: false,
      reason: 'preseeded_skip',
      pendingTopics: [],
      alreadySentTopics: [],
    };
  }

  const topicMap = matchingEntry.topics ?? {};
  const ambiguousTopics = targetTopics.filter((topic) => topicMap[topic]?.status === 'ambiguous');
  if (matchingEntry.status === 'ambiguous' || ambiguousTopics.length > 0) {
    return {
      eligible: false,
      reason: 'ambiguous_delivery_requires_review',
      pendingTopics: [],
      alreadySentTopics: targetTopics.filter((topic) => topicMap[topic]?.status === 'sent'),
      ambiguousTopics,
    };
  }

  const alreadySentTopics = targetTopics.filter((topic) => topicMap[topic]?.status === 'sent');
  const pendingTopics = targetTopics.filter((topic) => topicMap[topic]?.status !== 'sent');

  if (matchingEntry.status === 'sent' && pendingTopics.length === 0) {
    return {
      eligible: false,
      reason: 'already_sent',
      pendingTopics: [],
      alreadySentTopics,
    };
  }

  if (pendingTopics.length === 0) {
    return {
      eligible: false,
      reason: 'already_sent',
      pendingTopics: [],
      alreadySentTopics,
    };
  }

  return {
    eligible: true,
    reason: alreadySentTopics.length > 0 ? 'resume_partial_retry' : 'retry_failed_release',
    pendingTopics,
    alreadySentTopics,
  };
}

function sanitizeMessageIdTail(messageName) {
  if (typeof messageName !== 'string' || !messageName) return null;
  const segments = messageName.split('/');
  const tail = segments[segments.length - 1] || '';
  const safe = tail.replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 80);
  return safe || null;
}

/**
 * Records a single topic dispatch outcome and updates overall release status ('sent' | 'partial' | 'failed').
 */
export function recordTopicOutcome(ledger, releaseInfo, broadcastId, expectedTopics, topic, outcome, nowIso = new Date().toISOString()) {
  const existing = ledger.releases[releaseInfo.tag] ?? {
    tag: releaseInfo.tag,
    version: releaseInfo.version,
    versionCode: releaseInfo.versionCode,
    channel: releaseInfo.channel,
    broadcastId,
    assetSha256: releaseInfo.asset.sha256,
    status: 'failed',
    createdAt: nowIso,
    updatedAt: nowIso,
    topics: {},
  };

  const prevTopic = existing.topics?.[topic] ?? { attempts: 0 };
  const attempts = (prevTopic.attempts ?? 0) + (outcome.attempts ?? 1);

  const isAmbiguous = Boolean(outcome.ambiguous || outcome.deliveryState === 'ambiguous');
  const nextTopicState = outcome.ok
    ? {
        status: 'sent',
        sentAt: nowIso,
        messageId: sanitizeMessageIdTail(outcome.messageName),
        attempts,
      }
    : isAmbiguous
      ? {
          status: 'ambiguous',
          ambiguousAt: nowIso,
          attempts,
          lastError: String(outcome.errorSummary || `HTTP ${outcome.status ?? 'network_timeout'}`).slice(0, 160),
          duplicateRiskNote: 'Response dropped or 500/502/504 received; verify in Firebase Console before manual retry.',
        }
      : {
          status: 'failed',
          failedAt: nowIso,
          attempts,
          lastError: String(outcome.errorSummary || `HTTP ${outcome.status ?? 'error'}`).slice(0, 160),
        };

  const nextTopics = {
    ...existing.topics,
    [topic]: nextTopicState,
  };

  const anyAmbiguous = expectedTopics.some((t) => nextTopics[t]?.status === 'ambiguous');
  const sentCount = expectedTopics.filter((t) => nextTopics[t]?.status === 'sent').length;
  let nextStatus = 'failed';
  if (anyAmbiguous) {
    nextStatus = 'ambiguous';
  } else if (sentCount === expectedTopics.length) {
    nextStatus = 'sent';
  } else if (sentCount > 0) {
    nextStatus = 'partial';
  }

  ledger.releases[releaseInfo.tag] = {
    ...existing,
    version: releaseInfo.version,
    versionCode: releaseInfo.versionCode,
    channel: releaseInfo.channel,
    broadcastId,
    assetSha256: releaseInfo.asset.sha256,
    status: nextStatus,
    updatedAt: nowIso,
    topics: nextTopics,
  };

  return ledger.releases[releaseInfo.tag];
}
