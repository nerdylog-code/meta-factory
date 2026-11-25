import { defineFactory } from '@mf/core';

/**
 * The MetaFactory: the factory that manages factories.
 *
 * It carries the `metafactory` harness, which can spin up new thin factories
 * (factory.spinUp) and promote validated local modules into shared packages
 * (module.promote, human-gated). It is deliberately NOT a "super factory" with
 * special tools: it runs through the same CommandBus, capabilities and gates as
 * every other factory.
 */
export default defineFactory({
  name: '_meta',
  title: 'MetaFactory',
  description: 'Manages factory lifecycles and module promotion.',
  port: 4950,
  pageStagePort: 4951,
  budgetUsd: 1,
  tier: 'S',
  harnesses: ['notes', 'metafactory', 'settings'],
  workspaceRoot: './workspace',
  agents: [
    {
      id: 'lead',
      role: 'lead',
      name: 'Factory Lead',
      prompt:
        'You manage a family of software factories. You create factories, review what they produce, and promote validated modules. Never create a factory that duplicates an existing one.',
    },
    {
      id: 'meta',
      role: 'specialist',
      name: 'MetaFactory Agent',
      tier: 'C',
      prompt: 'You audit factory configurations and flag duplication or drift.',
    },
  ],
});
