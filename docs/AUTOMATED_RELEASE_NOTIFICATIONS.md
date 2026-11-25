# Automated Release Notifications (`erlingdiniy/duit-beta`)

Keyless GitHub Actions + Firebase Cloud Messaging HTTP v1 pipeline for `duit.` release announcements.

## 1. Architecture Summary

- **Trigger:** Runs automatically on `release: types: [published]` and manually via `workflow_dispatch` (`dry_run: true` by default, optional `fcm_validate_only`).
- **Authentication:** Keyless GitHub Actions OIDC -> Google Cloud Workload Identity Federation (`google-github-actions/auth`) issuing a short-lived `300s` OAuth 2.0 access token scoped solely to `https://www.googleapis.com/auth/firebase.messaging` with zero credentials written to disk and zero static JSON service account keys.
- **Release & APK Integrity Verification:** Before sending any notification, [`automation/release-notifications/run.mjs`](../automation/release-notifications/run.mjs) verifies:
  - Non-draft release matching `BetaUpdates.kt` version/tag rules (`vX.Y.Z` for Stable `prerelease=false`, `vX.Y.0-beta.N` for Beta `prerelease=true`).
  - Release title version parity, release notes presence, and exact APK asset contract (`duit-<version>.apk`, `state=uploaded`, exact GitHub download URL, `1 MB..100 MB` size, `sha256:...` digest, and release-body checksum parity).
  - Live streamed binary download of the APK over HTTPS allowlisted GitHub hosts checking exact byte size, exact SHA-256 checksum, ZIP magic header, `AndroidManifest.xml`, and `classes*.dex`.
- **Audience Routing & Duplicate Minimization:**
  - **Beta (`prerelease=true`):** Sends only to topic `duit_beta_broadcasts`.
  - **Stable (`prerelease=false`):** Sends two single-topic FCM HTTP v1 requests (`duit_announcements` for Stable subscribers and `duit_beta_broadcasts` for public/closed Beta testers so testers learn that Stable graduated).
  - *Why two single-topic sends instead of an FCM `condition`:* Shipped Android clients enforce `DeveloperBroadcastSpec.isAllowedSender(from, expectedTopic)` for foreground messages, which requires an exact `/topics/<expectedTopic>` match; FCM `condition` sends can alter `from` on some devices, whereas single-topic sends always preserve exact `/topics/...` origin.
  - Both Stable topic sends share the same `data.broadcast_id`, `android.collapse_key`, and `android.notification.tag` (`duit-release-<version>`). Combined with `v1.2.0`+ unsubscribing from the inactive topic on channel change and Android `NotificationManager` tag replacement, users receive at most one notification.
- **Channel & Payload Safety:** Targets Android notification channel `duit_developer_broadcasts` with `visibility: PRIVATE`, sanitized summary text, `route: "home"`, and an immutable release-level safety floor blocking `versionCode <= 1002000` (`v1.2.0` and earlier are permanently blocked from resend).
- **Persistent Deduplication:** Stored cleanly on an orphan `notification-state` branch at `state/release-notifications.json` (`preseeded_skip`/`sent`/`partial`/`failed`/`ambiguous` per release and per topic). Live dispatch fails closed if `notification-state` does not exist or if `ENABLE_LIVE_FCM_DISPATCH != 'true'`.

---

## 2. Manual Google Cloud Setup (`duit-beta`, Project Number `96681551048`)

Run [`automation/release-notifications/scripts/setup-gcp-wif.sh`](../automation/release-notifications/scripts/setup-gcp-wif.sh) in **Google Cloud Shell** (recommended, no local `gcloud` needed) after selecting project `duit-beta`.

### Option A — Google Cloud Shell (`gcloud` with immutable GitHub IDs)

