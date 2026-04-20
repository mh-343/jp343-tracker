# Changelog

Single source of truth for release notes. Each release is one file: `vX.Y.Z.md`.

Used by:
- `/release-notes` skill — generates new entries
- `/wrap-up` Phase 4 — writes entries on version bumps
- `/store` skill — reads entries to produce Chrome/Firefox "What's New" text
- Future: jp343.com/changelog page pulls these files as the canonical timeline

## Schema

Frontmatter fields (all required unless marked optional):

| Field | Type | Values |
|-------|------|--------|
| `version` | string | `2.4.6` (no `v` prefix) |
| `type` | string | `major` \| `minor` \| `patch` |
| `date` | string | ISO date `YYYY-MM-DD` |
| `title` | string | 2-5 words, substantival, release identity |
| `summary` | string | one sentence, max 25 words, two main points |
| `platforms` | list | any of: `youtube`, `netflix`, `crunchyroll`, `primevideo`, `disneyplus`, `ci-japanese`, `spotify`. Empty `[]` if change is platform-agnostic |
| `hero` | string (optional) | path to hero image, only for `major` releases |

## Body Sections

Only these three headings exist. Omit the ones with no items.

```
## Features
## Fixes
## Improvements
```

No other sections. No "Misc", no "Miscellaneous", no "Bug Fixes". Drift is banned.

## Bullet Format

```
- **Label**: Description.
```

- **Label** is a noun or noun phrase (not a verb): `**CI Japanese tracking**` not `**Fixed tracking**`
- Description is one sentence in user-facing language
- No function names, no "race condition", no "null check", no "refactor"
- No "Fix N", no "Iteration N", no internal jargon
- **No unverified numbers.** Do not write "40% faster", "2x performance", "saves 30 seconds" unless the value was actually measured against a baseline. If unsure, describe the direction instead: "faster", "sooner", "more reliable", "no longer stutters"

## Title Rules

- 2-5 words, substantival
- Gives the release a memorable identity
- Good: `Manual Timer Fix`, `YouTube Japanese Filter`, `Diagnostics & CI Fix`
- Bad: `v2.4.6 release notes`, `Bug fixes and improvements`, `Update`

## Type Decision

- `patch` — bug fixes only, no user-visible new functionality
- `minor` — new feature(s), or significant non-breaking additions
- `major` — large change in scope, new platform support, architectural shift

## Platforms Field

Only list platforms **directly affected** by the user-visible change.
- Background/storage/auth changes: `[]`
- Fix specific to Netflix detection: `[netflix]`
- New feature works across all video platforms: list all

## Example

See `v2.4.5.md` in this folder.
