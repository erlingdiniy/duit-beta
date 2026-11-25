#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="duit-beta"
PROJECT_NUMBER="96681551048"
REPO="erlingdiniy/duit-beta"
REPO_ID="1463804552"
OWNER_ID="334385638"
POOL_ID="github-actions-pool"
PROVIDER_ID="duit-beta-github-oidc"
SA_NAME="fcm-release-notifier"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
ROLE_ID="fcmReleaseNotifier"
ENV_NAME="fcm-release-notifications"

ATTR_MAP="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.environment=assertion.environment,attribute.event_name=assertion.event_name,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref"
ATTR_COND="assertion.repository_owner_id == '${OWNER_ID}' && assertion.repository_id == '${REPO_ID}' && assertion.environment == '${ENV_NAME}' && (assertion.event_name == 'release' || assertion.event_name == 'workflow_dispatch') && (assertion.ref == 'refs/heads/main' || assertion.ref.startsWith('refs/tags/v')) && (assertion.workflow_ref == '${REPO}/.github/workflows/release-notifications.yml@refs/heads/main' || assertion.workflow_ref.startsWith('${REPO}/.github/workflows/release-notifications.yml@refs/tags/v'))"

echo "[1/7] Setting active project ${PROJECT_ID}..."
gcloud config set project "$PROJECT_ID" >/dev/null

echo "[2/7] Enabling minimum required free-tier APIs..."
gcloud services enable \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  fcm.googleapis.com \
  --project="$PROJECT_ID"

echo "[3/7] Creating/updating minimal custom role ${ROLE_ID} (cloudmessaging.messages.create only)..."
if gcloud iam roles describe "$ROLE_ID" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam roles update "$ROLE_ID" \
    --project="$PROJECT_ID" \
    --title="FCM Release Notifier (Minimal)" \
    --description="Grants only cloudmessaging.messages.create for duit-beta release notifications" \
    --permissions="cloudmessaging.messages.create" \
    --stage=GA >/dev/null
else
  gcloud iam roles create "$ROLE_ID" \
    --project="$PROJECT_ID" \
    --title="FCM Release Notifier (Minimal)" \
    --description="Grants only cloudmessaging.messages.create for duit-beta release notifications" \
    --permissions="cloudmessaging.messages.create" \
    --stage=GA >/dev/null
fi

echo "[4/7] Creating keyless service account ${SA_EMAIL}..."
if ! gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" \
    --project="$PROJECT_ID" \
    --display-name="duit-beta GitHub Actions FCM Notifier" >/dev/null
fi

echo "[5/7] Binding minimal custom role to service account..."
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="projects/${PROJECT_ID}/roles/${ROLE_ID}" \
  --condition=None >/dev/null

echo "[6/7] Configuring Workload Identity Pool ${POOL_ID} and immutable-ID OIDC provider ${PROVIDER_ID}..."
if ! gcloud iam workload-identity-pools describe "$POOL_ID" --project="$PROJECT_ID" --location="global" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL_ID" \
    --project="$PROJECT_ID" \
    --location="global" \
    --display-name="GitHub Actions Pool" >/dev/null
fi

if gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" --project="$PROJECT_ID" --location="global" --workload-identity-pool="$POOL_ID" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers update-oidc "$PROVIDER_ID" \
    --project="$PROJECT_ID" \
    --location="global" \
    --workload-identity-pool="$POOL_ID" \
    --display-name="duit-beta GitHub OIDC" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="$ATTR_MAP" \
    --attribute-condition="$ATTR_COND" >/dev/null
else
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
    --project="$PROJECT_ID" \
    --location="global" \
    --workload-identity-pool="$POOL_ID" \
    --display-name="duit-beta GitHub OIDC" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="$ATTR_MAP" \
    --attribute-condition="$ATTR_COND" >/dev/null
fi

echo "[7/7] Binding Workload Identity User only to immutable GitHub repository_id ${REPO_ID}..."
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository_id/${REPO_ID}" >/dev/null

echo "=== VERIFICATION SUMMARY ==="
echo "ROLE_PERMISSIONS=$(gcloud iam roles describe "$ROLE_ID" --project="$PROJECT_ID" --format='value(includedPermissions)')"
echo "USER_MANAGED_SA_KEYS=$(gcloud iam service-accounts keys list --iam-account="$SA_EMAIL" --managed-by=user --format='value(name)' | wc -l | tr -d ' ')"
echo "WIF_PROVIDER=$(gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" --project="$PROJECT_ID" --location='global' --workload-identity-pool="$POOL_ID" --format='value(name)')"
echo "WIF_CONDITION=$(gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" --project="$PROJECT_ID" --location='global' --workload-identity-pool="$POOL_ID" --format='value(attributeCondition)')"
echo "SETUP_COMPLETE=OK"
