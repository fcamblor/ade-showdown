---
name: review-orchestrator-version
description: Interactive review of every feature row for one orchestrator+version in the ADE Showdown dataset. Lets the user pick a version (latest by default, with a drill-down into older ones), then walks feature by feature — showing the currently persisted support state, dispatching a fresh research agent to challenge it, and asking the user to confirm/override with sources or screenshots. Persists every accepted change (including screenshot assets) and ends with a `/commit`. Triggers: "review a version", "review feature matrix", "challenge orchestrator data", "audit <tool>@<version>", "fact-check the showdown".
---

# Skill — `review-orchestrator-version`

Goal: catch stale or incorrect feature rows by going through them **one at a time** with the user, backed by a fresh research pass. The skill is strictly **interactive** — never silently overwrite data; every change is validated by the user.

The skill edits `src/data/orchestrators/<toolId>/_latest-known-features.ts` (which the target version file consumes via `LATEST_KNOWN_FEATURES`) and stores screenshot assets under `public/screenshots/<toolId>/` — **shared across every version of that orchestrator**, since most screenshots remain valid across versions.

For ergonomic editing, the skill also ensures a symlink exists at `src/data/orchestrators/<toolId>/screenshots` → `../../../../public/screenshots/<toolId>` so assets show up next to the data file in the IDE. Astro keeps serving them exclusively from `public/`.

---

## Optional arguments

The skill accepts two optional arguments (whitespace-separated, any order):

- `<toolId>@<version>` — pre-selects the orchestrator + version and **skips Step 1 entirely**. Example: `cursor@3.4.17`. The target file `src/data/orchestrators/<toolId>/<version>.ts` must already exist; otherwise the skill aborts with an error pointing the user at `add-orchestrator-version`.
- `--only-unreviewed` (or `scope=unreviewed` in args) — restricts the per-feature loop to entries whose `support` is `unknown` or whose `featureId` is missing from `_latest-known-features.ts`. Default: walk every feature.

Both arguments are independent and can be combined. `add-orchestrator-version` invokes this skill with both set after bootstrapping a new orchestrator.

---

## Step 1 — Pick the orchestrator and version

**Skip this entire step** when a `<toolId>@<version>` argument was provided. Just record `toolId` / `version`, resolve `toolName` from `_meta.ts`, and continue with Step 2.

Otherwise, use `mcp__conductor__AskUserQuestion` (the conductor `AskUserQuestion` tool) for every selection. Never open a free-form prompt when a closed set fits.

### 1a. Pick the orchestrator

List every directory under `src/data/orchestrators/` (the `toolId` set). Read each `_meta.ts` to grab `toolName` for nicer labels. Present them as a single-select question.

### 1b. Pick the version

For the chosen `toolId`:

- List every `*.ts` file under `src/data/orchestrators/<toolId>/` **excluding** files starting with `_` (so skip `_meta.ts`, `_latest-known-features.ts`).
- Each remaining file's basename is a version string.
- For each version, read its file to extract `version`, `releaseDate`, and `status` (defaults to `approved` when missing).
- **Sort by `releaseDate` descending**, then by version string descending.

Show the user **the 3 most recent versions** in a single-select `AskUserQuestion`, each option formatted as `"<version> — <releaseDate> — <status>"`. Add one extra option literally labeled **"Show older versions…"**.

- If the user picks a version → continue with Step 2.
- If the user picks "Show older versions…" → re-issue an `AskUserQuestion` listing every remaining (older) version, single-select, same formatting. The selection from that second question is the target.

If only one version exists, skip the question and confirm with the user before proceeding.

Once chosen, remember:

- `toolId`, `toolName`
- `version` (exact string, file basename)
- Path: `src/data/orchestrators/<toolId>/<version>.ts`
- Features file: `src/data/orchestrators/<toolId>/_latest-known-features.ts`
- `trackingSources` from `_meta.ts` (Step 3 uses them)

---

## Step 2 — Load context once

Read into memory:

1. `src/data/features.ts` — the canonical `FEATURES` list (order matters for persistence).
2. `src/data/schema.ts` — `FeatureSupportSchema` + `ScreenshotSchema` contract (recap below).
3. The orchestrator's `_meta.ts` (for `trackingSources`).
4. The orchestrator's `_latest-known-features.ts` (the array being reviewed).
5. The target version file (so the final report can mention flipping `status: 'waiting-for-review' → 'approved'`).

