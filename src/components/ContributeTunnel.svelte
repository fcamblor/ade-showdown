<script lang="ts">
  import { onMount } from 'svelte';
  import type { Platform, SupportLevel } from '../data/schema';
  import type {
    ContributionDraft,
    ContributionMode,
    DraftFeatureSupport,
    DraftScreenshot,
    ToolBaseline,
  } from '../lib/contribution/types';
  import {
    deleteBlob,
    deleteDraft,
    listDrafts,
    loadDraft,
    putBlob,
    getBlob,
    saveDraft,
  } from '../lib/contribution/db';
  import { buildProposal, copyToClipboard, downloadBlob, type BuiltProposal } from '../lib/contribution/export';

  type ContributeFeature = {
    id: string;
    label: string;
    category: string;
    shortDescription: string;
    longDescription?: string;
    whyImportant?: { short: string; long: string };
  };

  export let features: ContributeFeature[] = [];
  export let baselines: ToolBaseline[] = [];

  const SUPPORT_OPTIONS: { value: SupportLevel; label: string }[] = [
    { value: 'yes', label: 'Yes' },
    { value: 'partial', label: 'Partial' },
    { value: 'no', label: 'No' },
    { value: 'unknown', label: 'Unknown' },
  ];
  const PLATFORM_OPTIONS: { value: Platform; label: string }[] = [
    { value: 'macos', label: 'macOS' },
    { value: 'windows', label: 'Windows' },
    { value: 'linux', label: 'Linux' },
    { value: 'web', label: 'Web' },
  ];

  type Step = 'start' | 'meta' | 'features' | 'review';

  let step: Step = 'start';
  let draft: ContributionDraft | null = null;
  let currentIndex = 0;
  let existingDrafts: ContributionDraft[] = [];
  let selectedBaselineId = baselines[0]?.toolId ?? '';
  let error = '';
  let busy = false;
  let dragOver = false;

  // Object-URL previews for screenshots, keyed by screenshot id. Created on
  // upload or when resuming a draft; revoked on removal / teardown.
  let previews: Record<string, string> = {};
  let built: BuiltProposal | null = null;
  let copiedMd = false;

  const orderedFeatureIds = features.map((f) => f.id);

  $: currentFeature = features[currentIndex];
  $: currentSupport = draft && currentFeature ? draft.features[currentFeature.id] : undefined;
  $: reviewedCount = draft
    ? Object.values(draft.features).filter((f) => f.reviewed).length
    : 0;
  $: atLast = currentIndex >= features.length - 1;

  function todayStamp(): string {
    return new Date().toISOString().slice(0, 10);
  }

  function compactStamp(): string {
    return todayStamp().replace(/-/g, '');
  }

  function uuid(): string {
    return crypto.randomUUID();
  }

  function slugify(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  onMount(() => {
    void refreshDrafts();
    return () => {
      for (const url of Object.values(previews)) URL.revokeObjectURL(url);
    };
  });

  async function refreshDrafts() {
    existingDrafts = await listDrafts();
  }

  async function persist() {
    if (!draft) return;
    draft.updatedAt = new Date().toISOString();
    draft = draft; // trigger reactivity
    await saveDraft(draft);
  }

  function emptyFeature(id: string): DraftFeatureSupport {
    return { featureId: id, support: 'unknown', screenshots: [] };
  }

  async function startNewTool() {
    const id = uuid();
    const fresh: ContributionDraft = {
      id,
      schemaVersion: 1,
      mode: 'new-tool',
      meta: { toolId: '', toolName: '', homepage: '', platforms: [] },
      version: '',
      releaseDate: todayStamp(),
      features: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    for (const f of features) fresh.features[f.id] = emptyFeature(f.id);
    draft = fresh;
    await persist();
    step = 'meta';
  }

  async function startNewVersion() {
    const base = baselines.find((b) => b.toolId === selectedBaselineId);
    if (!base) {
      error = 'Pick an orchestrator first.';
      return;
    }
    const id = uuid();
    const fresh: ContributionDraft = {
      id,
      schemaVersion: 1,
      mode: 'new-version',
      meta: {
        toolId: base.toolId,
        toolName: base.toolName,
        homepage: base.homepage,
        vendor: base.vendor,
        pricing: base.pricing,
        codebase: base.codebase,
        platforms: [...base.platforms],
        modelRestriction: base.modelRestriction,
      },
      version: '',
      releaseDate: todayStamp(),
      baseToolId: base.toolId,
      baseVersion: base.baseVersion,
      features: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // Pre-fill every feature from the baseline, recording the inherited value
    // so the tunnel can flag changes and the generator can emit overrides.
    const byId = new Map(base.features.map((f) => [f.featureId, f]));
    for (const f of features) {
      const b = byId.get(f.id as any);
      if (b) {
        fresh.features[f.id] = {
          featureId: f.id,
          support: b.support,
          note: b.note,
          sourceUrl: b.sourceUrl,
          sourceExtract: b.sourceExtract,
          screenshots: [],
          inherited: {
            support: b.support,
            note: b.note,
            sourceUrl: b.sourceUrl,
            sourceExtract: b.sourceExtract,
            screenshotCount: b.screenshotCount,
          },
        };
      } else {
        fresh.features[f.id] = emptyFeature(f.id);
      }
    }
    draft = fresh;
    await persist();
    error = '';
    step = 'meta';
  }

  async function resumeDraft(id: string) {
    const loaded = await loadDraft(id);
    if (!loaded) return;
    draft = loaded;
    // Rebuild previews from the stored blobs.
    for (const fs of Object.values(loaded.features)) {
      for (const shot of fs.screenshots) {
        const blob = await getBlob(shot.id);
        if (blob) previews[shot.id] = URL.createObjectURL(blob);
      }
    }
    previews = previews;
    currentIndex = 0;
    step = loaded.meta.toolName ? 'features' : 'meta';
  }

  async function removeDraft(id: string) {
    await deleteDraft(id);
    if (draft?.id === id) {
      draft = null;
      step = 'start';
    }
    await refreshDrafts();
  }

  // ----- meta step ----------------------------------------------------------

  function onToolNameInput(value: string) {
    if (!draft) return;
    draft.meta.toolName = value;
    if (draft.mode === 'new-tool') draft.meta.toolId = slugify(value);
    void persist();
  }

  function togglePlatform(p: Platform) {
    if (!draft) return;
    const has = draft.meta.platforms.includes(p);
    draft.meta.platforms = has
      ? draft.meta.platforms.filter((x) => x !== p)
      : [...draft.meta.platforms, p];
    void persist();
  }

  function metaValid(): boolean {
    if (!draft) return false;
    const m = draft.meta;
    const idOk = /^[a-z0-9-]+$/.test(m.toolId);
    const urlOk = /^https?:\/\/.+/.test(m.homepage);
    const platformsOk = draft.mode === 'new-version' || m.platforms.length > 0;
    const releaseDateOk = /^\d{4}-\d{2}-\d{2}$/.test(draft.releaseDate);
    return Boolean(m.toolName) && idOk && urlOk && Boolean(draft.version) && releaseDateOk && platformsOk;
  }

  function goToFeatures() {
    if (!metaValid()) {
      error = 'Fill in tool name, a valid homepage URL, version, release date and at least one platform.';
      return;
    }
    error = '';
    currentIndex = 0;
    step = 'features';
  }

  // ----- features step ------------------------------------------------------

  function setSupport(value: SupportLevel) {
    if (!draft || !currentFeature) return;
    draft.features[currentFeature.id].support = value;
    draft.features[currentFeature.id].reviewed = true;
    void persist();
  }

  function setField(field: 'note' | 'sourceUrl' | 'sourceExtract', value: string) {
    if (!draft || !currentFeature) return;
    (draft.features[currentFeature.id] as any)[field] = value;
    void persist();
  }

  function nextUsedIndex(fs: DraftFeatureSupport): number {
    const used = new Set(
      fs.screenshots.map((s) => {
        const m = s.filename.match(/_(\d+)\.[a-z0-9]+$/i);
        return m ? Number(m[1]) : 0;
      }),
    );
    let n = 1;
    while (used.has(n)) n += 1;
    return n;
  }

  function extFor(file: File): string {
    const map: Record<string, string> = {
      'image/webp': 'webp',
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/avif': 'avif',
    };
    if (map[file.type]) return map[file.type];
    const dot = file.name.lastIndexOf('.');
    return dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : 'bin';
  }

  async function addFiles(files: File[]) {
    if (!draft || !currentFeature) return;
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return;
    const fs = draft.features[currentFeature.id];
    for (const file of images) {
      const n = nextUsedIndex(fs);
      const id = uuid();
      const shot: DraftScreenshot = {
        id,
        filename: `${currentFeature.id}_${compactStamp()}_${n}.${extFor(file)}`,
        mimeType: file.type || 'application/octet-stream',
        alt: '',
      };
      await putBlob(id, draft.id, file);
      previews[id] = URL.createObjectURL(file);
      fs.screenshots = [...fs.screenshots, shot];
    }
    previews = previews;
    await persist();
  }

  async function onFiles(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files) return;
    await addFiles(Array.from(input.files));
    input.value = '';
  }

  function onDragOver(event: DragEvent) {
    event.preventDefault();
    dragOver = true;
  }

  function onDragLeave() {
    dragOver = false;
  }

  async function onDrop(event: DragEvent) {
    event.preventDefault();
    dragOver = false;
    const files = event.dataTransfer?.files;
    if (files && files.length) await addFiles(Array.from(files));
  }

  async function removeScreenshot(shotId: string) {
    if (!draft || !currentFeature) return;
    const fs = draft.features[currentFeature.id];
    fs.screenshots = fs.screenshots.filter((s) => s.id !== shotId);
    await deleteBlob(shotId);
    if (previews[shotId]) {
      URL.revokeObjectURL(previews[shotId]);
      delete previews[shotId];
      previews = previews;
    }
    await persist();
  }

  function setShotMeta(shotId: string, field: 'alt' | 'caption', value: string) {
    if (!draft || !currentFeature) return;
    const fs = draft.features[currentFeature.id];
    const shot = fs.screenshots.find((s) => s.id === shotId);
    if (!shot) return;
    shot[field] = value;
    fs.screenshots = fs.screenshots;
    void persist();
  }

  function changedFromBaseline(fs: DraftFeatureSupport | undefined): boolean {
    if (!fs || !fs.inherited) return false;
    const b = fs.inherited;
    return (
      fs.support !== b.support ||
      (fs.note ?? '') !== (b.note ?? '') ||
      (fs.sourceUrl ?? '') !== (b.sourceUrl ?? '') ||
      (fs.sourceExtract ?? '') !== (b.sourceExtract ?? '') ||
      fs.screenshots.length !== b.screenshotCount
    );
  }

  function goPrev() {
    if (currentIndex > 0) currentIndex -= 1;
    else step = 'meta';
  }

  function goNext() {
    if (draft && currentFeature) draft.features[currentFeature.id].reviewed = true;
    void persist();
    if (atLast) step = 'review';
    else currentIndex += 1;
  }

  // ----- review / export ----------------------------------------------------

  function validationErrors(): string[] {
    if (!draft) return ['No draft.'];
    const errs: string[] = [];
    if (!metaValid()) errs.push('Tool metadata is incomplete (name, id, homepage, version, release date, platforms).');
    for (const f of features) {
      for (const shot of draft.features[f.id]?.screenshots ?? []) {
        if (!shot.alt.trim()) {
          errs.push(`Screenshot "${shot.filename}" needs alt text.`);
        }
      }
    }
    return errs;
  }

  $: reviewErrors = step === 'review' ? validationErrors() : [];

  async function generate() {
    if (!draft) return;
    busy = true;
    error = '';
    try {
      built = await buildProposal(draft, orderedFeatureIds);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to build the proposal.';
    } finally {
      busy = false;
    }
  }

  function doDownload() {
    if (built) downloadBlob(built.zip, built.filename);
  }

  async function doCopyMarkdown() {
    if (!built) return;
    copiedMd = await copyToClipboard(built.markdown);
    if (copiedMd) setTimeout(() => (copiedMd = false), 2500);
  }
</script>

<section class="contrib">
  {#if step === 'start'}
    <article class="contrib__panel">
      <p class="contrib__eyebrow">Contribute</p>
      <h2>Propose an orchestrator or a new version</h2>
      <p>
        Everything stays on your device (IndexedDB) until you export. At the end you get a ZIP
        (data file + screenshots, repo-relative paths) and a pre-filled GitHub issue. Nothing is
        sent to any server.
      </p>

      <div class="contrib__choice">
        <button type="button" class="contrib__cta" on:click={startNewTool}>
          <strong>New orchestrator</strong>
          <span>Describe a tool from scratch across every feature.</span>
        </button>
        <div class="contrib__cta contrib__cta--form">
          <strong>New version of an existing one</strong>
          <span>Pre-filled from the latest known version; you note what changed.</span>
          <div class="contrib__row">
            <select bind:value={selectedBaselineId} aria-label="Orchestrator">
              {#each baselines as b}
                <option value={b.toolId}>{b.toolName} (from {b.baseVersion})</option>
              {/each}
            </select>
            <button type="button" on:click={startNewVersion} disabled={!baselines.length}>Start</button>
          </div>
        </div>
      </div>
      {#if error}<p class="contrib__error">{error}</p>{/if}

      {#if existingDrafts.length}
        <div class="contrib__drafts">
          <h3>Resume a draft</h3>
          <ul>
            {#each existingDrafts as d}
              <li>
                <button type="button" class="contrib__link" on:click={() => resumeDraft(d.id)}>
                  {d.meta.toolName || 'Untitled'} {d.version || ''} · {d.mode === 'new-tool' ? 'new tool' : 'new version'}
                </button>
                <span class="contrib__muted">{d.updatedAt.slice(0, 16).replace('T', ' ')}</span>
                <button type="button" class="contrib__del" on:click={() => removeDraft(d.id)} aria-label="Delete draft">✕</button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </article>
  {:else if step === 'meta' && draft}
    <article class="contrib__panel">
      <p class="contrib__eyebrow">{draft.mode === 'new-tool' ? 'New orchestrator' : 'New version'}</p>
      <h2>Tool details</h2>
      <div class="contrib__fields">
        <label>
          <span>Tool name</span>
          <input
            type="text"
            value={draft.meta.toolName}
            readonly={draft.mode === 'new-version'}
            on:input={(e) => onToolNameInput(e.currentTarget.value)}
            placeholder="e.g. Conductor"
          />
        </label>
        <label>
          <span>Tool id <em>(lowercase, a-z 0-9 -)</em></span>
          <input
            type="text"
            value={draft.meta.toolId}
            readonly={draft.mode === 'new-version'}
            on:input={(e) => { if (draft) { draft.meta.toolId = e.currentTarget.value; void persist(); } }}
            placeholder="e.g. conductor"
          />
        </label>
        <label>
          <span>Version</span>
          <input
            type="text"
            value={draft.version}
            on:input={(e) => { if (draft) { draft.version = e.currentTarget.value; void persist(); } }}
            placeholder="e.g. 1.4.0"
          />
        </label>
        <label>
          <span>Release date <em>(ISO yyyy-mm-dd)</em></span>
          <input
            type="text"
            inputmode="numeric"
            pattern="\d{4}-\d{2}-\d{2}"
            placeholder="yyyy-mm-dd"
            value={draft.releaseDate}
            on:input={(e) => { if (draft) { draft.releaseDate = e.currentTarget.value; void persist(); } }}
          />
        </label>
        <label class="contrib__wide">
          <span>Homepage</span>
          <input
            type="url"
            value={draft.meta.homepage}
            readonly={draft.mode === 'new-version'}
            on:input={(e) => { if (draft) { draft.meta.homepage = e.currentTarget.value; void persist(); } }}
            placeholder="https://…"
          />
        </label>
      </div>

      {#if draft.mode === 'new-tool'}
        <div class="contrib__fields">
          <label>
            <span>Vendor <em>(optional)</em></span>
            <input type="text" value={draft.meta.vendor ?? ''} on:input={(e) => { if (draft) { draft.meta.vendor = e.currentTarget.value; void persist(); } }} />
          </label>
          <label>
            <span>Pricing <em>(optional)</em></span>
            <select value={draft.meta.pricing ?? ''} on:change={(e) => { if (draft) { draft.meta.pricing = (e.currentTarget.value || undefined) as any; void persist(); } }}>
              <option value="">—</option>
              <option value="free">free</option>
              <option value="freemium">freemium</option>
              <option value="paid">paid</option>
              <option value="oss">oss</option>
            </select>
          </label>
          <label>
            <span>Codebase <em>(optional)</em></span>
            <select value={draft.meta.codebase ?? ''} on:change={(e) => { if (draft) { draft.meta.codebase = (e.currentTarget.value || undefined) as any; void persist(); } }}>
              <option value="">—</option>
              <option value="open-source">open-source</option>
              <option value="proprietary">proprietary</option>
            </select>
          </label>
        </div>
        <fieldset class="contrib__platforms">
          <legend>Platforms</legend>
          {#each PLATFORM_OPTIONS as p}
            <label class="contrib__check" class:contrib__check--on={draft.meta.platforms.includes(p.value)}>
              <input type="checkbox" checked={draft.meta.platforms.includes(p.value)} on:change={() => togglePlatform(p.value)} />
              <span>{p.label}</span>
            </label>
          {/each}
        </fieldset>
      {:else}
        <p class="contrib__muted">
          Metadata inherited from {draft.meta.toolName} {draft.baseVersion}. Adjust the version and
          release date above; per-feature changes come next.
        </p>
      {/if}

      <div class="contrib__actions">
        <button type="button" class="contrib__ghost" on:click={() => (step = 'start')}>Back</button>
        <button type="button" on:click={goToFeatures}>Review features →</button>
      </div>
      {#if error}<p class="contrib__error">{error}</p>{/if}
    </article>
  {:else if step === 'features' && draft && currentFeature}
    <div class="contrib__progress">
      <span>{reviewedCount} / {features.length} reviewed</span>
      <nav class="contrib__nav">
        <button type="button" class="contrib__step" on:click={goPrev} aria-label="Previous">‹</button>
        <span class="contrib__pos">#{currentIndex + 1}</span>
        <button type="button" class="contrib__step" on:click={goNext} aria-label="Next">›</button>
      </nav>
    </div>
    <div class="contrib__bar"><i style={`width: ${Math.round(((currentIndex + 1) / features.length) * 100)}%`}></i></div>

    <article class="contrib__panel">
      <p class="contrib__eyebrow">
        {currentFeature.category}
        {#if changedFromBaseline(currentSupport)}<span class="contrib__badge">changed</span>{/if}
      </p>
      <h2>{currentFeature.label}</h2>
      <p>{currentFeature.longDescription ?? currentFeature.shortDescription}</p>

      {#if currentSupport?.inherited}
        <p class="contrib__inherited">
          Baseline ({draft.baseVersion}): <strong>{currentSupport.inherited.support}</strong>
          {#if currentSupport.inherited.note} — {currentSupport.inherited.note}{/if}
        </p>
      {/if}

      <div class="contrib__support" role="group" aria-label="Support level">
        {#each SUPPORT_OPTIONS as opt}
          <button
            type="button"
            class="contrib__toggle"
            class:contrib__toggle--on={currentSupport?.support === opt.value}
            on:click={() => setSupport(opt.value)}
          >{opt.label}</button>
        {/each}
      </div>

      <div class="contrib__fields">
        <label class="contrib__wide">
          <span>Note <em>(optional, ≤ 280 chars)</em></span>
          <textarea
            rows="2"
            maxlength="280"
            value={currentSupport?.note ?? ''}
            on:input={(e) => setField('note', e.currentTarget.value)}
          ></textarea>
        </label>
        <label class="contrib__wide">
          <span>Source URL <em>(optional)</em></span>
          <input type="url" value={currentSupport?.sourceUrl ?? ''} on:input={(e) => setField('sourceUrl', e.currentTarget.value)} placeholder="https://…" />
        </label>
        <label class="contrib__wide">
          <span>Source extract <em>(optional quote)</em></span>
          <textarea rows="2" value={currentSupport?.sourceExtract ?? ''} on:input={(e) => setField('sourceExtract', e.currentTarget.value)}></textarea>
        </label>
      </div>

      <div
        class="contrib__shots"
        class:contrib__shots--drag={dragOver}
        role="group"
        aria-label="Screenshots"
        on:dragover={onDragOver}
        on:dragleave={onDragLeave}
        on:drop={onDrop}
      >
        <div class="contrib__shots-head">
          <span>Screenshots</span>
          <label class="contrib__upload">
            <input type="file" accept="image/*" multiple on:change={onFiles} />
            <span>+ Add</span>
          </label>
        </div>
        <label class="contrib__dropzone">
          <input type="file" accept="image/*" multiple on:change={onFiles} />
          <span>{dragOver ? 'Drop images here' : 'Drag & drop screenshots here, or click to browse'}</span>
        </label>
        {#each currentSupport?.screenshots ?? [] as shot (shot.id)}
          <div class="contrib__shot">
            {#if previews[shot.id]}<img src={previews[shot.id]} alt={shot.alt || 'screenshot preview'} />{/if}
            <div class="contrib__shot-meta">
              <code>{shot.filename}</code>
              <input
                type="text"
                class:contrib__invalid={!shot.alt.trim()}
                placeholder="Alt text (required)"
                value={shot.alt}
                on:input={(e) => setShotMeta(shot.id, 'alt', e.currentTarget.value)}
              />
              <input
                type="text"
                placeholder="Caption (optional)"
                value={shot.caption ?? ''}
                on:input={(e) => setShotMeta(shot.id, 'caption', e.currentTarget.value)}
              />
            </div>
            <button type="button" class="contrib__del" on:click={() => removeScreenshot(shot.id)} aria-label="Remove screenshot">✕</button>
          </div>
        {/each}
      </div>

      <div class="contrib__actions">
        <button type="button" class="contrib__ghost" on:click={goPrev}>← Previous</button>
        <button type="button" class="contrib__ghost" on:click={() => (step = 'review')}>Skip to export</button>
        <button type="button" on:click={goNext}>{atLast ? 'Done →' : 'Next →'}</button>
      </div>
    </article>
  {:else if step === 'review' && draft}
    <article class="contrib__panel">
      <p class="contrib__eyebrow">Export</p>
      <h2>{draft.meta.toolName} {draft.version}</h2>
      <p>{reviewedCount} / {features.length} features reviewed · {draft.mode === 'new-tool' ? 'new orchestrator' : `new version (base ${draft.baseVersion})`}</p>

      {#if reviewErrors.length}
        <ul class="contrib__errlist">
          {#each reviewErrors as e}<li>{e}</li>{/each}
        </ul>
      {/if}

      <div class="contrib__actions">
        <button type="button" class="contrib__ghost" on:click={() => (step = 'features')}>← Back to features</button>
        <button type="button" on:click={generate} disabled={busy || reviewErrors.length > 0}>
          {busy ? 'Building…' : 'Generate proposal'}
        </button>
      </div>

      {#if built}
        <div class="contrib__result">
          <p>
            Bundle ready: {built.screenshotCount} screenshot(s)
            {#if draft.mode === 'new-version'}· {built.changedCount} changed feature(s){/if}.
          </p>
          <div class="contrib__actions contrib__actions--start">
            <button type="button" on:click={doDownload}>⬇ Download ZIP</button>
            <button type="button" class="contrib__ghost" on:click={doCopyMarkdown}>{copiedMd ? '✓ Copied' : 'Copy summary (Markdown)'}</button>
            <a class="contrib__ghost contrib__linkbtn" href={built.issueUrl} target="_blank" rel="noreferrer">Open GitHub issue ↗</a>
          </div>
          <p class="contrib__muted">
            Unzip at the repo root, then open the issue and paste the copied summary into the
            "Generated payload" field (and drag the screenshots in if you like).
          </p>
        </div>
      {/if}
      {#if error}<p class="contrib__error">{error}</p>{/if}
    </article>
  {/if}
</section>

<style>
  .contrib { max-width: min(900px, 100%); margin: 0 auto; display: grid; gap: 16px; }
  .contrib__panel {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-elev);
    padding: clamp(18px, 4vw, 30px);
    box-shadow: var(--shadow-card);
  }
  .contrib__eyebrow {
    margin: 0 0 10px;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.18em;
    font: 700 0.75rem var(--font-display);
  }
  h2 { margin: 0 0 12px; font: 900 clamp(1.6rem, 4vw, 2.4rem)/0.98 var(--font-display); text-transform: uppercase; }
  h3 { font: 800 1.1rem var(--font-display); margin: 0 0 8px; }
  p { color: var(--fg-soft); }
  .contrib__muted { color: var(--fg-muted); font-size: 0.85rem; }

  .contrib__choice { display: grid; gap: 12px; margin-top: 18px; grid-template-columns: 1fr 1fr; }
  @media (max-width: 640px) { .contrib__choice { grid-template-columns: 1fr; } }
  .contrib__cta {
    display: flex; flex-direction: column; gap: 6px; text-align: left;
    border: 1px solid var(--border); border-radius: var(--radius-md);
    background: var(--bg-row); color: var(--fg); padding: 16px; cursor: pointer; font: inherit;
  }
  .contrib__cta:hover { border-color: var(--accent); }
  .contrib__cta--form { cursor: default; }
  .contrib__cta strong { font: 800 1.05rem var(--font-display); letter-spacing: 0.04em; }
  .contrib__cta span { color: var(--fg-muted); font-size: 0.9rem; }
  .contrib__row { display: flex; gap: 8px; margin-top: 8px; }
  .contrib__row select { flex: 1 1 auto; }

  .contrib__fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 16px; }
  .contrib__fields label { display: grid; gap: 4px; font-size: 0.85rem; color: var(--fg-soft); }
  .contrib__fields label em { color: var(--fg-muted); font-style: normal; }
  .contrib__wide { grid-column: 1 / -1; }
  @media (max-width: 560px) { .contrib__fields { grid-template-columns: 1fr; } }

  input, select, textarea {
    border: 1px solid var(--border); border-radius: var(--radius-md);
    background: var(--bg-row); color: var(--fg); padding: 9px 11px; font: inherit;
  }
  input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); }
  input[readonly] { opacity: 0.6; }
  .contrib__invalid { border-color: var(--cell-no-ink); }

  .contrib__platforms { margin-top: 16px; border: 1px solid var(--border); border-radius: var(--radius-md); padding: 12px; display: flex; flex-wrap: wrap; gap: 8px; }
  .contrib__platforms legend { padding: 0 6px; color: var(--fg-soft); font-size: 0.8rem; }
  .contrib__check, .contrib__upload {
    display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px;
    border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-row);
    color: var(--fg); cursor: pointer; font-weight: 700; font-size: 0.85rem;
  }
  .contrib__check--on { border-color: var(--accent); background: color-mix(in oklch, var(--accent) 14%, var(--bg-row)); }
  .contrib__check input, .contrib__upload input { accent-color: var(--accent); }
  .contrib__upload input { display: none; }

  .contrib__support { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .contrib__toggle {
    min-width: 84px; border: 1px solid var(--border); border-radius: var(--radius-md);
    background: var(--bg-row); color: var(--fg); padding: 10px 16px; font: inherit; font-weight: 800; cursor: pointer;
  }
  .contrib__toggle--on { border-color: var(--accent); background: color-mix(in oklch, var(--accent) 18%, var(--bg-row)); }

  .contrib__inherited { margin-top: 12px; padding: 8px 12px; border: 1px solid var(--border-soft); border-radius: var(--radius-md); background: var(--bg-row); font-size: 0.85rem; }

  .contrib__shots { margin-top: 18px; border-top: 1px solid var(--border-soft); padding-top: 14px; display: grid; gap: 12px; border-radius: var(--radius-md); transition: background 140ms ease; }
  .contrib__shots--drag { background: color-mix(in oklch, var(--accent) 12%, transparent); outline: 2px dashed var(--accent); outline-offset: 4px; }
  .contrib__shots-head { display: flex; align-items: center; justify-content: space-between; font-weight: 700; color: var(--fg-soft); }
  .contrib__dropzone {
    display: flex; align-items: center; justify-content: center; text-align: center;
    border: 1px dashed var(--border-strong); border-radius: var(--radius-md);
    padding: 16px; color: var(--fg-muted); font-size: 0.85rem; cursor: pointer;
    transition: border-color 140ms ease, color 140ms ease;
  }
  .contrib__dropzone:hover { border-color: var(--accent); color: var(--fg-soft); }
  .contrib__dropzone input { display: none; }
  .contrib__shot { display: grid; grid-template-columns: 96px 1fr auto; gap: 12px; align-items: start; border: 1px solid var(--border-soft); border-radius: var(--radius-md); padding: 10px; }
  .contrib__shot img { width: 96px; height: 64px; object-fit: cover; border-radius: var(--radius-sm); border: 1px solid var(--border); }
  .contrib__shot-meta { display: grid; gap: 6px; }
  .contrib__shot-meta code { font-size: 0.72rem; color: var(--fg-muted); word-break: break-all; }

  .contrib__actions { margin-top: 20px; display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
  .contrib__actions--start { justify-content: flex-start; }
  button, .contrib__linkbtn {
    display: inline-flex; align-items: center; justify-content: center; min-height: 42px;
    border: 1px solid var(--accent); border-radius: var(--radius-md);
    background: var(--accent); color: var(--bg); padding: 10px 16px; font: inherit; font-weight: 800; cursor: pointer; text-decoration: none;
  }
  .contrib__ghost { border-color: var(--border); background: var(--bg-row); color: var(--fg); }
  button:disabled { cursor: not-allowed; opacity: 0.45; }

  .contrib__progress { display: flex; align-items: center; justify-content: space-between; color: var(--fg-soft); font-weight: 700; }
  .contrib__nav { display: inline-flex; align-items: center; gap: 4px; }
  .contrib__pos { min-width: 3ch; text-align: center; font-variant-numeric: tabular-nums; color: var(--fg-muted); font-size: 0.85rem; }
  .contrib__step { min-height: 30px; min-width: 30px; padding: 0; border: 1px solid var(--border); background: var(--bg-row); color: var(--fg); font: 700 1.1rem/1 var(--font-display); }
  .contrib__bar { height: 8px; border-radius: 999px; background: var(--bg-row); overflow: hidden; border: 1px solid var(--border); }
  .contrib__bar i { display: block; height: 100%; background: var(--accent); transition: width 280ms ease; }
  .contrib__badge { display: inline-block; margin-left: 8px; padding: 2px 8px; border-radius: 999px; background: color-mix(in oklch, var(--cell-partial) 40%, transparent); border: 1px solid var(--cell-partial); color: var(--cell-partial-ink); font-size: 0.7rem; letter-spacing: 0.1em; }

  .contrib__drafts { margin-top: 22px; border-top: 1px solid var(--border-soft); padding-top: 14px; }
  .contrib__drafts ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .contrib__drafts li { display: flex; align-items: center; gap: 10px; }
  .contrib__link { background: none; border: none; color: var(--canvas); padding: 4px 0; min-height: 0; font-weight: 700; cursor: pointer; }
  .contrib__link:hover { color: var(--accent); }
  .contrib__del { min-height: 26px; min-width: 26px; padding: 0; border: 1px solid var(--border); background: var(--bg-row); color: var(--fg-muted); border-radius: var(--radius-sm); margin-left: auto; }

  .contrib__result { margin-top: 18px; border-top: 1px solid var(--border-soft); padding-top: 14px; }
  .contrib__error { color: var(--cell-no-ink); margin-top: 12px; }
  .contrib__errlist { color: var(--cell-no-ink); margin: 12px 0 0; padding-left: 18px; font-size: 0.9rem; }
</style>
