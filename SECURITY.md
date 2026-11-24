# Security Policy

## Supported versions

Only the latest released version of Multi Exporter receives fixes. Please update to the newest release before reporting an issue.

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue:

- Use GitHub's **"Report a vulnerability"** button (Security tab → Privately report a vulnerability): <https://github.com/jsglazer/multi-exporter/security/advisories/new>
- or open a regular issue **without** sensitive details and ask for a private channel.

Please include reproduction steps and the version you are running (see `manifest.json`). We aim to acknowledge reports within 14 days and to release a fix in a subsequent version.

## Scope

Multi Exporter is an Obsidian plugin. It runs inside Obsidian with the access Obsidian grants community plugins, and works on your vault through Obsidian's plugin API. Report anything that could expose, corrupt or exfiltrate vault content, or execute untrusted content from a note.
