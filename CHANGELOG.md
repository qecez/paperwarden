# Changelog

Reader releases, newest first. Each entry links to an exact HTML build.

## [Initial release](https://github.com/qecez/paperwarden/releases/tag/sha256-bb9619711fbd53ef7ae8ead1a723ddac8d7697b8c6b36f79251bf67007d89402)

- A self-contained HTML app creates and recovers encrypted backups offline.
- Create a backup with one or two independently password-protected messages in 2,858 bytes, using shared circular space.
- Save a fixed-layout A4 or US Letter PDF containing a QR code, checksummed text copy, and self-contained recovery reference. Recover by scanning, importing a QR image, or pasting a backup link or text copy.
- Reproducible builds, immutable GitHub releases, signed provenance, and full SHA-256 identities connect each downloadable reader to its source. Isolated deployment and mirror jobs verify the published files before using their credentials.

### Security and recovery

The design and implementation have not had an independent security audit. Message concealment has limits; opening one message does not authenticate the rest of the backup. Use strong, independent passwords, keep a verified offline app, and test every message from the actual print before storing it.
