import { defineModule } from '@modulo/kernel';
import type { PageNode } from '@modulo/core';
import { allBlocks } from './blocks.ts';
import { box, columns, embed, icon, list, LAYOUT_PRESETS, PRIMITIVES } from './primitives.ts';

export { href } from './blocks.ts';
export { PRIMITIVES, LAYOUT_PRESETS } from './primitives.ts';

/**
 * The site layout every page renders inside. Stable node ids and named slots
 * ("header#nav", "header#actions", "footer") are the public patch surface
 * that other modules extend.
 */
export const layoutTree: PageNode = {
  id: 'root',
  type: 'core:page',
  props: {},
  slots: {
    default: [
      {
        id: 'header',
        type: 'core:header',
        props: { sticky: true },
        slots: {
          brand: [{ id: 'logo', type: 'core:logo', props: { text: 'My Site', href: '/' }, bind: { text: 'site.name' } }],
          nav: [{ id: 'nav-home', type: 'core:link', props: { label: 'Home', href: '/' } }],
          actions: [],
        },
      },
      { id: 'main', type: 'core:outlet', props: {}, slots: { default: [] } },
      { id: 'footer', type: 'core:footer', props: { text: '©' }, bind: { text: 'site.copyright' }, slots: { default: [] } },
    ],
  },
};

// Composite blocks can be unpacked into primitives (editor: "Unpack into editable parts").
for (const b of allBlocks) if (PRIMITIVES[b.type]) b.toPrimitives = PRIMITIVES[b.type];

export default defineModule({
  name: 'core',
  version: '1.0.0',
  label: 'Core',
  description: 'Base blocks, the site layout and design tokens.',
  kernel: '^1.0.0',
  required: true,
  category: 'Foundation',
  blocks: [...allBlocks, box, columns, icon, list, embed],
  presets: LAYOUT_PRESETS,
  templates: [{ id: 'core:layout', label: 'Site layout', tree: layoutTree }],
  permissions: [
    { key: 'core.design', label: 'Edit theme and layout' },
    { key: 'core.members', label: 'Manage members' },
  ],
  grants: { editor: ['core.design'] },
});
