import type { OrchestratorMeta } from '../../version-diff';

export const META: OrchestratorMeta = {
  toolId: 'cursor',
  toolName: 'Cursor 3',
  homepage: 'https://cursor.com',
  vendor: 'Anysphere',
  pricing: 'freemium',
  pricingSource: {
    sourceUrl: 'https://cursor.com/pricing',
    sourceExtract:
      'Hobby — Free. No credit card required. Individual — $20 / mo. Teams — $40 / user / mo. Enterprise — Custom.',
  },
  platforms: ['macos', 'windows', 'linux'],
  platformSources: {
    macos: {
      sourceUrl: 'https://cursor.com/downloads',
      sourceExtract:
        'The Cursor desktop app is available for macOS, Windows, and Linux. […] Mac (ARM64), Mac (x64), Mac Universal.',
    },
    windows: {
      sourceUrl: 'https://cursor.com/downloads',
      sourceExtract:
        'The Cursor desktop app is available for macOS, Windows, and Linux. […] Windows (x64) (System), Windows (x64) (User), Windows (ARM64) (System), Windows (ARM64) (User).',
    },
    linux: {
      sourceUrl: 'https://cursor.com/downloads',
      sourceExtract:
        'The Cursor desktop app is available for macOS, Windows, and Linux. […] Linux .deb (ARM64/x64), Linux RPM (ARM64/x64), Linux AppImage (ARM64/x64).',
    },
  },
  trackingSources: [
    {
      kind: 'changelog',
      label: 'Cursor changelog',
      url: 'https://cursor.com/changelog',
    },
    {
      kind: 'blog',
      label: 'Cursor blog',
      url: 'https://cursor.com/blog',
    },
    {
      kind: 'docs',
      label: 'Cursor documentation',
      url: 'https://cursor.com/docs',
    },
    {
      kind: 'other',
      label: 'Cursor community forum',
      url: 'https://forum.cursor.com',
      notes: 'User-driven feature requests and roadmap signals.',
    },
  ],
};
