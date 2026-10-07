import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Editor end-to-end: drag & drop, layouts, the style system (breakpoints and
 * states), style presets + custom CSS, the component library (synced
 * instances) and unpacking composite blocks. Each test signs up a fresh user
 * and creates a fresh site through the API (proxied by the Vite dev server).
 */

interface Node {
  id: string;
  type: string;
  props: Record<string, any>;
  style?: Record<string, string>;
  responsive?: Record<string, Record<string, string>>;
  states?: Record<string, Record<string, string>>;
  presets?: string[];
  name?: string;
  slots?: Record<string, Node[]>;
}

const H = { 'x-modulo-client': '1' };
let seq = 0;

async function setup(page: Page) {
  const id = `${Date.now().toString(36)}${(seq++).toString(36)}`;
  const req = page.request;
  const signup = await req.post('/api/auth/signup', { headers: H, data: { email: `e2e-${id}@example.com`, password: 'e2e-password-123', name: 'E2E' } });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  const slug = `e2e-${id}`;
  const site = await req.post('/api/sites', { headers: H, data: { slug, name: `E2E ${id}` } });
  expect(site.ok(), await site.text()).toBeTruthy();
  const pages = await (await req.get(`/api/sites/${slug}/m/pages/pages`, { headers: H })).json();
  const pageId: string = pages.find((p: any) => p.path === '/')?.id ?? pages[0].id;
  await page.goto(`/sites/${slug}/pages/${pageId}`);
  await expect(page.locator('.save-status')).toHaveText(/Saved/, { timeout: 30_000 });
  await expect(canvasLoaded(page)).toBeVisible({ timeout: 30_000 });
  return { slug, pageId, req };
}

const frame = (page: Page) => page.frameLocator('iframe[title="Page preview (editable canvas)"]');
const canvasLoaded = (page: Page) => frame(page).locator('m-slot[data-parent="main"]');

async function draft(req: APIRequestContext, slug: string, pageId: string): Promise<Node> {
  const r = await req.get(`/api/sites/${slug}/m/pages/pages/${pageId}`, { headers: H });
  return (await r.json()).draft as Node;
}

function walk(n: Node, fn: (n: Node, parent: Node | null) => void, parent: Node | null = null) {
  fn(n, parent);
  for (const kids of Object.values(n.slots ?? {})) for (const k of kids) walk(k, fn, n);
}
function all(n: Node): Node[] {
  const out: Node[] = [];
  walk(n, (x) => out.push(x));
  return out;
}
const count = (n: Node) => all(n).length;
const byType = (n: Node, type: string) => all(n).filter((x) => x.type === type);
const find = (n: Node, id: string) => all(n).find((x) => x.id === id) ?? null;

/** Wait until the collaborative draft persisted on the server satisfies `check`. */
async function waitDraft(req: APIRequestContext, slug: string, pageId: string, check: (t: Node) => boolean, message = 'draft condition') {
  let last: Node | null = null;
  await expect
    .poll(
      async () => {
        last = await draft(req, slug, pageId);
        return check(last);
      },
      { message, timeout: 20_000, intervals: [250, 500, 1000] },
    )
    .toBe(true);
  return last as unknown as Node;
}

async function openTab(page: Page, label: string) {
  await page.getByRole('tab', { name: label, exact: true }).click();
}

async function styleTab(page: Page) {
  await page.locator('.inspector').getByRole('tab', { name: 'Style' }).click();
  await expect(page.locator('.style-panel')).toBeVisible();
}

async function openSection(page: Page, group: string) {
  const btn = page.locator(`.sp-section[data-group="${group}"] h3 button`);
  if ((await btn.getAttribute('aria-expanded')) !== 'true') await btn.click();
}

async function publish(page: Page, req: APIRequestContext, slug: string, ready: (html: string) => boolean = () => true) {
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && /\/pages\/[^/]+\/publish$/.test(new URL(r.url()).pathname), { timeout: 30_000 }),
    page.getByRole('button', { name: /^Publish/ }).first().click(),
  ]);
  expect(resp.ok(), await resp.text()).toBeTruthy();
  let html = '';
  await expect
    .poll(
      async () => {
        html = await (await req.get(`/s/${slug}`)).text();
        return ready(html);
      },
      { message: 'published page reflects the changes', timeout: 20_000, intervals: [300, 600, 1000] },
    )
    .toBe(true);
  return html;
}

