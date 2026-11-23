# duit. Privacy Policy

**Effective date:** 23 November 2026  
**Applies to:** the public duit. Android app (`com.diniy.duit.beta`), version `1.2.0-beta.1` and later, distributed through GitHub Releases (`erlingdiniy/duit-beta`). Personal builds built from source (`com.diniy.duit`) request no `INTERNET` permission and exclude Firebase entirely.

duit. is a local-first personal finance app made by an independent developer (GitHub: **erlingdiniy**). This policy explains what the app stores on your device, what limited network connections the public release makes, and the controls you have.

## 1. Summary

- Your financial records and attached receipts stay on your phone. There is no account and no cloud sync.
- The public release (`com.diniy.duit.beta`) goes online for three things only:
  1. Checking GitHub Releases (`erlingdiniy/duit-beta`) for app updates.
  2. Sending feedback **you choose** to submit.
  3. Receiving **Developer Broadcasts** (release announcements via Firebase Cloud Messaging topic, with analytics and advertising IDs disabled).
- Your balances, transactions, budgets, goals, tax notes, receipts, and backups are never sent to the developer.
- The app contains no advertising, no behavioral tracking, and no analytics SDKs.

## 2. Data stored on your device

duit. stores your wallets, transactions, budgets, savings goals, savings challenges, bills, PayLater plans, debts, optional commission records, Smart Money Calendar reminders, My Tax Pocket relief records, Little Wins Club milestones, and app preferences in the app's private storage on your phone (a local Room SQLite database and DataStore preference files).

- **Receipt Vault attachments:** When you attach a receipt photo, camera capture, or PDF document in Receipt Vault:
  - Images are compressed to JPEG and documents/images are copied into the app's private directory (`filesDir/receipts/`), up to **10 MB per file**.
  - Receipts are never written to your shared photo gallery or public `MediaStore` folders.
  - Temporary camera capture files stored in the app's private cache during import are deleted after import completes.
- **On-device storage protection:** The local database and receipt files rely on Android's app-private sandbox rather than separate SQLCipher or per-file database encryption. On a standard (non-rooted) phone, Android keeps app-private storage isolated from other apps.
- **Android auto-backup is disabled:** `android:allowBackup="false"` is set in the manifest so Android does not automatically copy your database or receipts to Google Drive or device-to-device transfer.
- **Widgets and notifications** can show amounts on your home screen and lock screen. You can mask amounts using Privacy Mode, App Lock, or notification privacy settings.

## 3. Security features

- **App Lock (PIN and biometric):** You can set a 6-digit PIN and optionally enable your device's fingerprint/biometric unlock. Your PIN is never stored in plain text: duit. derives a salted hash (PBKDF2-HMAC-SHA256) protected by a key in the Android Keystore (`AES/GCM/NoPadding`). Repeated failed attempts trigger a cooldown delay.
- While App Lock is enabled, duit. blocks screenshots (`FLAG_SECURE`), hides app content in the recents overview, and hides amounts in widgets and notifications.
- **Privacy Mode** masks monetary amounts on screen across the app and home screen widgets.

These safeguards reduce casual access on a lost or shared phone; they do not guarantee protection on a rooted or compromised device.

## 4. Backups and exports

- **Encrypted backups (`.duitbackup`):** Created in **Settings -> Backup & Restore** and saved wherever you choose through Android's system document picker.
  - Encrypted with **AES-256-GCM** using a key derived via **PBKDF2-HMAC-SHA256** from the password you enter.
  - Includes financial records plus Receipt Vault attachment files (up to **12 MB** of raw receipt files per archive, with an overall **32 MB** encrypted backup file cap).
  - The developer never receives your backups or passwords, and **a forgotten backup password cannot be recovered**.
- **Atomic restore:** Restoring verifies the password, archive integrity, and receipt staging before replacing your live database or receipt files. If decryption, validation, or file staging fails, your existing records and receipts remain untouched. Restoring does not overwrite your App Lock PIN.
- **CSV exports:** Plain, unencrypted text spreadsheets intended for external spreadsheet tools. Anyone who can access an exported CSV can read it.

## 5. Feedback you send

If you choose to submit feedback under **Settings -> Help & Feedback**, duit. sends only:

| Data | Purpose |
| --- | --- |
| Category (`Bug Report`, `Feature Request`, or `General Feedback`) | Categorize feedback |
| Your message (10–2,000 characters) | Feedback content |
| Your email address (**only if you choose to provide it**) | Allows the developer to reply |
| App version | Identify affected release |
| Random per-install UUID | Rate limiting / spam prevention only (not linked to hardware/accounts and not stored in the sheet) |

