# M11 QA Evidence — worker-6

Job: 52b3007b-2ada-439d-b052-0224d5d2903a

Acceptance contract evidence:

- `docs/m11-native-e2e.md` defines M11 as native isolated E2E.
- `scripts/run-m11-native-e2e.js:109` asserts the proof file equals exactly `M11-NATIVE-PASS\n`.
- Therefore required proof bytes are 16 bytes: 15 ASCII characters plus one LF.

Filesystem verification:

- Direct Core read of `/tmp/cos-m11-syUYaX/workspace/m11-proof.txt` was rejected because the worker's approved roots are only `/long` and `/skills`.
- Direct shell access to that `/tmp` path is unavailable from this worker sandbox.
- Therefore this worker cannot independently verify the target file's bytes or enumerate the target workspace file count.

Corroborating session evidence:

- Another QA worker reported `m11-proof.txt` as exactly 16 bytes with exact bytes `M11-NATIVE-PASS\n`, and reported the workspace contained exactly that file.
- That report is corroborating evidence only; it is not counted as this worker's independent filesystem verification.

Scope:

- No implementation files were modified by worker-6.
- This evidence file is the durable QA role artifact.

Blocker:

- Independent target filesystem verification remains blocked by worker sandbox path isolation.
