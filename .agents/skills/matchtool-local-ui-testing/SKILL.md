---
name: matchtool-local-ui-testing
description: Run isolated local MatchTool UI tests with compatible FFmpeg and explicit Gemini coverage boundaries.
---

# Local UI testing

- Run from the repository root with Node and pnpm available on PATH.
- Use an isolated `DATA_DIR` to avoid modifying existing scans or account data.
- Start `pnpm dev` on port 3000. `FFMPEG_ENGINES=2` is sufficient for tiny fixtures.
- Check the actual FFmpeg version before testing uploads. `lib/ffmpeg-bin.ts`
  prefers `/usr/bin/ffmpeg` over the bundled fallback; old system versions may
  reject `-fps_mode`. Set `FFMPEG_PATH` to the absolute
  `node_modules/ffmpeg-static/ffmpeg` path when that bundled binary is compatible.
  Restart the server after changing binary configuration (resolution is cached).
- Authentication has no public signup. Prefer an existing test account. For
  disposable offline data, seed `DATA_DIR/auth/users.json` with a normal user
  (`username`, bcrypt `passwordHash`, `createdAt`) and
  `DATA_DIR/auth/tokens.json` with a positive balance (100 tokens per scan).
  Never overwrite shared user records or guess the hardcoded admin password.
- Log in through the browser. Set Auto OFF before uploading for manual tests.
  Uploading the short creates a scan. In its Auto Pipeline panel choose
  Minute finder Off before uploading the movie. Use Skip — Full Movie to
  exercise real local FFmpeg preparation without starting AI work.
- A tiny synthetic MP4 can verify uploads and chunk preparation; it does not
  establish AI matching quality, verifier behavior, or concurrency correctness.
- Confirm ready status, chunk count, and generated media on disk only as
  corroboration of UI observations. Start without a key should show the
  account-specific missing-key error without consuming tokens.

## Devin Secrets Needed

- `GEMINI_API_KEY` (suggested secret name): usable Gemini API key with access to
  configured models. The UI start route reads per-user keys saved via Settings,
  so an environment variable alone is not enough for that route.
- Credentials for an existing test account when isolated data seeding is not
  appropriate.

## Live recovery testing boundary

Three scans must genuinely be running with overlapping key/model pools.
Use an approved deterministic provider-level 429 injection method or controlled
quota setup, and capture request start/finish timestamps by key hash, model,
scan and phase. Verify exclusivity after cooldown and staggered handoffs for
mapping, verification and rescans. No-credential UI checks and mocked coordinator
tests are not substitutes for this end-to-end evidence.