- Feedback is sent over HTTPS to a Google Apps Script web app (`feedback-backend/Code.gs`) and appended to a private Google Sheet accessible only to the developer.
- Nothing else is attached: no wallet names, balances, transactions, receipts, backups, or device logs.
- Please never enter PINs, passwords, or private financial details in feedback messages.
- Because the backend runs on Google Apps Script, Google's own privacy policy applies to the HTTPS request (such as IP address handling at Google's infrastructure).

## 6. Update checks

Public releases (`com.diniy.duit.beta`) query `api.github.com` for releases under `erlingdiniy/duit-beta` and download verified APK files from GitHub when you choose **Update Now**. Update requests contain no financial or account data, though GitHub receives standard HTTP request metadata (such as your IP address) under GitHub's privacy statement. Downloaded APKs are verified against both their published SHA-256 digest and signing certificate before Android prompts you to install.

## 7. Developer Broadcasts (Public Edition)

Public releases (`com.diniy.duit.beta`) include Firebase Cloud Messaging (FCM) strictly to deliver optional announcement notifications from the developer (for example, critical beta notices):

- **Topic subscription only:** The app subscribes only to its release-channel topic (`duit_beta_broadcasts` for beta builds; `duit_announcements` for stable builds).
- **Analytics disabled:** Both `firebase_analytics_collection_enabled` and `google_analytics_adid_collection_enabled` are explicitly disabled (`false`) in [`app/src/beta/AndroidManifest.xml`](../app/src/beta/AndroidManifest.xml).
- **Zero financial or token uploads:** duit. never uploads FCM registration tokens, balances, transactions, or receipts to any developer server. Deep links inside broadcast notifications are restricted to an allowlisted internal screen list (`DeveloperBroadcastSpec`) and never open arbitrary URLs.
- **Controls:** Broadcasts appear on the dedicated **Developer Broadcasts** Android notification channel (`VISIBILITY_PRIVATE` on the lock screen) and can be muted or turned off anytime in Android's system notification settings for duit.
- Google Play Services / Firebase handles push delivery under Google's Firebase privacy terms. Offline personal/source builds (`com.diniy.duit`) omit the Firebase SDK completely.

## 8. Supporting the developer

Voluntary donations under **Settings -> Support duit.** are temporarily unavailable. New public releases do not bundle any payment QR code, recipient name, or payment processor. `duit.` stays 100% free and performs no payment tracking.

## 9. Permissions (`com.diniy.duit.beta`)

| Permission | Used for |
| --- | --- |
| `INTERNET`, `ACCESS_NETWORK_STATE` | GitHub update checks, opt-in feedback submission, and FCM broadcasts (omitted in personal/offline builds) |
| `REQUEST_INSTALL_PACKAGES` | Prompting Android's package installer for in-app updates after verification |
| `com.google.android.c2dm.permission.RECEIVE` | Receiving FCM Developer Broadcasts (public edition only) |
| `USE_BIOMETRIC` / `USE_FINGERPRINT` | Optional App Lock fingerprint/biometric unlock |
| `POST_NOTIFICATIONS` | Local money reminders (bills, budgets, savings) and Developer Broadcasts |
| `RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK`, `FOREGROUND_SERVICE` | Re-scheduling local WorkManager reminders after device restart |

Attaching receipts uses Android's system file/photo picker and camera intent without requesting broad gallery or external storage permissions. duit. never accesses your contacts, location, or microphone.

## 10. Deleting your data

- **Delete all financial data:** **Settings -> Data Management -> Delete All Financial Data** wipes local wallets, transactions, budgets, goals, obligations, tax records, challenges, and Receipt Vault files after confirmation (your PIN and UI settings are preserved).
- **Uninstall duit.:** Removes the app database, preferences, keystore material, and private `filesDir/receipts/` folder from your device.
- **External files you saved** (`.duitbackup` archives and CSV exports) remain wherever you stored them until you delete them.
- **Feedback requests:** To request deletion of previously submitted feedback rows, submit a deletion request via **Settings -> Help & Feedback** referencing the approximate date and optional email address used.

## 11. Changes & contact

Updates to this policy are published alongside releases in `erlingdiniy/duit` and `erlingdiniy/duit-beta`.  
For support or privacy requests, please use **Settings -> Help & Feedback** inside the app and avoid posting personal financial data on public GitHub issues.
