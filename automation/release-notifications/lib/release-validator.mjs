import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_REPO = 'erlingdiniy/duit-beta';
export const MIN_EXCLUSIVE_VERSION_CODE = 1_002_000;
export const MAX_APK_BYTES = 100 * 1024 * 1024;
export const MIN_APK_BYTES = 1_000_000;
export const MAX_NOTES_CHARS = 12_000;
export const DOWNLOAD_HOSTS = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);

const REPO_REGEX = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const STABLE_TAG_REGEX = /^v([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/;
const BETA_TAG_REGEX = /^v([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})-beta\.([1-9][0-9]?)$/;
const VERSION_NAME_REGEX = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/;
const DIGEST_REGEX = /^sha256:([0-9a-fA-F]{64})$/;
const BODY_SHA256_REGEX = /SHA-256 APK:\s*`?([0-9a-fA-F]{64})`?/i;
const PUBLISHED_DATE_REGEX = /^(\d{4}-\d{2}-\d{2})/;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Mirrors BetaUpdates.kt tag/prerelease identity and versionCode encoding rules.
 */
export function parseReleaseIdentity(release) {
  const errors = [];
  if (!release || typeof release !== 'object') {
    return { ok: false, errors: ['Release payload must be a JSON object.'], identity: null };
  }

  if (release.draft !== false) {
    errors.push(`Draft releases are not eligible for notifications (draft=${String(release.draft)}).`);
  }

  if (typeof release.prerelease !== 'boolean') {
    errors.push(`Release prerelease flag must be a boolean (received ${String(release.prerelease)}).`);
  }

  const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
  if (!tag || tag.trim() !== tag) {
    errors.push('Release tag_name must be a non-empty string without surrounding whitespace.');
  }

  if (errors.length > 0) {
    return { ok: false, errors, identity: null };
  }

  if (release.prerelease) {
    const betaMatch = BETA_TAG_REGEX.exec(tag);
    if (!betaMatch) {
      if (STABLE_TAG_REGEX.test(tag)) {
        return {
          ok: false,
          errors: [`Tag "${tag}" is a Stable semver tag but prerelease=true.`],
          identity: null,
        };
      }
      return {
        ok: false,
        errors: [`Prerelease tag "${tag}" does not match expected format vX.Y.0-beta.N (N in 1..99).`],
        identity: null,
      };
    }

    const major = Number.parseInt(betaMatch[1], 10);
    const minor = Number.parseInt(betaMatch[2], 10);
    const patch = Number.parseInt(betaMatch[3], 10);
    const betaNum = Number.parseInt(betaMatch[4], 10);

    if (patch !== 0 || betaNum < 1 || betaNum > 99 || major * 1000 + minor === 0) {
      return {
        ok: false,
        errors: [`Closed beta tag "${tag}" violates BetaUpdates versionCode rules (patch must be 0, beta in 1..99, major/minor > 0).`],
        identity: null,
      };
    }

    const versionCode = (major * 1_000_000 + minor * 1_000) - 100 + betaNum;
    if (versionCode <= 0 || versionCode > 2_100_000_000) {
      return {
        ok: false,
        errors: [`Computed beta versionCode ${versionCode} is out of bounds.`],
        identity: null,
      };
    }

    const version = `${major}.${minor}.${patch}-beta.${betaNum}`;
    return {
      ok: true,
      errors: [],
      identity: {
        tag,
        version,
        versionCode,
        channel: 'beta',
        prerelease: true,
        expectedAssetName: `duit-${version}.apk`,
      },
    };
  }

  const stableMatch = STABLE_TAG_REGEX.exec(tag);
  if (!stableMatch) {
    if (BETA_TAG_REGEX.test(tag)) {
      return {
        ok: false,
        errors: [`Tag "${tag}" is a Beta prerelease tag but prerelease=false.`],
        identity: null,
      };
    }
    return {
      ok: false,
      errors: [`Stable tag "${tag}" does not match expected format vX.Y.Z.`],
      identity: null,
    };
  }

  const major = Number.parseInt(stableMatch[1], 10);
  const minor = Number.parseInt(stableMatch[2], 10);
  const patch = Number.parseInt(stableMatch[3], 10);
  const versionCode = major * 1_000_000 + minor * 1_000 + patch;
  if (versionCode <= 0 || versionCode > 2_100_000_000) {
    return {
      ok: false,
      errors: [`Computed stable versionCode ${versionCode} is out of bounds.`],
      identity: null,
    };
  }

  const version = `${major}.${minor}.${patch}`;
  return {
    ok: true,
    errors: [],
    identity: {
      tag,
      version,
      versionCode,
      channel: 'stable',
      prerelease: false,
      expectedAssetName: `duit-${version}.apk`,
    },
  };
}

/**
 * Validates GitHub release metadata, APK asset contract, SHA-256 digest presence,
 * release notes parity, and minimum versionCode floor.
 */
export function validateReleaseMetadata(
  release,
  {
    repo = DEFAULT_REPO,
    minExclusiveVersionCode = MIN_EXCLUSIVE_VERSION_CODE,
    minApkBytes = MIN_APK_BYTES,
  } = {},
) {
  const errors = [];
  const warnings = [];

  if (typeof repo !== 'string' || !REPO_REGEX.test(repo)) {
    errors.push(`Invalid repository identifier "${String(repo)}".`);
  }

  const idResult = parseReleaseIdentity(release);
  if (!idResult.ok) {
    return {
      ok: false,
      errors: [...errors, ...idResult.errors],
      warnings,
      belowFloor: false,
      releaseInfo: null,
    };
  }

  const identity = idResult.identity;
  const title = typeof release.name === 'string' ? release.name.trim() : '';
  const nameVersionMatch = VERSION_NAME_REGEX.exec(title);
  if (!title) {
    errors.push('Release title (name) is missing.');
  } else if (!nameVersionMatch || nameVersionMatch[0] !== identity.version) {
    errors.push(
      `Release title "${title}" does not contain exact version "${identity.version}" required by BetaUpdates.kt.`,
    );
  }

  const publishedAt = typeof release.published_at === 'string' ? release.published_at : '';
  const publishedMatch = PUBLISHED_DATE_REGEX.exec(publishedAt);
  if (!publishedMatch) {
    errors.push(`Release published_at ("${publishedAt}") is missing or malformed.`);
  }

  const body = typeof release.body === 'string' ? release.body : '';
  if (!body.trim()) {
    errors.push('Release notes body is empty.');
  } else if (body.length > MAX_NOTES_CHARS) {
    warnings.push(`Release notes exceed ${MAX_NOTES_CHARS} chars (${body.length}); app changelog truncates at ${MAX_NOTES_CHARS}.`);
  }

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const matchingAssets = assets.filter((asset) => asset && asset.name === identity.expectedAssetName);
  let validAsset = null;

  if (matchingAssets.length === 0) {
    errors.push(`Expected release asset "${identity.expectedAssetName}" is missing.`);
  } else if (matchingAssets.length > 1) {
    errors.push(`Multiple assets match "${identity.expectedAssetName}".`);
  } else {
    const asset = matchingAssets[0];
    const expectedDownloadUrl = `https://github.com/${repo}/releases/download/${identity.tag}/${identity.expectedAssetName}`;

    if (asset.state !== 'uploaded') {
      errors.push(`Asset "${asset.name}" is not in uploaded state (state=${String(asset.state)}).`);
    }
    if (asset.browser_download_url !== expectedDownloadUrl) {
      errors.push(`Asset download URL mismatch (expected ${expectedDownloadUrl}, got ${String(asset.browser_download_url)}).`);
    }
    if (!Number.isInteger(asset.size) || asset.size < minApkBytes || asset.size > MAX_APK_BYTES) {
      errors.push(`Asset size ${String(asset.size)} is outside allowed APK bounds (${minApkBytes}..${MAX_APK_BYTES} bytes).`);
    }

    const digestMatch = typeof asset.digest === 'string' ? DIGEST_REGEX.exec(asset.digest) : null;
    if (!digestMatch) {
      errors.push(`Asset SHA-256 digest is missing or invalid ("${String(asset.digest)}").`);
    } else {
      const sha256 = digestMatch[1].toLowerCase();
      const bodyShaMatch = BODY_SHA256_REGEX.exec(body);
      if (bodyShaMatch && bodyShaMatch[1].toLowerCase() !== sha256) {
        errors.push(`Release notes SHA-256 (${bodyShaMatch[1].toLowerCase()}) does not match GitHub asset digest (${sha256}).`);
      }
      validAsset = {
        name: asset.name,
        size: asset.size,
        sha256,
        downloadUrl: asset.browser_download_url,
      };
    }
  }

  const belowFloor = identity.versionCode <= minExclusiveVersionCode;
  if (belowFloor) {
    warnings.push(
      `Release ${identity.tag} (versionCode=${identity.versionCode}) is <= safety floor ${minExclusiveVersionCode} and will not be broadcast.`,
    );
  }

  const ok = errors.length === 0 && validAsset !== null;
  return {
    ok,
    errors,
    warnings,
    belowFloor,
    releaseInfo: validAsset
      ? {
          repo,
          tag: identity.tag,
          version: identity.version,
          versionCode: identity.versionCode,
          channel: identity.channel,
          prerelease: identity.prerelease,
          publishedDate: publishedMatch ? publishedMatch[1] : '',
          title,
          body,
          asset: validAsset,
        }
      : null,
  };
}

/**
 * Inspects ZIP local header and Central Directory via an offset reader to verify
 * that the file is a structurally valid APK containing AndroidManifest.xml and classes*.dex.
 */
export function inspectApkWithReader(readSliceSync, fileSize) {
  if (!Number.isInteger(fileSize) || fileSize < 22) {
    return { ok: false, error: `Invalid APK file size (${fileSize} bytes).` };
  }

  const header = readSliceSync(0, 4);
  if (header.length < 4 || header[0] !== 0x50 || header[1] !== 0x4b || header[2] !== 0x03 || header[3] !== 0x04) {
    return { ok: false, error: 'Downloaded file does not begin with a valid ZIP/APK local header (PK\\x03\\x04).' };
  }

  const tailSize = Math.min(fileSize, 65_557);
  const tailOffset = fileSize - tailSize;
  const tail = readSliceSync(tailOffset, tailSize);

  let eocdPos = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      const commentLen = tail.readUInt16LE(i + 20);
      if (i + 22 + commentLen === tail.length) {
        eocdPos = i;
        break;
      }
    }
  }

  if (eocdPos < 0) {
    return { ok: false, error: 'Downloaded file is missing a valid ZIP End of Central Directory (EOCD) record.' };
  }

  const totalEntries = tail.readUInt16LE(eocdPos + 10);
  const cdSize = tail.readUInt32LE(eocdPos + 12);
  const cdOffset = tail.readUInt32LE(eocdPos + 16);

  if (cdOffset + cdSize > fileSize || cdSize > 16 * 1024 * 1024) {
    return { ok: false, error: `ZIP Central Directory bounds are invalid (offset=${cdOffset}, size=${cdSize}, fileSize=${fileSize}).` };
  }

  const cdBuf = readSliceSync(cdOffset, cdSize);
  let cursor = 0;
  let parsedEntries = 0;
  let hasManifest = false;
  let hasDex = false;
  let hasCertMeta = false;

  while (cursor + 46 <= cdBuf.length && parsedEntries < totalEntries) {
    if (
      cdBuf[cursor] !== 0x50 ||
      cdBuf[cursor + 1] !== 0x4b ||
      cdBuf[cursor + 2] !== 0x01 ||
      cdBuf[cursor + 3] !== 0x02
    ) {
      return { ok: false, error: `Corrupt ZIP Central Directory header at offset ${cursor}.` };
    }
    const nameLen = cdBuf.readUInt16LE(cursor + 28);
    const extraLen = cdBuf.readUInt16LE(cursor + 30);
    const commentLen = cdBuf.readUInt16LE(cursor + 32);
    const entryEnd = cursor + 46 + nameLen + extraLen + commentLen;
    if (entryEnd > cdBuf.length) {
      return { ok: false, error: 'Truncated ZIP Central Directory entry.' };
    }

    const name = cdBuf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    if (name === 'AndroidManifest.xml') hasManifest = true;
    if (/^classes[0-9]*\.dex$/.test(name)) hasDex = true;
    if (name.startsWith('META-INF/') && /\.(RSA|DSA|EC|SF)$/i.test(name)) hasCertMeta = true;

    cursor = entryEnd;
    parsedEntries += 1;
  }

  if (!hasManifest || !hasDex) {
    return {
      ok: false,
      error: `ZIP archive is not a valid Android APK (AndroidManifest.xml=${hasManifest}, classes*.dex=${hasDex}).`,
    };
  }

  return {
    ok: true,
    entryCount: parsedEntries,
    hasManifest,
    hasDex,
    hasCertMeta,
  };
}

