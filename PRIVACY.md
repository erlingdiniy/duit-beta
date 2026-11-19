# duit. Privacy Policy

**Effective date:** 19 November 2026
**Applies to:** the public duit. Android app (`com.diniy.duit.beta`), version 1.1.0 and later, distributed through GitHub Releases.

duit. is a personal finance app made by an independent developer (GitHub: **erlingdiniy**). This policy explains what the app stores, what it sends, and the choices you have. It describes how the app actually works today; where something is outside the app's control, we say so.

## 1. Summary

- Your financial records are stored on your phone. There is no account and no cloud sync.
- duit. goes online for two things only: checking GitHub for app updates, and sending feedback **you choose** to submit.
- Your balances, transactions, budgets, goals and backups are never sent to the developer.
- The app contains no advertising and no analytics or tracking SDKs.

## 2. Data stored on your device

duit. stores your wallets, transactions, budgets, savings goals, bills, PayLater plans, debts, optional commission records and app settings in the app's private storage on your phone (an Android database and preference files).

- **Not encrypted by duit. itself.** This on-device database is not separately encrypted by the app. On a standard (non-rooted) phone, Android keeps each app's private storage inaccessible to other apps.
- **Android cloud backup is turned off.** duit. opts out of Android's automatic cloud backup and device-to-device transfer, so your records are not copied to Google Drive that way.
- **Widgets and notifications** can show amounts on your home screen and lock screen. You can hide them with Privacy Mode, App Lock, or the "hide amounts" notification setting.

## 3. Security features

- **App Lock (PIN and fingerprint).** You can set a 6-digit PIN and optionally use your phone's fingerprint unlock. Your PIN is never stored as plain text: duit. keeps only a salted, derived value (PBKDF2), protected with a key held in the Android Keystore. Repeated wrong PINs cause a short wait.
- While App Lock is on, duit. blocks screenshots and hides its screen in the recent-apps view, and hides amounts in widgets and notifications.
- **Privacy Mode** hides amounts on screen.

These features reduce casual access to your data. They are not a guarantee against every threat, for example a compromised or rooted device.

## 4. Backups and exports

- **Backups** are files you create in Settings → Backup & Restore and save to a location you choose with Android's file picker. Each backup is encrypted with **AES-256-GCM** using a key derived from a password you set. The developer never receives your backups or passwords, and **a forgotten backup password cannot be recovered**.
- **Restore** checks the password and the file before changing anything. If restoring fails, your existing data is left as it was. Restoring does not change your PIN.
- **CSV exports** are plain, unencrypted spreadsheets. Anyone who can open the file can read it.
- Where you store backup and export files (for example, a cloud drive) is your choice, and that service's own terms apply.

## 5. Feedback you send

If you use **Settings → Help & Feedback**, duit. sends only:

| Data | Why |
| --- | --- |
| Category (Bug Report, Feature Request or General Feedback) | To sort feedback |
| Your message (10–2,000 characters) | The feedback itself |
| Your email address, **only if you enter one** | So the developer can reply |
| The app version | To understand which version is affected |
| A random installation ID created by duit. | To limit spam; it is not linked to your device hardware or accounts |

- Feedback is sent over HTTPS to a **Google Apps Script** web app run by the developer and stored in a **private Google Sheet** that only the developer can access. The date and time are added by the server.
- The installation ID is not saved with your message. A scrambled (hashed) form of it, and of the message text, is held briefly (up to about one hour) to block floods and duplicate messages.
- Nothing else is attached: no balances, transactions, backups, device logs or contacts.
- Please don't include PINs, passwords or financial details in your message.
- Because feedback is processed by Google, **Google's own privacy policy and terms also apply**, and Google may process technical data (such as your IP address) as part of providing the service.

## 6. Update checks

duit. checks `api.github.com` for new releases of the app and downloads updates from GitHub when you choose to install them. These requests contain no personal or financial information, but like visiting any website, **GitHub can see your phone's IP address** and basic request details. GitHub's privacy statement applies. Every download is checked (checksum and signing certificate) before Android asks you to confirm the install.

## 7. Supporting the developer

Settings → Support duit. shows the developer's DuitNow QR code (Touch 'n Go eWallet). Supporting duit. is entirely optional and unlocks nothing.

- Any payment happens **in your own banking or eWallet app**, under that provider's terms. duit. never sees, processes or records payments, and does not know whether you paid.
- When you pay, your provider will show you the recipient's name, and the developer may see your name or account details as your provider normally shares them with a recipient.
- "Save QR" saves a copy of the QR image to your phone's Pictures/duit. folder.

## 8. Permissions

| Permission | Used for |
| --- | --- |
| Internet, network state | Update checks and sending feedback you choose to submit |
| Install packages | Installing app updates, only after you confirm in Android's installer |
| Biometric | Optional fingerprint unlock |
| Notifications | Optional reminders for bills, budgets and savings |
| Run at startup, wake lock, foreground service | Rescheduling reminders after a restart (used by Android's WorkManager) |

duit. does not request access to your contacts, location, camera, microphone or files. Saving the QR image does not need a storage permission.

## 9. Your choices and deleting your data

- **Delete all financial data:** Settings → Data Management → Delete All Financial Data. This removes your records from the phone after you confirm, and cannot be undone. Your PIN and app settings are kept.
- **Uninstall duit.:** removes everything the app stored in its private storage on your phone.
- **Files you saved yourself** (backups, CSV exports, the saved QR image) stay until you delete them.
- **Feedback already sent is not deleted** when you delete local data or uninstall the app. To ask for your feedback to be deleted, send a request through **Settings → Help & Feedback** (category: General Feedback). Include enough detail to find it (for example the date you sent it and the email you used). The developer will delete matching entries from the feedback sheet.
- Data held by third parties (Google, GitHub, your payment provider) is kept under their own policies and is outside the app's direct control.

## 10. Children

duit. is a general personal finance app and is not designed for children. It does not knowingly collect personal information from children.

## 11. Changes to this policy

When this policy changes, the updated version will be published in the duit. GitHub repository with a new effective date, and noted in the release notes.

## 12. Contact

The only contact channel is **Settings → Help & Feedback** in the app. Please do not post personal or financial information in public GitHub issues.