const inspector = (page: Page) => page.locator('.inspector');

/* ───────────────────────── a) drag & click insert ───────────────────────── */

test('a) dragging a palette block inserts exactly one block; clicking inserts one more', async ({ page }) => {
  const { slug, pageId, req } = await setup(page);
  await openTab(page, 'Insert');
  const before = await draft(req, slug, pageId);
  const beforeCanvas = await frame(page).locator('[data-node-id]').count();
  const beforeHeadings = byType(before, 'core:heading').length;

  const item = page.getByRole('button', { name: /^Insert Heading/ });
  await item.scrollIntoViewIfNeeded();
  const src = (await item.boundingBox())!;
  const iframe = (await page.locator('iframe[title="Page preview (editable canvas)"]').boundingBox())!;
  // Drop over the lower part of the first top-level block on the page.
  const r = await frame(page)
    .locator('m-slot[data-parent="main"] > [data-node-id]')
    .first()
    .evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + Math.min(b.height - 6, b.height * 0.85) };
    });
  const target = { x: iframe.x + r.x, y: iframe.y + r.y };
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(src.x + src.width / 2 + 12, src.y + src.height / 2 + 4, { steps: 3 });
  await page.mouse.move(target.x, target.y, { steps: 25 });
  await expect(page.locator('.ov-drop')).toBeVisible();
  await page.mouse.move(target.x + 1, target.y + 1, { steps: 2 });
  await page.mouse.up();

  const after = await waitDraft(req, slug, pageId, (t) => count(t) === count(before) + 1, 'one node inserted by drag');
  expect(byType(after, 'core:heading')).toHaveLength(beforeHeadings + 1);
  await expect(frame(page).locator('[data-node-id]')).toHaveCount(beforeCanvas + 1);
  // No duplicate insert from the click that follows the pointer-up.
  await page.waitForTimeout(1200);
  expect(count(await draft(req, slug, pageId))).toBe(count(before) + 1);

  await item.click();
  await waitDraft(req, slug, pageId, (t) => count(t) === count(before) + 2, 'one more node inserted by click');
  await expect(frame(page).locator('[data-node-id]')).toHaveCount(beforeCanvas + 2);
  await page.waitForTimeout(800);
  expect(byType(await draft(req, slug, pageId), 'core:heading')).toHaveLength(beforeHeadings + 2);
});

/* ───────────────────────── b) columns + layout presets ───────────────────────── */

test('b) Columns inserts with two boxes; a layout preset inserts its whole structure', async ({ page }) => {
  const { slug, pageId, req } = await setup(page);
  await openTab(page, 'Insert');
  await page.getByRole('button', { name: /^Insert Columns/ }).click();
  let t = await waitDraft(req, slug, pageId, (d) => byType(d, 'core:columns').length === 1);
  const cols = byType(t, 'core:columns')[0]!;
  expect(cols.slots!.default!.map((k) => k.type)).toEqual(['core:box', 'core:box']);
  expect(cols.slots!.default!.map((k) => k.name)).toEqual(['Column 1', 'Column 2']);
  await expect(frame(page).locator(`[data-node-id="${cols.slots!.default![0]!.id}"]`)).toHaveCount(1);

  // Layers: double-click to rename (stored as node.name).
  await openTab(page, 'Layers');
  await page.locator(`[data-layer-id="${cols.id}"]`).dblclick();
  await page.getByRole('textbox', { name: /^Rename/ }).fill('Pricing columns');
  await page.keyboard.press('Enter');
  await waitDraft(req, slug, pageId, (d) => find(d, cols.id)?.name === 'Pricing columns');
  await expect(page.locator(`[data-layer-id="${cols.id}"] .layer-label`)).toHaveText('Pricing columns');
  await openTab(page, 'Insert');
  await expect(page.getByRole('region', { name: 'Layouts & sections' })).toBeVisible();
  const preset = page.locator('[data-preset-id="core.card-grid"]');
  await preset.scrollIntoViewIfNeeded();
  await preset.click();
  t = await waitDraft(req, slug, pageId, (d) => all(d).some((n) => n.name === 'Card grid'));
  const grid = all(t).find((n) => n.name === 'Card grid')!;
  expect(grid.style).toMatchObject({ display: 'grid', columns: '3' });
  expect(grid.slots!.default).toHaveLength(3);
  expect(new Set(all(t).map((n) => n.id)).size).toBe(all(t).length);
  await expect(frame(page).locator(`[data-node-id="${grid.id}"]`)).toBeVisible();
});