export function inspectApkBuffer(buffer) {
  return inspectApkWithReader(
    (offset, length) => buffer.subarray(offset, offset + length),
    buffer.length,
  );
}

export function inspectApkFile(filePath, fileSize) {
  const fd = fs.openSync(filePath, 'r');
  try {
    return inspectApkWithReader((offset, length) => {
      const buf = Buffer.allocUnsafe(length);
      let totalRead = 0;
      while (totalRead < length) {
        const read = fs.readSync(fd, buf, totalRead, length - totalRead, offset + totalRead);
        if (read <= 0) break;
        totalRead += read;
      }
      return totalRead === length ? buf : buf.subarray(0, totalRead);
    }, fileSize);
  } finally {
    fs.closeSync(fd);
  }
}

function validateDownloadUrl(rawUrl, allowHosts, allowInsecureTestHosts) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Malformed APK download URL: "${rawUrl}".`);
  }

  const allowedProtocol = allowInsecureTestHosts
    ? parsed.protocol === 'https:' || parsed.protocol === 'http:'
    : parsed.protocol === 'https:';
  if (!allowedProtocol) {
    throw new Error(`Blocked insecure APK download protocol "${parsed.protocol}".`);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error('Blocked APK download URL containing credentials or fragments.');
  }
  if (!allowInsecureTestHosts && parsed.port && parsed.port !== '443') {
    throw new Error(`Blocked non-443 APK download port "${parsed.port}".`);
  }
  if (!allowHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error(`Blocked untrusted APK download host "${parsed.hostname}".`);
  }
  return parsed;
}

/**
 * Streams the remote APK asset through strict redirect/host checks into a temp file,
 * verifies exact byte length + SHA-256 + ZIP/APK structure, and deletes the temp file.
 */
export async function verifyRemoteApkAsset(
  asset,
  {
    allowHosts = DOWNLOAD_HOSTS,
    allowInsecureTestHosts = false,
    fetchImpl = fetch,
    timeoutMs = 60_000,
    downloadUrlOverride = null,
  } = {},
) {
  let currentUrl = validateDownloadUrl(
    downloadUrlOverride ?? asset.downloadUrl,
    allowHosts,
    allowInsecureTestHosts,
  ).toString();

  let response = null;
  for (let hop = 0; hop < 6; hop += 1) {
    response = await fetchImpl(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: 'application/octet-stream' },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel?.();
      if (!location) {
        throw new Error(`Redirect (HTTP ${response.status}) missing Location header while fetching APK.`);
      }
      currentUrl = validateDownloadUrl(
        new URL(location, currentUrl).toString(),
        allowHosts,
        allowInsecureTestHosts,
      ).toString();
      continue;
    }

    if (response.status === 200) {
      break;
    }

    await response.body?.cancel?.();
    throw new Error(`APK download failed with HTTP ${response.status}.`);
  }

  if (!response || response.status !== 200 || !response.body) {
    throw new Error('Too many redirects or empty response body while downloading APK.');
  }

  const tmpPath = path.join(os.tmpdir(), `duit-apk-verify-${crypto.randomUUID()}.apk`);
  const hash = crypto.createHash('sha256');
  let actualBytes = 0;
  const out = fs.createWriteStream(tmpPath);

  try {
    for await (const chunk of response.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      actualBytes += buf.length;
      if (actualBytes > asset.size) {
        throw new Error(`Downloaded APK exceeds declared size (${actualBytes} > ${asset.size} bytes).`);
      }
      hash.update(buf);
      if (!out.write(buf)) {
        await new Promise((resolve, reject) => {
          const onDrain = () => {
            out.off('error', onError);
            resolve();
          };
          const onError = (err) => {
            out.off('drain', onDrain);
            reject(err);
          };
          out.once('drain', onDrain);
          out.once('error', onError);
        });
      }
    }

    await new Promise((resolve, reject) => {
      out.end((err) => (err ? reject(err) : resolve()));
    });

    const actualSha256 = hash.digest('hex').toLowerCase();
    if (actualBytes !== asset.size) {
      throw new Error(`Downloaded APK byte length mismatch (expected ${asset.size}, got ${actualBytes}).`);
    }
    if (actualSha256 !== asset.sha256) {
      throw new Error(`Downloaded APK SHA-256 mismatch (expected ${asset.sha256}, got ${actualSha256}).`);
    }

    const apkCheck = inspectApkFile(tmpPath, actualBytes);
    if (!apkCheck.ok) {
      throw new Error(apkCheck.error);
    }

    return {
      ok: true,
      bytes: actualBytes,
      sha256: actualSha256,
      zipEntries: apkCheck.entryCount,
      hasManifest: apkCheck.hasManifest,
      hasDex: apkCheck.hasDex,
      hasCertMeta: apkCheck.hasCertMeta,
    };
  } finally {
    out.destroy();
    fs.rmSync(tmpPath, { force: true });
  }
}
