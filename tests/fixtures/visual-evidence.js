'use strict';

function intent(overrides = {}) {
  return {
    version: 1,
    impact: 'ui',
    rationale: 'The invitation dialog now keeps matching users visible.',
    stories: [{
      id: 'invite-suggestions',
      claim: 'Typing a username shows suggestions beside the invite action.',
      persona: 'member',
      viewports: [{ name: 'desktop', width: 1280, height: 800 }],
      intent: {
        startPath: '/lists/demo',
        steps: ['Open Members', 'Open Invite', 'Type ma'],
        checkpoint: 'Suggestions and the Invite button are visible together',
        focus: 'Invite member dialog',
        animation: 'steps',
      },
    }],
    ...overrides,
  };
}

function plan(overrides = {}) {
  const semantic = intent();
  const actions = [
    { id: 'open-members', stage: 'members', type: 'click', target: { by: 'role', role: 'button', name: 'Members', exact: true } },
    { id: 'open-invite', stage: 'invite', type: 'click', target: { by: 'testId', value: 'invite-member' } },
    { id: 'type-query', stage: 'query', type: 'fill', target: { by: 'label', value: 'Username', exact: true }, value: 'ma' },
  ];
  return {
    ...semantic,
    stories: semantic.stories.map((story) => ({
      ...story,
      replay: {
        before: { startPath: '/lists/demo', actions },
        after: { startPath: '/lists/demo', actions },
        checkpoint: {
          id: 'suggestions-open',
          label: 'Username suggestions visible',
          focus: {
            before: { by: 'role', role: 'dialog', name: 'Invite member', exact: true },
            after: { by: 'role', role: 'dialog', name: 'Invite member', exact: true },
          },
          assertions: {
            before: [{ type: 'hidden', target: { by: 'role', role: 'listbox' } }],
            after: [{ type: 'visible', target: { by: 'role', role: 'listbox' } }],
          },
          animation: 'steps',
        },
      },
    })),
    ...overrides,
  };
}

module.exports = { intent, plan };
