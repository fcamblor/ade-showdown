import type { OrchestratorMeta } from '../../version-diff';

export const META: OrchestratorMeta = {
  toolId: 'conductor',
  toolName: 'Conductor',
  homepage: 'https://conductor.build',
  vendor: 'Melty Labs',
  pricing: 'free',
  pricingSource: {
    sourceUrl: 'https://www.conductor.build/docs/faq',
    sourceExtract:
      "At some point we plan to charge for collaboration features that help teams make the most of AI agents, but for now we're focused on making Conductor an amazing free tool.",
  },
  platforms: ['macos'],
  platformSources: {
    macos: {
      sourceUrl: 'https://www.conductor.build/docs/installation',
      sourceExtract:
        'Conductor is available for macOS. […] Conductor is not available for Windows or Linux yet.',
    },
  },
  modelRestriction: {
    message: 'Only Claude Code and Codex agents are supported.',
    sourceUrl: 'https://www.conductor.build/docs/concepts/agent-modes',
  },
  trackingSources: [
    {
      kind: 'changelog',
      label: 'Conductor changelog',
      url: 'https://www.conductor.build/changelog',
    },
    {
      kind: 'docs',
      label: 'Conductor documentation',
      url: 'https://www.conductor.build/docs/installation',
    },
    {
      kind: 'other',
      label: 'Conductor homepage',
      url: 'https://conductor.build',
    },
  ],
};
