### 2026-08-02 07:50 — Codex — preserve S21 five-minute timeout

**Plan:** Replace only the benchmark-phone timeout writer with five minutes, then prove it survives the next periodic run.
**Done:**
- Attributed repeated `screen_off_timeout=15000` writes to server-100's `scripts/configure-android-benchmark-device.sh`; server-44 has no attached S21 or matching writer.
**Blocked:** none
**Next:** Add a focused source contract, change the writer, validate, deploy only the script, then recheck the live phone after one five-minute interval.

### 2026-08-02 07:54 — Codex — timeout writer corrected

**Plan:** Validate the red-to-green source fix and retain a live five-minute timeout.
**Done:**
- Added a contract rejecting `screen_off_timeout 15000` and requiring `300000`.
- Changed only the benchmark writer; the focused Python contract passes.
- Restored the current phone setting to `300000`.
**Blocked:** Need the next periodic writer window to prove the unknown caller reloads the edited source.
**Next:** Recheck the setting/history after the writer window; do not alter server-44.
