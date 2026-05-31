import { getBlob } from './db';
import {
  genChangeReportMarkdown,
  genLatestKnownFile,
  genMetaFile,
  genProposalMarkdown,
  genReviewRemarksMarkdown,
  genVersionFileDiff,
  genVersionFileNewTool,
  type FeatureChange,
  type GenFeatureSupport,
  type GenScreenshot,
  type ProposalSummary,
  type ReviewRemark,
  type ScreenshotChange,
  type TextChange,
} from './codegen';
import { blobEntry, makeSplitZips, textEntry, type ZipEntry } from './zip';
import type { ContributionDraft, DraftFeatureSupport } from './types';

const REPO = 'fcamblor/ade-arena';

// GitHub rejects issue attachments above 25 MB. We cap each produced ZIP below
// that to keep headroom, splitting the screenshots across several parts when a
// single bundle would exceed it.
const MAX_PART_BYTES = 22 * 1024 * 1024;

function norm(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function screenshotSrc(toolId: string, filename: string): string {
  return `/screenshots/${toolId}/${filename}`;
}

function toGenScreenshots(toolId: string, fs: DraftFeatureSupport): GenScreenshot[] {
  return fs.screenshots
    // Baseline screenshots flagged removed are dropped from the generated
    // feature so the override expresses the deletion against the baseline.
    .filter((s) => !s.removed)
    .map((s) => ({
      // Baseline-origin shots keep their already-published path; freshly added
      // ones get the repo-convention path under the tool's screenshot folder.
      src: s.baselineSrc ?? screenshotSrc(toolId, s.filename),
      alt: s.alt,
      caption: norm(s.caption),
    }));
}

function toGenFeatureSupport(toolId: string, fs: DraftFeatureSupport): GenFeatureSupport {
  return {
    featureId: fs.featureId,
    support: fs.support,
    note: norm(fs.note),
    screenshots: toGenScreenshots(toolId, fs),
    sourceUrl: norm(fs.sourceUrl),
    sourceExtract: norm(fs.sourceExtract),
  };
}

// A feature differs from its inherited baseline if any persisted field changed
// or its screenshot set changed. Drives which rows become `override` diffs.
function screenshotsChanged(fs: DraftFeatureSupport): boolean {
  return fs.screenshots.some((s) => {
    if (!s.inherited) return true; // freshly attached
    if (s.removed) return true; // baseline shot dropped
    return norm(s.alt) !== norm(s.inherited.alt) || norm(s.caption) !== norm(s.inherited.caption);
  });
}

function hasChanged(fs: DraftFeatureSupport): boolean {
  const base = fs.inherited;
  if (!base) return true;
  return (
    fs.support !== base.support ||
    norm(fs.note) !== norm(base.note) ||
    norm(fs.sourceUrl) !== norm(base.sourceUrl) ||
    norm(fs.sourceExtract) !== norm(base.sourceExtract) ||
    screenshotsChanged(fs)
  );
}

// Text fields that moved vs the baseline, for the clipboard change report.
function collectTextChanges(fs: DraftFeatureSupport): TextChange[] {
  const base = fs.inherited;
  if (!base) return [];
  const out: TextChange[] = [];
  if (fs.support !== base.support) {
    out.push({ field: 'support', before: base.support, after: fs.support });
  }
  if (norm(fs.note) !== norm(base.note)) {
    out.push({ field: 'note', before: base.note, after: fs.note });
  }
  if (norm(fs.sourceUrl) !== norm(base.sourceUrl)) {
    out.push({ field: 'source URL', before: base.sourceUrl, after: fs.sourceUrl });
  }
  if (norm(fs.sourceExtract) !== norm(base.sourceExtract)) {
    out.push({ field: 'source extract', before: base.sourceExtract, after: fs.sourceExtract });
  }
  return out;
}

// Screenshots added / removed / re-captioned vs the baseline, for the report.
function collectScreenshotChanges(toolId: string, fs: DraftFeatureSupport): ScreenshotChange[] {
  const out: ScreenshotChange[] = [];
  for (const s of fs.screenshots) {
    if (!s.inherited) {
      // Freshly attached (baseline shots always carry `inherited`).
      out.push({
        kind: 'added',
        ref: s.baselineSrc ?? screenshotSrc(toolId, s.filename),
        altAfter: s.alt,
        captionAfter: s.caption,
      });
    } else if (s.removed) {
      out.push({
        kind: 'removed',
        ref: s.inherited.src,
        altBefore: s.inherited.alt,
        captionBefore: s.inherited.caption,
      });
    } else if (norm(s.alt) !== norm(s.inherited.alt) || norm(s.caption) !== norm(s.inherited.caption)) {
      out.push({
        kind: 'edited',
        ref: s.inherited.src,
        altBefore: s.inherited.alt,
        altAfter: s.alt,
        captionBefore: s.inherited.caption,
        captionAfter: s.caption,
      });
    }
  }
  return out;
}

/** One downloadable ZIP file. A bundle that fits under the GitHub attachment
 * limit yields a single part; a larger one is split into several. */
export type ProposalPart = {
  blob: Blob;
  filename: string;
};

export type BuiltProposal = {
  /**
   * The ZIP(s) to download. Usually one, but split into several parts (with the
   * screenshots spread across them) when a single ZIP would exceed GitHub's
   * 25 MB attachment limit. The text files (PROPOSAL.md + data) ride in part 1.
   */
  parts: ProposalPart[];
  /** Summary shipped inside the ZIP (PROPOSAL.md). Never carries review remarks. */
  markdown: string;
  /**
   * Summary copied to the clipboard for the GitHub issue body: the PROPOSAL.md
   * content plus a "Review remarks" section when the author flagged any. Kept
   * separate from `markdown` so the remarks stay out of the exported ZIP.
   */
  clipboardMarkdown: string;
  issueUrl: string;
  changedCount: number;
  screenshotCount: number;
  /** Number of features carrying a review remark (clipboard only). */
  remarkCount: number;
};

// Assemble every artefact for a draft: the ZIP (repo-relative paths so the
// contributor unzips at the repo root), the Markdown summary, and the
// pre-filled GitHub issue URL. `orderedFeatureIds` keeps output deterministic
// and aligned with the canonical feature order.
export async function buildProposal(
  draft: ContributionDraft,
  orderedFeatureIds: string[],
  featureLabels: Record<string, string> = {},
): Promise<BuiltProposal> {
  const toolId = draft.meta.toolId;
  const ordered = orderedFeatureIds
    .map((id) => draft.features[id])
    .filter((fs): fs is DraftFeatureSupport => Boolean(fs));

  const allGen = ordered.map((fs) => toGenFeatureSupport(toolId, fs));
  const changedFeatureIds: string[] = ordered.filter(hasChanged).map((fs) => fs.featureId);

  // Text files (PROPOSAL.md + data) are tiny and ride together in the first ZIP
  // part; the screenshots are the only large entries and get spread across parts
  // when the bundle would otherwise exceed GitHub's attachment limit.
  const dataEntries: ZipEntry[] = [];
  const screenshotEntries: ZipEntry[] = [];
  const dir = `src/data/orchestrators/${toolId}`;
  const versionFile = `${dir}/${draft.version}.ts`;

  if (draft.mode === 'new-tool') {
    dataEntries.push(textEntry(`${dir}/_meta.ts`, genMetaFile(draft.meta)));
    dataEntries.push(textEntry(`${dir}/_latest-known-features.ts`, genLatestKnownFile(allGen)));
    dataEntries.push(textEntry(versionFile, genVersionFileNewTool(draft.version, draft.releaseDate)));
  } else {
    const overrides = allGen.filter((g) => changedFeatureIds.includes(g.featureId));
    dataEntries.push(
      textEntry(
        versionFile,
        genVersionFileDiff(
          draft.version,
          draft.releaseDate,
          draft.baseVersion ?? 'unknown baseline',
          overrides,
        ),
      ),
    );
  }

  // Screenshots — only the freshly added ones carry a Blob to bundle. Baseline
  // screenshots already live in the repo (skipped), and removed ones are
  // excluded from both the feature data and the ZIP.
  let screenshotCount = 0;
  for (const fs of ordered) {
    for (const shot of fs.screenshots) {
      if (shot.baselineSrc || shot.removed) continue;
      const blob = await getBlob(shot.id);
      if (!blob) continue;
      screenshotEntries.push(
        await blobEntry(`public/screenshots/${toolId}/${shot.filename}`, blob),
      );
      screenshotCount += 1;
    }
  }

  const summary: ProposalSummary = {
    mode: draft.mode,
    toolId,
    toolName: draft.meta.toolName,
    version: draft.version,
    releaseDate: draft.releaseDate,
    homepage: draft.meta.homepage,
    baseVersion: draft.baseVersion,
    features: allGen,
    changedFeatureIds,
    screenshotCount,
    trackingSources:
      draft.mode === 'new-tool'
        ? (draft.meta.trackingSources ?? [])
            .filter((t) => t.url.trim())
            .map((t) => ({
              kind: t.kind,
              label: t.label.trim(),
              url: t.url.trim(),
              notes: norm(t.notes),
            }))
        : undefined,
  };
  const markdown = genProposalMarkdown(summary);
  // PROPOSAL.md ships inside the ZIP — deliberately without the review remarks.
  // It leads the anchor entries so it lands in the first part.
  const anchorEntries: ZipEntry[] = [textEntry('PROPOSAL.md', markdown), ...dataEntries];

  // Review remarks are review metadata, not dataset content: they are appended
  // only to the clipboard Markdown (the GitHub issue body), never to the ZIP.
  const remarks: ReviewRemark[] = ordered
    .map((fs) => ({
      featureId: fs.featureId,
      label: featureLabels[fs.featureId],
      remark: norm(fs.reviewRemark) ?? '',
    }))
    .filter((r) => r.remark);
  const remarksMarkdown = genReviewRemarksMarkdown(remarks);

  // Change report — new-version only: a per-feature list of edited text and
  // added/removed screenshots vs the baseline, so the diff is readable at a
  // glance without scanning the generated override .ts. Clipboard-only, like
  // the remarks: it is review context, not dataset content.
  let changeReportMarkdown = '';
  if (draft.mode === 'new-version') {
    const changes: FeatureChange[] = ordered
      .map((fs) => ({
        featureId: fs.featureId,
        label: featureLabels[fs.featureId],
        textChanges: collectTextChanges(fs),
        screenshotChanges: collectScreenshotChanges(toolId, fs),
      }))
      .filter((c) => c.textChanges.length > 0 || c.screenshotChanges.length > 0);
    changeReportMarkdown = genChangeReportMarkdown(changes, draft.baseVersion ?? 'baseline');
  }

  // Assemble the clipboard body: PROPOSAL.md, then the change report, then the
  // author remarks — skipping any empty section so spacing stays clean.
  const clipboardMarkdown = [markdown, changeReportMarkdown, remarksMarkdown]
    .filter((section) => section.trim())
    .join('\n');

  // Split the bundle when a single ZIP would breach the GitHub attachment limit;
  // screenshots are spread across parts, the text files all stay in part 1.
  const blobs = makeSplitZips(anchorEntries, screenshotEntries, MAX_PART_BYTES);
  const base = `${toolId}-${draft.version}-proposal`;
  const parts: ProposalPart[] = blobs.map((blob, i) => ({
    blob,
    filename:
      blobs.length === 1 ? `${base}.zip` : `${base}-part${i + 1}of${blobs.length}.zip`,
  }));

  return {
    parts,
    markdown,
    clipboardMarkdown,
    issueUrl: buildIssueUrl(draft),
    changedCount: changedFeatureIds.length,
    screenshotCount,
    remarkCount: remarks.length,
  };
}

// Pre-fill the GitHub issue *form* via its field ids. The full markdown payload
// is too large to reliably pass through a URL, so it is copied to the clipboard
// separately and the contributor pastes it into the "payload" field.
export function buildIssueUrl(draft: ContributionDraft): string {
  const params = new URLSearchParams({
    template: 'orchestrator-proposal.yml',
    title: `feat(data): ${draft.meta.toolName} ${draft.version}`,
    'tool-name': draft.meta.toolName,
    'tool-id': draft.meta.toolId,
    version: draft.version,
    homepage: draft.meta.homepage,
    mode: draft.mode === 'new-tool' ? 'New orchestrator' : 'New version of an existing orchestrator',
  });
  return `https://github.com/${REPO}/issues/new?${params.toString()}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