```bash
export PROJECT_ID="duit-beta"
export PROJECT_NUMBER="96681551048"
export REPO="erlingdiniy/duit-beta"
export REPO_ID="1463804552"
export OWNER_ID="334385638"
export POOL_ID="github-actions-pool"
export PROVIDER_ID="duit-beta-github-oidc"
export SA_NAME="fcm-release-notifier"
export SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
export ROLE_ID="fcmReleaseNotifier"
export ENV_NAME="fcm-release-notifications"

gcloud config set project "$PROJECT_ID"

# 1. Enable minimum required APIs (free tier, no compute/billing resources added)
gcloud services enable \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  fcm.googleapis.com

# 2. Create custom least-privilege IAM role with ONLY cloudmessaging.messages.create
gcloud iam roles create "$ROLE_ID" \
  --project="$PROJECT_ID" \
  --title="FCM Release Notifier (Minimal)" \
  --description="Grants only cloudmessaging.messages.create for duit-beta release notifications" \
  --permissions="cloudmessaging.messages.create" \
  --stage=GA

# 3. Create dedicated Service Account (DO NOT create any JSON key!)
gcloud iam service-accounts create "$SA_NAME" \
  --project="$PROJECT_ID" \
  --display-name="duit-beta GitHub Actions FCM Notifier"

# 4. Grant ONLY the custom FCM send role to the Service Account
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="projects/${PROJECT_ID}/roles/${ROLE_ID}"

# 5. Create Workload Identity Pool for GitHub Actions OIDC
gcloud iam workload-identity-pools create "$POOL_ID" \
  --project="$PROJECT_ID" \
  --location="global" \
  --display-name="GitHub Actions Pool"

# 6. Create OIDC Provider restricted by immutable repository_id, repository_owner_id, environment, workflow_ref & trusted refs
gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
  --project="$PROJECT_ID" \
  --location="global" \
  --workload-identity-pool="$POOL_ID" \
  --display-name="duit-beta GitHub OIDC" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.environment=assertion.environment,attribute.event_name=assertion.event_name,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref" \
  --attribute-condition="assertion.repository_owner_id == '${OWNER_ID}' && assertion.repository_id == '${REPO_ID}' && assertion.environment == '${ENV_NAME}' && (assertion.event_name == 'release' || assertion.event_name == 'workflow_dispatch') && (assertion.ref == 'refs/heads/main' || assertion.ref.startsWith('refs/tags/v')) && (assertion.workflow_ref == '${REPO}/.github/workflows/release-notifications.yml@refs/heads/main' || assertion.workflow_ref.startsWith('${REPO}/.github/workflows/release-notifications.yml@refs/tags/v'))"

# 7. Bind Workload Identity User strictly using immutable repository_id
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository_id/${REPO_ID}"

# 8. Verify zero user-managed keys and copy outputs into GitHub Environment Secrets
gcloud iam service-accounts keys list --iam-account="$SA_EMAIL" --managed-by=user
echo "GCP_WIF_PROVIDER = projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"
echo "GCP_SERVICE_ACCOUNT = ${SA_EMAIL}"
```

### Option B — Google Cloud Console UI Steps