`FeatureSupport` schema recap (must hold after every edit):

```ts
{
  featureId: string,
  support: 'yes' | 'partial' | 'no' | 'unknown',
  note?: string,                 // max 280 chars
  screenshots: Screenshot[],     // default []
  sourceUrl?: string,            // URL
  sourceExtract?: string,        // verbatim quote
}
// Screenshot = { src: string, alt: string, caption?: string }
```

Rule of thumb (matches the rest of the dataset): when `support` is `yes` or `partial`, **require** a `sourceUrl` + `sourceExtract`. When `support` is `no`, a `note` explaining *why not* is strongly recommended.

---

## Step 3 — Per-feature review loop

Iterate **in the order of `FEATURES`** in `src/data/features.ts`. When `--only-unreviewed` was passed, skip any feature whose current entry exists with `support ∈ {'yes', 'partial', 'no'}` — only walk the ones at `support: 'unknown'` or missing entirely. For each feature **kept** by the filter:

### 3a. Show the current persisted state

Look up the current entry in `_latest-known-features.ts` (it may be missing — treat as `support: 'unknown'`). Render a tight summary message to the user, e.g.:

```
[12/27] Feature: live-logs — "Live agent logs" (category: observability)
  Short: Stream tool output as agents work.

  Currently persisted:
    support      : yes
    note         : —
    sourceUrl    : https://cursor.com/docs/agent/agents-window
    sourceExtract: "Watch your agents work in real-time as they execute tools…"
    screenshots  : 0
```

Always include the feature index `[i/total]` so the user knows progress.

### 3b. Fresh research — challenge the current state

Dispatch **one** `general-purpose` agent (single `Agent` tool call) and **wait for it** before continuing. Inputs:

- Feature: `id`, `label`, `shortDescription`, `longDescription` (if any).
- Orchestrator: `toolId`, `toolName`, `version`, `releaseDate`.
- The `trackingSources` URLs (verbatim, with their `kind` + `label`).
- The **currently persisted** `FeatureSupport` entry (verbatim).
- Explicit task: *"Challenge the persisted entry. Re-investigate the listed sources. If you confirm the current entry, say so and quote fresh evidence. If you disagree, propose a corrected `FeatureSupport` object (matching the schema) with `sourceUrl` + `sourceExtract`. If evidence is missing or ambiguous, return `support: 'unknown'` — do **not** guess."*
- Output contract: a small JSON object with `verdict: 'confirm' | 'revise' | 'unknown'`, `proposed: FeatureSupport`, and a short `rationale` (≤ 400 chars). No file writes.

When the agent comes back, summarise to the user in 4–8 lines:

```
Research verdict: revise
Rationale: Changelog entry for 3.4.17 says live-logs were extended to bash tools.
Proposed support: yes  (was: yes)
Proposed sourceUrl: https://cursor.com/changelog/05-07-26
Proposed sourceExtract: "Live logs now stream bash output line-by-line."
```

### 3c. Ask the user

Use `AskUserQuestion`. Options (single-select):

1. **Keep current** — no change persisted.
2. **Accept research proposal** — overwrite the entry with the agent's `proposed` object.
3. **Edit manually** — user wants to specify a different support level / note / source / screenshots.
4. **Mark unknown** — wipe sources, set `support: 'unknown'`.
5. **Skip for now** — leave the entry untouched and move on (does not count as reviewed).

If the user picks **Edit manually** or wants to attach screenshots/sources to a proposal:

- Ask, with sub-questions (`AskUserQuestion` for closed enums, free-form otherwise):
  - `support`: `yes | partial | no | unknown` (closed set).
  - `note` (optional, ≤ 280 chars).
  - `sourceUrl` (must be a URL; required when `support` ∈ {`yes`, `partial`}).
  - `sourceExtract` (verbatim quote; required when `support` ∈ {`yes`, `partial`}).