/* ───────────────────────── c) style panel → published CSS ───────────────────────── */

test('c) style panel: grid, columns per breakpoint, padding, hover background → published CSS', async ({ page }) => {
  const { slug, pageId, req } = await setup(page);
  await openTab(page, 'Insert');
  await page.getByRole('button', { name: /^Insert Box/ }).click();
  const t0 = await waitDraft(req, slug, pageId, (d) => byType(d, 'core:box').length === 1);
  const boxId = byType(t0, 'core:box')[0]!.id;
  await expect(inspector(page).locator('h2')).toHaveText('Box');
  await styleTab(page);
  const ins = inspector(page);

  // Desktop: display grid, 3 columns, padding-top 24px
  await openSection(page, 'layout');
  await ins.getByRole('radiogroup', { name: 'Display', exact: true }).getByRole('radio', { name: 'grid', exact: true }).click();
  await ins.getByRole('radiogroup', { name: 'Columns: equal tracks' }).getByRole('radio', { name: '3', exact: true }).click();
  await openSection(page, 'spacing');
  await ins.getByRole('button', { name: /^padding top:/ }).click();
  await ins.locator('[data-prop="paddingTop"] input[aria-label="Padding top"]').fill('24');
  // Invalid input shows an inline error and is not written.
  await openSection(page, 'size');
  await ins.locator('[data-prop="width"] input[aria-label="Width"]').fill('expression(alert(1))');
  await expect(ins.locator('[data-prop="width"] .sp-error')).toBeVisible();

  // Mobile: 1 column
  await ins.getByRole('radiogroup', { name: 'Breakpoint' }).getByRole('radio', { name: /Mobile/ }).click();
  await expect(page.getByRole('radiogroup', { name: 'Preview device' }).getByRole('radio', { checked: true })).toHaveAttribute('title', /Mobile/);
  await expect(ins.locator('[data-prop="columns"] .sp-inh')).toHaveText('3');
  await ins.getByRole('radiogroup', { name: 'Columns: equal tracks' }).getByRole('radio', { name: '1', exact: true }).click();

  // Hover state: background
  await ins.getByRole('radiogroup', { name: 'State' }).getByRole('radio', { name: 'Hover' }).click();
  await openSection(page, 'background');
  await ins.locator('[data-prop="background"] input[aria-label="Background"]').fill('#ff0000');

  const t = await waitDraft(req, slug, pageId, (d) => {
    const b = find(d, boxId);
    return !!b && b.style?.display === 'grid' && b.style?.columns === '3' && b.style?.paddingTop === '24px' && b.responsive?.sm?.columns === '1' && b.states?.hover?.background === '#ff0000';
  }, 'styles written to all layers');
  expect(find(t, boxId)!.style?.width).toBeUndefined();
  await page.locator('.inspector .insp-body').evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({ path: 'e2e/screenshots/style-panel-hover-mobile.png' });

  await ins.getByRole('radiogroup', { name: 'State' }).getByRole('radio', { name: 'Normal' }).click();
  await ins.getByRole('radiogroup', { name: 'Breakpoint' }).getByRole('radio', { name: /Desktop/ }).click();
  await ins.locator('[data-prop="width"] input').fill('');
  await page.locator('.inspector .insp-body').evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({ path: 'e2e/screenshots/style-panel.png' });

  const html = await publish(page, req, slug, (h) => h.includes('padding-top:24px'));
  expect(html).toContain('display:grid');
  expect(html).toContain('grid-template-columns:repeat(3,minmax(0,1fr))');
  expect(html).toContain('padding-top:24px');
  expect(html).toMatch(/@media \(max-width:640px\)\{[^}]*grid-template-columns:repeat\(1,minmax\(0,1fr\)\)/);
  expect(html).toMatch(/:hover\{background:#ff0000\}/);
});

/* ───────────────────────── d) presets + custom css ───────────────────────── */

test('d) create a style preset from a node, apply it to another node; custom CSS saved', async ({ page }) => {
  const { slug, pageId, req } = await setup(page);
  await openTab(page, 'Insert');
  await page.getByRole('button', { name: /^Insert Box/ }).click();
  const t0 = await waitDraft(req, slug, pageId, (d) => byType(d, 'core:box').length === 1);
  const first = byType(t0, 'core:box')[0]!.id;
  await styleTab(page);
  const ins = inspector(page);
  await openSection(page, 'spacing');
  await ins.getByRole('button', { name: 'All', exact: true }).first().click();
  await ins.locator('[data-prop="padding"] input[aria-label="Padding"]').fill('32');
  await openSection(page, 'border');
  await ins.locator('[data-prop="radius"] input[aria-label="Radius"]').fill('12');
  await waitDraft(req, slug, pageId, (d) => find(d, first)?.style?.padding === '32px' && find(d, first)?.style?.radius === '12px');

  await ins.getByRole('button', { name: 'Create preset from style' }).click();
  await ins.getByRole('textbox', { name: 'New preset name' }).fill('Card E2E');
  await ins.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(ins.locator('.preset-chip')).toHaveText(/Card E2E/);
  const t1 = await waitDraft(req, slug, pageId, (d) => JSON.stringify(find(d, first)?.presets) === '["card-e2e"]' && !find(d, first)?.style?.padding, 'preset applied and own styles moved into it');
  expect(find(t1, first)!.style ?? {}).toEqual({});
  const rt = await (await req.get(`/api/sites/${slug}/runtime`, { headers: H })).json();
  expect(rt.stylePresets['card-e2e']).toMatchObject({ label: 'Card E2E', style: { padding: '32px', radius: '12px' } });

  // Edit the preset itself (same style editor, saved via PUT /styles).
  await ins.locator('.preset-chip .pc-main').click();
  await expect(ins.locator('h2')).toHaveText('Preset: Card E2E');
  await openSection(page, 'background');
  await ins.locator('[data-prop="background"] input[aria-label="Background"]').fill('#fafafa');
  await expect
    .poll(async () => (await (await req.get(`/api/sites/${slug}/runtime`, { headers: H })).json()).stylePresets['card-e2e']?.style?.background, { timeout: 15_000 })
    .toBe('#fafafa');
  await page.screenshot({ path: 'e2e/screenshots/preset-editor.png' });
  await ins.getByRole('button', { name: 'Done' }).click();
  await expect(ins.locator('h2')).toHaveText('Box');

  // Second node: apply the preset
  await openTab(page, 'Insert');
  await page.getByRole('button', { name: /^Insert Box/ }).click();
  const t2 = await waitDraft(req, slug, pageId, (d) => byType(d, 'core:box').length === 2);
  const second = byType(t2, 'core:box').find((b) => b.id !== first)!.id;
  await styleTab(page);
  await ins.getByRole('combobox', { name: 'Apply a style preset' }).selectOption('card-e2e');
  await waitDraft(req, slug, pageId, (d) => JSON.stringify(find(d, second)?.presets) === '["card-e2e"]');

  // Class names + custom CSS
  await ins.getByRole('textbox', { name: /Classes/ }).fill('e2e-glow');
  await waitDraft(req, slug, pageId, (d) => (find(d, second) as any)?.className === 'e2e-glow');
  await openTab(page, 'Theme');
  await page.getByRole('button', { name: 'Custom CSS' }).click();
  await page.getByRole('textbox', { name: 'Custom CSS' }).fill('.e2e-glow{box-shadow:0 0 30px #2f5bea}');
  await expect(page.locator('[data-css-status="saved"]')).toBeVisible();
  // The presets manager lists the new preset.
  await page.getByRole('button', { name: 'Style presets' }).click();
  await expect(page.locator('.preset-item[data-preset="card-e2e"]')).toBeVisible();

  const html = await publish(page, req, slug, (h) => h.includes('.e2e-glow{') && (h.match(/class="[^"]*s-card-e2e/g)?.length ?? 0) === 2);
  expect(html).toContain('.s-card-e2e{');
  expect(html).toContain('padding:32px');
  expect(html).toContain('background:#fafafa');
  expect(html.match(/class="[^"]*s-card-e2e/g)?.length).toBe(2);
  expect(html).toContain('.e2e-glow{box-shadow:0 0 30px #2f5bea}');
});

