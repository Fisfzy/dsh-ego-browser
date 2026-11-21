# Security Policy

## Supported versions

Security fixes target the latest published minor release (`0.15.x` at the time of writing). Older releases may receive a fix only when the issue is trivial to backport; please reproduce on the latest npm/GitHub release before reporting.

## Reporting a vulnerability

Please **do not open a public issue** for a suspected vulnerability.

Use GitHub's private vulnerability reporting for this repository:

- Security tab → Advisories → **Report a vulnerability**
- Direct link: <https://github.com/omdsh-dev/dsh-ego-browser/security/advisories/new>

Include:

- affected version and install source (npm / GitHub / local checkout)
- deployment shape (DSH Desktop / web GUI / headless / reverse proxy)
- a minimal reproduction and whether authentication was involved
- impact assessment and any suggested fix

We will acknowledge the report, confirm scope, prepare a fix on a private branch, and coordinate disclosure. Please give us a reasonable window to ship a patched release before public disclosure.

## Scope reminders

The plugin runs with the DSH host's privileges and can launch a managed browser, FFmpeg, and local processes. Reports about unauthenticated access to plugin routes, unsafe settings writes, command execution, credential leakage, or cross-site request behavior are especially relevant.

## Security posture

- Host HTTP routes under `/api/ego/*` require the DSH-issued auth cookie.
- The settings gateway `/ego/api/*` requires the same auth cookie.
- Executable/launch settings (`chromePath`, `ffmpegPath`, `chromeArgs`, `egoCliArgs`) are local-configuration-only and are not writable over HTTP.
- The agent browser uses a dedicated profile; cookie import is explicit and never logs cookie values.
