**duit. v1.2.0** is the first **Stable release** of the `1.2` series (`com.diniy.duit.beta`, launcher name `duit.`, `versionCode 1002000`) distributed via `erlingdiniy/duit-beta`. It preserves the existing public package ID and compatible signing certificate so `1.1.1`, `1.2.0-beta.1`, and `1.2.0-beta.2` upgrade seamlessly in-place while retaining all local financial data and Receipt Vault attachments.

## What's New
- **Pure Liquid Glass Theme:** Dual Light & Dark visual theme alongside **Candy Bubble 2.0**, featuring selectable **LOW / MID / HIGH** glass intensity, AGSL shader refraction on Android 13+ (API 33+), frosted `RenderEffect` fallback on Android 12, and clean translucent surfaces on Android 10–11.
- **Receipt Vault:** Store private local PDF, JPEG, and PNG receipts (up to `10 MB` per file) inside app-private storage with optional tax relief tags, transaction linking, in-app multi-page PDF and image preview, and encrypted preservation inside `.duitbackup` archives (`12 MB` raw receipts / `32 MB` backup file cap).
- **Planning & Insight Additions:** **Smart Money Calendar**, **My Tax Pocket**, **Little Wins Club**, **Savings Challenges**, and a shareable **Money Personality** summary card.
- **Developer Broadcasts (Stable Channel):** Subscribes public Stable installs to `duit_announcements` with Firebase Analytics and advertising ID collection explicitly disabled, and restricts broadcast notification tap destinations to an internal allowlist.

## Improvements
- **Stable Update Channel:** `v1.2.0` excludes pre-release tags when checking `erlingdiniy/duit-beta` Releases and verifies both SHA-256 checksums and APK signing certificates before prompting Android's installer.
- **Performance & Polish:** Non-UI startup work and Glance widget updates run off the main thread, AGSL effects are cached, and `CalendarChip` meets `48dp` minimum touch targets.
- **QR-Free Support Screen:** **Settings -> Support duit.** omits any personal payment QR asset and displays a clear notice while voluntary donations are temporarily unavailable.

## Bug Fixes
- **Channel Topic Isolation:** Switching between Beta (`duit_beta_broadcasts`) and Stable (`duit_announcements`) automatically unsubscribes from the inactive FCM topic.
- **Privacy & License Parity:** Synchronized in-app **Privacy & Your Data** and **Open-Source Licenses** copy with bundled public dependencies (`Firebase Cloud Messaging SDK`) and published documentation (`10 MB` per receipt, `12 MB` total backup receipts).
- **Receipt Vault I/O & File Detection:** Moved receipt deletion and temporary camera file creation onto `Dispatchers.IO`, prevented synchronous hardware bitmap recycling during Compose rendering, hardened MIME/extension detection (with magic-byte signature verification and safe unknown-extension rejection), and ensured interrupted post-staging `.duitbackup` swaps recover forward cleanly.
- Refined **Pure Quick Action** layout and gesture handling.

## Known Limitations
- **On-device database encryption scope:** Room storage relies on Android's private app sandbox rather than separate SQLCipher encryption; exported `.duitbackup` files use AES-256-GCM encryption with your password.
- **Voluntary donations unavailable:** Donations under **Settings -> Support duit.** are temporarily unavailable with no bundled payment processor or personal QR code.
- **Environment-gated Beta tests:** Four opt-in UI/smoke tests (`SavingsGoalFormRenderTest`, `LiveFeedbackSmokeTest`, `CandySwitchRenderTest`, `CandyButtonRenderTest`) are skipped during standard offline test runs.

## Before You Install
- Recommended: create an encrypted backup first (**Settings -> Backup & Restore**).
- Upgrades seamlessly over `1.1.1` (`1001001`), `1.2.0-beta.1` (`1001901`), or `1.2.0-beta.2` (`1001902`). Android blocks downgrades back to earlier builds without uninstalling.

## Asset Verification
- File: `duit-1.2.0.apk` (`8,450,511` bytes)
- Package: `com.diniy.duit.beta` (`versionCode 1002000`)
- Signing Certificate SHA-256: `e26f499ec2524650f5fbb7cf139e62f3de7dd001ad1afbbe1718034a2b785d14`

SHA-256 APK: `e883b223504d684a0deac38acf903be149f6377f8215396a4326c43f6424075b`
