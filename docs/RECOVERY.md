# Recovering a backup

You need the encrypted backup, its password, and a trusted reader. Save and test the app before you need it; recovery must not depend on the website remaining available.

## Open a message

1. [Check the downloaded app's checksum](HOSTING.md#check-an-offline-download) before opening it. Obtain the expected value from a source you trust.
2. Open the file and choose **Decrypt**. Use **Scan QR code** or **Choose QR image**, or paste a complete backup link or text copy into **Text copy or QR-generated link**. Pasted text is checked automatically.
3. Compare the four-word label (the Backup ID) with your paper. It helps identify the backup; it is not a password or proof of authenticity.
4. Enter the message's password and choose **Decrypt backup**. Each password opens its matching message. There is no message list or password reset.
5. After recovery, **Clear text** returns to password entry for the same backup. **Load another backup** clears the current backup, ID, password, and recovered text, then returns to import.

If you loaded the wrong backup before decrypting, reload the app to start over.

Image import accepts PNG, JPEG, WebP, BMP, and SVG. Open a saved text copy in a text editor and paste its complete contents. The app requires JavaScript, Web Crypto, WebAssembly, and Blob workers. Camera access from a local file depends on browser permissions; if unavailable, import an image or paste the text.

## Phone cameras and links

A phone camera may open `paperwarden.com` from the QR. This uses the website's reader; enter a password only into code you trust. For recovery without the website, import the QR image or complete link into your saved app. It extracts the backup locally without contacting the link's host.

If the camera offers Search, do not use it: that sends the encrypted backup to the search provider.

The encrypted bytes follow `#PWN1:`; the link contains no password or plaintext. Browsers omit the fragment from the page request, but the loaded page can read it. Address-bar cleanup cannot erase scanner logs, synchronized history, extensions, or other retained copies.

## Comparing copies

The same encrypted bytes produce the same Backup ID across import methods. The displayed four words abbreviate the canonical identifier, retaining 42 SHA-256 bits; they cannot reconstruct or decrypt the backup. Use the full printed SHA-256 when exact equality matters, comparing against an original or checksum you already trust. Someone replacing a backup can also replace its printed ID and checksum.

Opening one message authenticates only that message, not the whole backup. Test every password when checking a stored copy.

## Damaged QR

Use the text copy. Paste the block from `-----BEGIN PAPERWARDEN BACKUP-----` through `-----END PAPERWARDEN BACKUP-----`, including both markers, the format heading, SHA256 fingerprint, all 115 numbered lines, and their line checksums. The app checks the block automatically before asking for your password.

**Save as text** downloads this same block as `word1-word2-word3-word4.txt`, using its four-word Backup ID. It preserves all 2,858 encrypted bytes and contains no plaintext or passwords.

## Recovery without the original app

The final printed page contains a self-contained PWN-1 recovery reference: byte ranges, encodings, key derivation, the complete search over circular header starts, authentication inputs, and rejection rules. A developer can implement it using established cryptographic libraries without the website or app source. An offline coding assistant can help, but its output needs validation against the [public encryption vector](../tests/fixtures/reference.json) and [link vector](../tests/fixtures/link-reference.json).

Keep secrets local, reject failed authentication, and never guess missing bytes. The reference is not part of the block to paste and cannot replace a lost password. Preserve the [frozen specification](FORMAT.md) and public vectors alongside the verified reader.

### Public known-answer check

The [public encryption vector](../tests/fixtures/reference.json) contains a complete backup in its `hex` field. Decode it to 2,858 bytes; its SHA-256 is `56c53c82f34e207e104705b38a03cf27335f07189712466079835b49e45061ca`. The password `another separate test password` must recover exactly `A separate message.\n保持`, where `\n` is one line feed. The same file records all expected keys, start positions, lengths, and messages. These are public test credentials; never use them for secrets.

## Before storing a backup

Choose **A4** or **US Letter**, then **Save PDF**. The app creates a four-page PDF locally, with a 150 mm QR including its white border, two pages of text archive, and a technical recovery reference. Keep all four pages. Print the PDF at 100% on the matching paper size with the full QR border. Use the saved app to recover every message from a photo or scan of the actual print. The PDF fixes page layout; the PDF viewer and printer can still rescale or crop it. Digital tests do not check ink, lighting, focus, paper damage, or aging.

The app download contains only the application. Keep encrypted backups separately from their passwords, and spare paper/app copies in different places. Generated passwords are not automatically saved.

For family access, use the printout's non-sensitive notes area to handwrite what the paper is and where to find the app. Do not write passwords or other secrets there. Tell your family how many messages exist and who has each password. Do not assume they know Paperwarden or that the website will survive.
