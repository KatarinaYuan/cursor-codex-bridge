---
name: install-cursor-codex-bridge
description: Install, diagnose, upgrade, or uninstall Cursor Codex Bridge over an existing SSH alias so Codex desktop chats use a remote Cursor Agent.
---

# Install Cursor Codex Bridge

Use the project's CLI to manage the bridge from the laptop. This is an experimental protocol bridge, not an official Codex or Cursor integration. It requires an existing working SSH alias and a Linux glibc x64/arm64 host with Python 3.8+, bash, and Cursor Agent already logged in. The installer reuses remote Node.js 22+ and genuine Codex CLI or downloads pinned, checksum-verified private runtimes when absent; it does not use sudo or install global npm packages. The laptop needs Node.js 22+ with npm, Git, OpenSSH, tar, and Codex desktop.

## Workflow

1. Reuse the user's specified checkout and SSH alias. If the alias is missing, inspect available SSH host names without exposing identities or credentials, and ask the user to choose when necessary. Do not guess a host from unrelated context.
2. Check laptop Node.js 22+ and npm. If unavailable, discover the native Codex `load_workspace_dependencies` tool and use its bundled Node/npm when provided. Add that runtime directory to `PATH` only for the current command; do not modify shell profiles. If neither a suitable system runtime nor a bundled Node/npm is available, report the specific prerequisite and ask the user to install Node.js 22+ with npm. Do not claim the bridge is dependency-free on arbitrary laptops.
3. Prefer the pinned GitHub Release package below when no checkout was requested. Use the same `npx` prefix for `install`, then `doctor`, replacing `ALIAS` with the user's SSH alias. Alternatively, clone `https://github.com/KatarinaYuan/cursor-codex-bridge.git`, check out `v0.1.4`, run `npm ci --ignore-scripts`, then use `node cli.mjs`. Read the README and CLI `--help` for version-specific options. Reuse an existing checkout only when its origin matches this project; do not discard local edits.
4. Add `--alias BRIDGE_ALIAS` only when the user specified a bridge name or a collision needs resolving; pass that same option to every later management command. Remote binary overrides (`--node-path`, `--agent-path`, `--codex-path`) must be remote absolute paths.
5. Report the actual diagnostic result and generated bridge alias. Direct the user to enable that alias in Codex App SSH settings if the CLI requires it. Do not claim an end-to-end chat works solely because installation passed.

```sh
npx --yes --package=https://github.com/KatarinaYuan/cursor-codex-bridge/releases/download/v0.1.4/cursor-codex-bridge-0.1.4.tgz cursor-codex install --ssh ALIAS
npx --yes --package=https://github.com/KatarinaYuan/cursor-codex-bridge/releases/download/v0.1.4/cursor-codex-bridge-0.1.4.tgz cursor-codex doctor --ssh ALIAS
```

An explicit installation request authorizes the installer changes described by the CLI; do not add another approval step for those routine changes. It tests `CODEX_HOME` forwarding, then `LC_CURSOR_CODEX_BRIDGE`; a server rejecting both may need the user's administrator. Report that concrete blocker instead of changing the server's SSH policy.

## Other operations

- Diagnose: use the same `npx` prefix with `cursor-codex doctor --ssh ALIAS` (`--json` for structured results), or `node cli.mjs doctor` in a checkout. This is read-only and does not send model messages.
- Upgrade: use the pinned `v0.1.4` commands below, or its clean checkout with `node cli.mjs`. This release includes the Recents section-filter fix. The command deploys the calling version; it does not fetch the latest release itself. Reuse any custom `--alias BRIDGE_ALIAS` from the existing installation for both commands. Preserve local edits and existing user settings. If the App still shows a cached chat list after a successful upgrade and diagnostic, disconnect and reconnect the bridge in App SSH settings; do not restart the original Cursor Agent.
- Update the laptop skill: run `cursor-codex install-skill` using the pinned release package. Matching content is unchanged. Unmodified official `v0.1.1`, `v0.1.2`, or `v0.1.3` skills are recognized by both shipped file hashes, backed up, and atomically replaced; report the returned backup path. Custom content, extra files, or symlinks are rejected and preserved. Do not delete the old skill to bypass that check. `upgrade` alone does not update the laptop skill.
- Uninstall: run `cursor-codex uninstall --ssh ALIAS` with the same `npx` prefix, or `node cli.mjs uninstall` in a checkout. Preserve the retained bridge records, original Cursor history, and shared private runtimes. Deleting those data requires a separate explicit request. Existing manual bridge deployments are not adopted or migrated by this installer.

```sh
npx --yes --package=https://github.com/KatarinaYuan/cursor-codex-bridge/releases/download/v0.1.4/cursor-codex-bridge-0.1.4.tgz cursor-codex upgrade --ssh ALIAS
npx --yes --package=https://github.com/KatarinaYuan/cursor-codex-bridge/releases/download/v0.1.4/cursor-codex-bridge-0.1.4.tgz cursor-codex doctor --ssh ALIAS
npx --yes --package=https://github.com/KatarinaYuan/cursor-codex-bridge/releases/download/v0.1.4/cursor-codex-bridge-0.1.4.tgz cursor-codex install-skill
```

Use the installer for owned SSH/profile blocks and remote files. Do not duplicate its work by manually appending shell snippets, replacing global Codex binaries, modifying `sshd_config`, or installing global hooks. Do not bundle or copy accounts and credentials.

Do not send test messages to existing chats or tmux sessions. Do not clear drafts or press Enter to resolve a failed paste. When busy or when input cannot be verified, stop the dependent mutation and report the CLI's concrete reason; inspect read-only diagnostics and `docs/troubleshooting.md`. A new isolated model test requires the user's authorization because it creates messages and may incur cost.

For a failed command, diagnose the actual output; do not loop installation or restart user Agent processes. Keep logs and issue reports free of chat contents, private keys, tokens, and personal host details.
