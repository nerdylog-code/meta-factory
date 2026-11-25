import { defineFactory } from '@mf/core';

/**
 * The sandbox factory: minimal configuration used to exercise the engine.
 * Compare with packages/: no engine code lives here, only settings.
 */
export default defineFactory({
  name: 'sandbox',
  title: 'Sandbox Factory',
  description: 'Reference factory used to validate capabilities and gates.',
  port: 4960,
  pageStagePort: 4961,
  budgetUsd: 2,
  tier: 'S',
  harnesses: ['notes', 'coding', 'pages', 'settings', 'subagents', 'proactive', 'teams', 'mailbox'],
  workspaceRoot: './workspace',
  agents: [
    { id: 'lead', role: 'lead', name: 'Lead', prompt: 'You are the lead of a small, careful software factory.' },
    { id: 'writer', role: 'specialist', name: 'Writer', tier: 'C', prompt: 'You write clear notes.' },
  ],
});

