# Recovering a backup

Keep a downloaded copy of `paperwarden.html` with your backup records. [Check its checksum](HOSTING.md#check-a-downloaded-copy) before opening it. Use a browser that supports Web Crypto, WebAssembly, Blob workers, and JavaScript. The downloaded app starts on **Decrypt** and can recover backups without an internet connection or account.

1. Scan the printed QR, choose a QR image, or choose **Paste backup** and paste the saved encrypted text, a complete backup link, or the complete written copy. Photo import accepts PNG, JPEG, WebP, BMP, and SVG images, including a saved SVG of the generated QR. For a downloaded text copy, open it in a text editor and copy its complete contents. The app detects the text format. Camera support depends on the browser and local-file permissions; photo import is the fallback.
2. Compare the six-word **Backup ID** with the ID on your paper. It appears after the backup is loaded and before you enter a password, whether you loaded a QR, image, link, saved text, or written copy.
3. Enter a password. Only the matching message is shown. There is no list of other messages and no password reset.
4. Choose Close and clear text when done. You can enter another password for the same loaded backup, or scan, choose a photo, or paste text to load another backup. Loading a new backup clears the previous ID, recovered text, and password before showing the new backup's ID.

## Linked QRs

Every generated QR contains a link to `https://paperwarden.com/`. A compatible phone camera can offer to open that address. The website opens **Decrypt** with the backup loaded and asks for a password. Decryption starts only when you submit it.

The link carries the entire encrypted backup after `#PWN1:`. It has no password or plaintext. This fragment is not sent in the HTTP request, but the page can read it. Only enter a password into a copy of the app you trust. The app attempts to remove the fragment from the address bar; browsers, scanners, history synchronization, or extensions may retain copies. Address cleanup is best-effort, especially with local-file browser restrictions.

If the website is unavailable, open your downloaded `paperwarden.html` and use its scan or photo import, including a saved SVG QR image. Alternatively, copy the complete link from the camera/scanner and choose **Paste backup**. The offline app extracts the encrypted bytes itself without contacting the link's host. This also works with links naming a different supported HTTPS host. Keep the full link and its case unchanged; do not remove punctuation or URL-decode it.

The linked QR preserves all 2,858 encrypted bytes and the full message capacity. **Save encrypted text** exports the ordinary `PWN:…:END` format, which the app continues to accept. The printed full SHA-256 fingerprint and written-copy checksums remain available. These are further recovery paths independent of the website.

The six-word Backup ID appears after generation, on the printout, and when the encrypted backup is loaded for recovery. It identifies the encrypted backup across all its representations. It is public and requires no password to calculate. The words cannot decrypt or reconstruct the backup and are not a wallet recovery phrase. A matching ID is a short comparison aid; the full SHA-256 fingerprint gives the complete checksum.

If the QR is damaged, transcribe the complete archival copy, including its heading, SHA256 fingerprint, all 115 numbered lines, and line checksums. Choose **Paste backup**, then **Load backup**. It is another representation of the same encrypted envelope; it contains no passwords or plaintext messages. The app reports copying errors before attempting decryption.

Print at 100% on A4 or US Letter, keeping the full white border around the QR. Check the actual paper with the intended phone/browser before storing it. A successful digital round trip does not test printer ink, paper, lighting, or camera focus.

**Download offline app** saves the application without your entered messages or passwords. Save or print the encrypted backup separately. Verify the app using the checksum for the same version, as described in [Check a downloaded copy](HOSTING.md#check-a-downloaded-copy).

For a long-lived archive, retain the format specification and public test vector too. They explain the data if the original application needs to be reimplemented. Do not use the public test-vector passwords for private information.