/* ───────────────────────── e) component library ───────────────────────── */

test('e) library: save a component, insert synced instances, update the component, detach', async ({ page }) => {
  const { slug, pageId, req } = await setup(page);
  await openTab(page, 'Insert');
  await page.getByRole('button', { name: /^Insert Heading/ }).click();
  const t0 = await waitDraft(req, slug, pageId, (d) => all(d).some((n) => n.type === 'core:heading' && n.props.text === 'Heading'));
  const headingId = all(t0).find((n) => n.type === 'core:heading' && n.props.text === 'Heading')!.id;
  await inspector(page).getByRole('tab', { name: 'Content' }).click();
  await inspector(page).getByRole('textbox', { name: 'Text' }).fill('Summer E2E');
  await waitDraft(req, slug, pageId, (d) => find(d, headingId)?.props.text === 'Summer E2E');

  await openTab(page, 'Library');
  await page.getByRole('button', { name: 'Save selection as component' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('textbox', { name: 'Name' }).fill('Promo E2E');
  await dlg.getByRole('combobox', { name: 'Category' }).fill('Marketing');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(dlg).toBeHidden();
  const item = page.locator('.lib-item').filter({ hasText: 'Promo E2E' });
  await expect(item).toBeVisible();

  await item.getByRole('button', { name: 'Insert synced' }).click();
  await item.getByRole('button', { name: 'Insert synced' }).click();
  const t1 = await waitDraft(req, slug, pageId, (d) => byType(d, 'library:instance').length === 2);
  const instances = byType(t1, 'library:instance');
  await expect(frame(page).locator('.l-inst')).toHaveCount(2);
  await expect(frame(page).locator('.l-inst').nth(0)).toContainText('Summer E2E');
  await expect(frame(page).locator('.l-inst').nth(1)).toContainText('Summer E2E');

  // Clicking inside an instance selects the instance itself.
  await frame(page).locator(`[data-node-id^="${instances[0]!.id}~"]`).first().click();
  await expect(inspector(page).locator('.instance-note')).toContainText('Synced component: Promo E2E');

  // Change the component (edit the original heading, update from selection).
  await frame(page).locator(`[data-node-id="${headingId}"]`).click();
  await inspector(page).getByRole('tab', { name: 'Content' }).click();
  await inspector(page).getByRole('textbox', { name: 'Text' }).fill('Winter E2E');
  await waitDraft(req, slug, pageId, (d) => find(d, headingId)?.props.text === 'Winter E2E');
  await item.locator('summary[aria-label="More actions for Promo E2E"]').click();
  await item.getByRole('menuitem', { name: 'Update from selection' }).click();
  await expect(frame(page).locator('.l-inst').nth(0)).toContainText('Winter E2E');
  await expect(frame(page).locator('.l-inst').nth(1)).toContainText('Winter E2E');
  await frame(page).locator('.l-inst').nth(0).scrollIntoViewIfNeeded();
  await frame(page).locator(`[data-node-id="${instances[0]!.id}"]`).first().click({ position: { x: 4, y: 4 } });
  await expect(page.locator('.save-status')).toHaveText(/Saved/);
  await page.screenshot({ path: 'e2e/screenshots/library-panel.png' });

  let html = await publish(page, req, slug, (h) => h.includes('Winter E2E'));
  expect(html.match(/Winter E2E/g)).toHaveLength(3);
  expect(html).not.toContain('Summer E2E');

  // Detach the second instance into an independent copy.
  await frame(page).locator(`[data-node-id="${instances[1]!.id}"]`).first().click({ position: { x: 5, y: 5 } });
  await expect(inspector(page).locator('.instance-note')).toBeVisible();
  await inspector(page).getByRole('button', { name: 'Detach' }).click();
  const t2 = await waitDraft(req, slug, pageId, (d) => byType(d, 'library:instance').length === 1 && byType(d, 'core:heading').filter((h) => h.props.text === 'Winter E2E').length === 2);
  expect(find(t2, instances[1]!.id)).toBeNull();
  await expect(inspector(page).locator('.instance-note.detached')).toContainText('Copy of component');
  html = await publish(page, req, slug, (h) => (h.match(/Winter E2E/g)?.length ?? 0) === 3 && (h.match(/class="l-inst/g)?.length ?? 0) === 1);
  expect(html.match(/Winter E2E/g)).toHaveLength(3);
});

/* ───────────────────────── f) unpack ───────────────────────── */

test('f) unpacking a Hero makes its heading selectable and stylable', async ({ page }) => {
  const { slug, pageId, req } = await setup(page);
  await openTab(page, 'Insert');
  const before = new Set(byType(await draft(req, slug, pageId), 'core:hero').map((h) => h.id));
  await page.getByRole('button', { name: /^Insert Hero/ }).click();
  const t0 = await waitDraft(req, slug, pageId, (d) => byType(d, 'core:hero').length === before.size + 1);
  const heroes = byType(t0, 'core:hero');
  const hero = heroes.find((h) => !before.has(h.id))!;
  await frame(page).locator(`[data-node-id="${hero.id}"]`).click({ position: { x: 8, y: 8 } });
  await expect(inspector(page).locator('h2')).toHaveText('Hero');
  await inspector(page).getByRole('button', { name: 'Unpack into editable parts' }).click();
  const t1 = await waitDraft(req, slug, pageId, (d) => !find(d, hero.id) && byType(d, 'core:hero').length === heroes.length - 1, 'hero replaced');
  const box = all(t1).find((n) => n.type === 'core:box' && n.name === 'Hero')!;
  expect(box).toBeTruthy();
  const heading = all(box).find((n) => n.type === 'core:heading')!;
  expect(heading.props.text).toBe(hero.props.title ?? 'Build something people love');

  // Undo restores the hero in one step.
  await page.getByRole('button', { name: 'Undo' }).click();
  await waitDraft(req, slug, pageId, (d) => !!find(d, hero.id));
  await page.getByRole('button', { name: 'Redo' }).click();
  await waitDraft(req, slug, pageId, (d) => !find(d, hero.id) && !!find(d, heading.id));

  await frame(page).locator(`[data-node-id="${heading.id}"]`).click();
  await expect(inspector(page).locator('h2')).toHaveText('Heading');
  await styleTab(page);
  await openSection(page, 'typography');
  await inspector(page).locator('[data-prop="color"] input[aria-label="Color"]').fill('#00aa00');
  await waitDraft(req, slug, pageId, (d) => find(d, heading.id)?.style?.color === '#00aa00');
  await expect(frame(page).locator(`[data-node-id="${heading.id}"]`)).toHaveCSS('color', 'rgb(0, 170, 0)');
});

/* ───────────────────────── g) header/footer (layout patch ops) ───────────────────────── */

test('g) layout nodes (header) are styled per breakpoint through site layout ops', async ({ page }) => {
  const { slug, req } = await setup(page);
  await frame(page).locator('[data-node-id="header"]').click({ position: { x: 3, y: 3 } });
  await expect(inspector(page).locator('.badge.layout')).toBeVisible();
  await styleTab(page);
  const ins = inspector(page);
  await openSection(page, 'background');
  await ins.locator('[data-prop="background"] input[aria-label="Background"]').fill('#111111');
  await ins.getByRole('radiogroup', { name: 'Breakpoint' }).getByRole('radio', { name: /Mobile/ }).click();
  await openSection(page, 'spacing');
  await ins.locator('.bm-shortcuts').getByRole('button', { name: 'Y', exact: true }).first().click();
  await ins.locator('[data-prop="paddingY"] input[aria-label="Padding Y"]').fill('4');
  await expect
    .poll(async () => JSON.stringify((await (await req.get(`/api/sites/${slug}/layout`, { headers: H })).json()).ops), { timeout: 15_000 })
    .toContain('"paddingY":"4px"');
  const ops = (await (await req.get(`/api/sites/${slug}/layout`, { headers: H })).json()).ops;
  expect(ops).toEqual(
    expect.arrayContaining([
      { op: 'setStyle', target: 'header', style: { background: '#111111' } },
      { op: 'setStyle', target: 'header', bp: 'sm', style: { paddingY: '4px' } },
    ]),
  );
  await ins.getByRole('radiogroup', { name: 'Breakpoint' }).getByRole('radio', { name: /Desktop/ }).click();
  const html = await publish(page, req, slug, (h) => h.includes('background:#111111'));
  expect(html).toMatch(/@media \(max-width:640px\)\{[^}]*padding-top:4px/);
});