- Then ask: *"Any screenshots to attach? Paste absolute paths (one per line) or leave blank."*
  - Before copying anything, make sure the assets layout exists:
    - `mkdir -p public/screenshots/<toolId>` (create the orchestrator-scoped screenshot directory).
    - If `src/data/orchestrators/<toolId>/screenshots` is missing, create the symlink: `ln -s ../../../../public/screenshots/<toolId> src/data/orchestrators/<toolId>/screenshots`. Commit it as a normal file (git stores it as a symlink — mode `120000`).
  - For every path provided, ask (in this order):
    1. **Problématique** (optional sub-feature slug). Free-form prompt, empty = none. When provided, validate against `^[a-z0-9-]+$` and re-ask if invalid. Examples: `empty-state`, `error-toast`, `kanban-view`.
    2. **Alt text** (required, short — used by screen readers and as fallback).
    3. **Caption** (optional, one short sentence to display under the image).
  - Compute the filename: `<featureId>[_<problematique>]_<YYYYMMDD>_<n>.<ext>`, where:
    - Segments are separated by **underscore** (`_`), never by `-`. Dashes are reserved for slugs inside a single segment (`featureId`, `problematique`), so underscores guarantee unambiguous parsing.
    - `<YYYYMMDD>` is today's date (UTC ok; use the `currentDate` from the user context).
    - `<n>` starts at `1` and increments only against files **with the exact same prefix** (`<featureId>[_<problematique>]_<YYYYMMDD>_`) already in `public/screenshots/<toolId>/`. So `live-logs_20260518_1` and `live-logs_error-toast_20260518_1` are independent counter scopes.
    - Examples: `live-logs_20260518_1.png`, `kanban-board_empty-state_20260518_2.png`.
  - Copy the file into `public/screenshots/<toolId>/<computed-filename>`. Never overwrite an existing file.
  - Append to the entry's `screenshots` array: `{ src: '/screenshots/<toolId>/<computed-filename>', alt, caption? }`.
  - Never delete or rename existing files in `public/screenshots/<toolId>/` — orphaned shots are cheap, broken `src` references are not.

### 3d. Persist the change

Rewrite `_latest-known-features.ts` so it reflects the new state for *this* `featureId`:

- If the entry already exists in the array, replace it in place (preserve the existing screenshots when the user did not touch them; merge new screenshots into the array, never duplicating existing `src` values).
- If the entry is missing, insert it at the position matching the feature's order in `FEATURES`.
- Run the Zod schema mentally: `support ∈ enum`, `note ≤ 280`, `screenshots` array exists, `sourceUrl` is a valid URL when present.

After persistence, confirm in one line: `✔ Persisted live-logs → support=yes (sourceUrl updated, +1 screenshot).` and move on to the next feature.

### 3e. Pause / resume guard rails

- The user may type "stop", "pause", "later" at any prompt — when they do, run Step 4 with whatever has been persisted so far, then exit cleanly.
- Never batch-write multiple features without showing them to the user.
- Never invent a `sourceExtract`. If the agent could not produce one and the user did not supply one, the entry must end as `support: 'unknown'`.

---

## Step 4 — Finalise & commit

Once the loop ends (all features done **or** user paused):

1. **Status flip** — if every feature was reviewed (none `unknown`, none skipped) and the version file currently has `status: 'waiting-for-review'`, ask the user (`AskUserQuestion`, yes/no) whether to flip it to `'approved'`. Apply if yes (edit the version file to drop the `status` line or set it to `'approved'`).

2. **Validate** — run:

   ```sh
   pnpm exec tsc --noEmit
   ```

   Fix any Zod / TypeScript error before reporting success.

3. **Summary report** — print:
   - Counts: reviewed / changed / skipped / still-unknown.
   - Per-feature diff lines for every changed entry (`featureId: oldSupport → newSupport`).
   - List of screenshot files added under `public/screenshots/<toolId>/`.
   - The preview URL hint: `?preview=<toolId>@<version>`.

4. **Commit** — invoke the project's `/commit` skill (`Skill` tool with `skill: "commit"`). The commit must include both the updated `.ts` files and any new screenshot binaries. Stage them explicitly (avoid `git add -A`):
   - `src/data/orchestrators/<toolId>/_latest-known-features.ts`
   - `src/data/orchestrators/<toolId>/<version>.ts` (only when `status` was flipped)
   - `public/screenshots/<toolId>/*` (only the files actually added during this run)
   - `src/data/orchestrators/<toolId>/screenshots` (only when the symlink was just created)

   Suggested conventional-commit subject: `chore(review): refresh <toolId>@<version> feature matrix`.

---

## Reference files

- Schema: `src/data/schema.ts`
- Feature catalog: `src/data/features.ts`
- Meta type: `src/data/version-diff.ts`
- Auto-loader: `src/data/index.ts`
- Sibling skill (creates versions): `.claude/skills/add-orchestrator-version/SKILL.md`