1. Open [Google Cloud Console](https://console.cloud.google.com/) and select project **`duit-beta`** (`96681551048`).
2. **APIs & Services -> Library**: verify **Firebase Cloud Messaging API**, **Identity and Access Management (IAM) API**, **IAM Service Account Credentials API**, and **Security Token Service API** are enabled.
3. **IAM & Admin -> Roles -> + Create Role**:
   - Title: `FCM Release Notifier (Minimal)`, ID: `fcmReleaseNotifier`, Launch stage: `General Availability`.
   - Add permission **`cloudmessaging.messages.create`** only -> Create.
4. **IAM & Admin -> Service Accounts -> + Create Service Account**:
   - ID: `fcm-release-notifier` (`fcm-release-notifier@duit-beta.iam.gserviceaccount.com`).
   - Grant project access role **`Custom -> FCM Release Notifier (Minimal)`** -> Done. Do **not** create any private key under Keys.
5. **IAM & Admin -> Workload Identity Federation -> + Create Pool**:
   - Name: `github-actions-pool` -> **Add a provider to pool** -> **OpenID Connect (OIDC)**.
   - Provider ID: `duit-beta-github-oidc`, Issuer URL: `https://token.actions.githubusercontent.com`, Default audience.
   - Attribute mapping: `google.subject`=`assertion.sub`, `attribute.repository`=`assertion.repository`, `attribute.repository_id`=`assertion.repository_id`, `attribute.repository_owner_id`=`assertion.repository_owner_id`, `attribute.environment`=`assertion.environment`, `attribute.event_name`=`assertion.event_name`, `attribute.ref`=`assertion.ref`, `attribute.workflow_ref`=`assertion.workflow_ref`.
   - Attribute condition:
     `assertion.repository_owner_id == '334385638' && assertion.repository_id == '1463804552' && assertion.environment == 'fcm-release-notifications' && (assertion.event_name == 'release' || assertion.event_name == 'workflow_dispatch') && (assertion.ref == 'refs/heads/main' || assertion.ref.startsWith('refs/tags/v')) && (assertion.workflow_ref == 'erlingdiniy/duit-beta/.github/workflows/release-notifications.yml@refs/heads/main' || assertion.workflow_ref.startsWith('erlingdiniy/duit-beta/.github/workflows/release-notifications.yml@refs/tags/v'))`
6. **Grant Access** from the pool to Service Account `fcm-release-notifier@duit-beta.iam.gserviceaccount.com` using attribute `repository_id` = `1463804552`.

---

## 3. Manual GitHub Setup (`erlingdiniy/duit-beta`, After Approval)

1. **Create GitHub Environment `fcm-release-notifications`** (`Settings -> Environments -> New environment`):
   - **Deployment branches and tags:** Select **Selected branches and tags**, then add:
     - Branch pattern: `main`
     - Tag pattern: `v*`
   - Optional extra guardrail: enable **Required reviewers** (add `erlingdiniy`) if you want a manual approve click before any live dispatch executes.
   - **Environment secrets:**
     - `GCP_WIF_PROVIDER`: `projects/96681551048/locations/global/workloadIdentityPools/github-actions-pool/providers/duit-beta-github-oidc`
     - `GCP_SERVICE_ACCOUNT`: `fcm-release-notifier@duit-beta.iam.gserviceaccount.com`
   - **Environment variables:**
     - `FIREBASE_PROJECT_ID`: `duit-beta`
2. **Initialize the `notification-state` orphan branch** (from a separate clean worktree so `main` stays untouched):
   ```bash
   git worktree add --orphan -b notification-state ../duit-beta-state-init
   mkdir -p ../duit-beta-state-init/state
   cp automation/release-notifications/state-seed/release-notifications.json ../duit-beta-state-init/state/release-notifications.json
   git -C ../duit-beta-state-init add state/release-notifications.json
   git -C ../duit-beta-state-init commit -m "Initialize pre-seeded FCM release notification dedup state (through v1.2.0)"
   git -C ../duit-beta-state-init push -u origin notification-state
   git worktree remove ../duit-beta-state-init
   ```
3. **Protect `main` and `v*` tags** (`Settings -> Rules -> Rulesets`):
   - Protect `main` against force-pushes and unreviewed edits to `.github/workflows/**` and `automation/**`.
   - Protect tag pattern `v*` against deletion/force-updates.
4. **Push `.github/workflows/release-notifications.yml`, `automation/release-notifications/**`, and this doc to `main`** once approved.

---

## 4. Safe Verification Checklist (Post-Enablement)

1. Run **Actions -> Automated Release Notifications -> Run workflow** with:
   - `release_tag`: `v1.2.0`
   - `dry_run`: `true`
   - `fcm_validate_only`: `false`
   - Confirm **`validate-and-plan`** verifies `duit-1.2.0.apk`, outputs `should_dispatch=false` (`skip_reason=below_or_equal_floor` or `preseeded_skip`), and skips `dispatch-notifications`.
2. When ready to verify WIF/OIDC + FCM API connectivity without sending a real notification to any user, run `workflow_dispatch` with `release_tag: v1.2.0`, `dry_run: true`, `fcm_validate_only: true` and inspect the **`fcm-validate-only`** job logs (GitHub masks the short-lived `FCM_ACCESS_TOKEN`, verifies `validate_only: true` HTTP `200`, and sends zero notifications).
3. On the next genuine prerelease (`v1.3.0-beta.1`) or patch release (`v1.2.1`), `release: published` will automatically validate the APK and dispatch once.

---

## 5. Security Notes & Known Limitations

- **No long-lived keys:** Static Firebase Admin SDK JSON keys are never created or stored.
- **No direct device token handling:** All targeting uses FCM topics; no registration tokens are read, stored, or logged.
- **Kill-switch (`ENABLE_LIVE_FCM_DISPATCH`):** Live dispatch requires Repository Variable `ENABLE_LIVE_FCM_DISPATCH == 'true'` in addition to `dry_run=false`, `versionCode > 1002000`, and `notification-state` eligibility. Keep `ENABLE_LIVE_FCM_DISPATCH=false` until verification is approved.
- **`workflow_dispatch` with `dry_run=false` guardrail:** Restricted to repo admins (`erlingdiniy`) and locked behind GitHub Environment `fcm-release-notifications` (plus optional Required Reviewers), hard version floor `> 1002000`, and `notification-state` ledger checks so already-sent releases cannot be re-broadcast.
- **Public distribution metadata:** Because `erlingdiniy/duit-beta` is public, `state/release-notifications.json` on branch `notification-state` is publicly readable and must contain only non-sensitive release metadata (tags, SHA-256 checksums, timestamps, topic names, sanitized error codes).

### Ambiguous Failures & Duplicate Delivery Risk Analysis

FCM HTTP v1 `messages:send` has no native client idempotency key for topic sends. This automation classifies failures strictly by duplicate risk:

1. **Definite non-delivery (`429`, `503`):** Retried automatically up to 3 attempts honoring `Retry-After` or exponential backoff with jitter (`validateOnly=false` and `validateOnly=true`).
2. **Non-retryable client/auth errors (`400`, `401`, `403`, `404`):** Fail immediately on attempt 1 with `status: "failed"`, never retried automatically.
3. **Ambiguous server/transport failures (`500`, `502`, `504`, network drops, request timeouts):** Because FCM may have accepted and fanned out the topic message before the HTTP response failed or timed out, live sends (`validateOnly=false`) **never** auto-retry ambiguous outcomes. Instead, the topic and release are recorded as `status: "ambiguous"` in `state/release-notifications.json`, which permanently blocks future automated re-sends (`ambiguous_delivery_requires_review`) until a maintainer checks Firebase Console / test devices and clears the ambiguous state manually.
4. **Client-side duplicate mitigations & residual risk:** Every topic message includes `android.notification.tag`, `android.collapse_key`, and `data.broadcast_id` set to `duit-release-<version>`, and `v1.2.0`+ clients unsubscribe from the inactive topic on launch. Even if a broadcast hits the same unread device tray twice, Android replaces the existing tray entry (`tag`). **Residual risk:** If an operator manually forces a re-send after users already received and dismissed an ambiguous first copy, or if two separate devices run pre-`v1.2.0` vs `v1.2.0`, already-dismissed notifications will show again.

- **Concurrency window:** GitHub `concurrency.group: duit-release-notifications` (`cancel-in-progress: false`) serializes runs sequentially; the state push step retries with `git pull --rebase` up to 3 times if concurrent writes ever occur.
- **Beta-to-Stable transition overlap:** Any Beta user who already upgraded to Stable `v1.2.0`+ automatically unsubscribed from `duit_beta_broadcasts` on launch, and users still on `v1.2.0-beta.1`/`beta.2` only subscribe to `duit_beta_broadcasts`. Combined with shared deterministic notification IDs/tags, subscribers receive a single announcement when a new Stable release ships.
