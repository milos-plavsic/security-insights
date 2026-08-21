'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const yaml = require('js-yaml');

const root = path.resolve(__dirname, '../../..');
const schemaSource = fs.readFileSync(path.join(root, 'spec/schema.cue'), 'utf8');
const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
const fullExamplePath = path.join(root, 'examples/example-full.yml');
const minimumExamplePath = path.join(root, 'examples/example-minimum.yml');
const jsYamlSource = fs.readFileSync(
  path.join(root, 'node_modules/js-yaml/dist/js-yaml.min.js'),
  'utf8'
);
const schemaUrl =
  'https://raw.githubusercontent.com/ossf/security-insights/main/spec/schema.cue';
const versionUrl = 'https://raw.githubusercontent.com/ossf/security-insights/main/VERSION';
const runtimeState = new WeakMap();

async function routeSchemaRequests(page) {
  await page.route('https://cdn.jsdelivr.net/**', route => {
    if (route.request().url().includes('/js-yaml@4.3.1/dist/js-yaml.min.js')) {
      return route.fulfill({
        status: 200,
        contentType: 'text/javascript; charset=utf-8',
        body: jsYamlSource
      });
    }
    runtimeState.get(page).unexpectedRequests.push(route.request().url());
    return route.fulfill({ status: 404, body: 'Unexpected test request' });
  });
  await page.route('https://raw.githubusercontent.com/ossf/security-insights/**', route => {
    const url = route.request().url();
    if (url === schemaUrl) {
      return route.fulfill({ status: 200, body: schemaSource });
    }
    if (url === versionUrl) {
      return route.fulfill({ status: 200, body: version });
    }
    runtimeState.get(page).unexpectedRequests.push(url);
    return route.fulfill({ status: 404, body: 'Unexpected test request' });
  });
}

async function tabTo(page, selector, maximumTabs = 250) {
  for (let index = 0; index < maximumTabs; index += 1) {
    if (await page.locator(selector).evaluate(element => element === document.activeElement)) {
      return;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error(`Keyboard focus did not reach ${selector} after ${maximumTabs} Tab presses`);
}

test.beforeEach(async ({ page }) => {
  const state = { consoleErrors: [], pageErrors: [], unexpectedRequests: [] };
  runtimeState.set(page, state);
  page.on('console', message => {
    if (message.type() === 'error') {
      state.consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', error => state.pageErrors.push(error.message));
});

test.afterEach(async ({ page }) => {
  const state = runtimeState.get(page);
  expect(state.consoleErrors, 'browser console errors').toEqual([]);
  expect(state.pageErrors, 'uncaught browser errors').toEqual([]);
  expect(state.unexpectedRequests, 'unexpected schema requests').toEqual([]);
});

async function openFreshEditor(page) {
  await routeSchemaRequests(page);
  await page.goto('/editor/');
  await expect(page.locator('.site-header')).toBeVisible();
  await expect(page.locator('.site-footer')).toBeAttached();
  expect(await page.evaluate(() => Array.from(document.styleSheets).some(sheet =>
    sheet.href && sheet.href.endsWith('/assets/css/style.css')
  ))).toBe(true);
  await expect(page.locator('.social-media-list a')).toHaveCount(4);
  expect(await page.locator('.social-media-list a').evaluateAll(links =>
    links.every(link => link.href.startsWith('https://'))
  )).toBe(true);
  await expect(page.locator('#status-text')).toHaveText('Schema loaded');
  await page.locator('#start-fresh-btn').click();
  await expect(page.locator('#editor-main')).toBeVisible();
}

test('the primary workflow is operable from the keyboard alone', async ({ page }) => {
  await routeSchemaRequests(page);
  await page.goto('/editor/');
  await expect(page.locator('#status-text')).toHaveText('Schema loaded');

  await tabTo(page, '#start-fresh-btn');
  await page.keyboard.press('Enter');
  await expect(page.locator('#editor-main')).toBeVisible();

  await tabTo(
    page,
    '#form-sections > .form-section:first-child .form-section-toggle'
  );
  await page.keyboard.press('Space');
  await expect(page.locator('.form-section').first()).toHaveClass(/collapsed/);
  await page.keyboard.press('Space');
  await expect(page.locator('.form-section').first()).not.toHaveClass(/collapsed/);

  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#mode-form')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#mode-wizard')).toBeFocused();

  const headerUrl = page.locator('#wizard-editor [data-path="header.url"] input');
  await tabTo(page, '#wizard-editor [data-path="header.url"] input');
  await page.keyboard.insertText('https://example.com/security-insights.yml');
  await expect(headerUrl).toHaveValue('https://example.com/security-insights.yml');

  for (let step = 1; step < 6; step += 1) {
    await tabTo(page, '#wizard-next');
    await page.keyboard.press('Enter');
    await expect(page.locator('.wizard-step-heading')).toBeFocused();
    await expect(page.locator('.wizard-progress-item[aria-current="step"]'))
      .toContainText(`Step ${step + 1}:`);
  }

  await tabTo(page, '#wizard-next');
  await page.keyboard.press('Enter');
  await expect(page.locator('#form-editor')).toBeVisible();
  await expect(page.locator('.toast', { hasText: 'Wizard completed' })).toBeVisible();

  await tabTo(page, '#download-yaml-btn');
  const downloadPromise = page.waitForEvent('download');
  await page.keyboard.press('Enter');
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/security-insights.*\.yml$/);
  const downloadedYaml = fs.readFileSync(await download.path(), 'utf8');
  expect(downloadedYaml).toContain('https://example.com/security-insights.yml');
});

test('configuration and conditional setup controls remain accessible', async ({ page }) => {
  await routeSchemaRequests(page);
  await page.goto('/editor/');
  await expect(page.locator('#status-text')).toHaveText('Schema loaded');

  await page.locator('#config-panel details').evaluate(element => element.open = true);
  await page.locator('#single-maintainer-checkbox').check();
  await expect(page.locator('#single-maintainer-checkbox'))
    .toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#single-maintainer-fields')).toBeVisible();

  const results = await new AxeBuilder({ page }).withTags([
    'wcag2a',
    'wcag2aa',
    'wcag21a',
    'wcag21aa'
  ]).analyze();
  expect(results.violations).toEqual([]);
});

test('keyboard navigation exposes coherent tabs and wizard progress', async ({ page }) => {
  await openFreshEditor(page);
  const formTab = page.locator('#mode-form');
  await formTab.focus();
  await formTab.press('ArrowRight');

  await expect(page.locator('#mode-wizard')).toBeFocused();
  await expect(page.locator('#mode-wizard')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#wizard-editor')).toBeVisible();
  await expect(page.locator('.wizard-progress-list > li')).toHaveCount(6);
  await expect(page.locator('.wizard-progress-item[aria-current="step"]')).toContainText('Header');
  await expect(page.locator('.wizard-progress-item[aria-current="step"]'))
    .not.toContainText(', current');

  await page.locator('#wizard-next').click();
  await expect(page.locator('.wizard-step-heading')).toBeFocused();
  await expect(page.locator('.wizard-progress-item[aria-current="step"]')).toContainText('Project');
  await expect(page.locator('.wizard-progress-list button')).toContainText('completed');
  await expect(page.locator('.wizard-progress-list button')).toHaveCount(1);
});

test('wizard progress retains its visual connections and fits a mobile viewport', async ({
  page,
  browserName
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await openFreshEditor(page);
  await page.locator('#mode-wizard').click();

  const connectorDisplays = await page.locator('.wizard-step').evaluateAll(steps => {
    return steps.map(step => getComputedStyle(step, '::after').display);
  });
  expect(connectorDisplays.slice(0, -1).every(display => display !== 'none')).toBe(true);
  expect(connectorDisplays.at(-1)).toBe('none');

  const layout = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    progressScrollable:
      document.querySelector('.wizard-progress').scrollWidth
        > document.querySelector('.wizard-progress').clientWidth,
    overflowElements: Array.from(document.querySelectorAll('body *'))
      .map(element => ({
        name: element.id || element.className || element.tagName,
        right: Math.ceil(element.getBoundingClientRect().right),
        width: Math.ceil(element.getBoundingClientRect().width)
      }))
      .filter(element => element.right > document.documentElement.clientWidth)
      .slice(0, 50)
  }));
  expect(
    layout.documentWidth,
    `overflowing elements: ${JSON.stringify(layout.overflowElements)}`
  ).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.progressScrollable).toBe(true);
  const progress = page.locator('.wizard-progress');
  await progress.focus();
  await expect(progress).toBeFocused();
  const initialScroll = await progress.evaluate(element => element.scrollLeft);
  await progress.press('ArrowRight');
  await expect.poll(() => progress.evaluate(element => element.scrollLeft))
    .toBeGreaterThan(initialScroll);

  const mobileAxe = await new AxeBuilder({ page }).withTags([
    'wcag2a',
    'wcag2aa',
    'wcag21a',
    'wcag21aa'
  ]).analyze();
  expect(mobileAxe.violations).toEqual([]);
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 4_000 });
  await progress.evaluate(element => element.scrollLeft = 0);
  if (browserName === 'chromium') {
    await expect(progress).toHaveScreenshot(
      'wizard-progress-mobile.png',
      { animations: 'disabled' }
    );
    await page.locator('#wizard-next').click();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('.wizard-progress-list button')).toBeFocused();
    const completedFocus = await page.locator('.wizard-progress-list button')
      .evaluate(element => getComputedStyle(element).outlineStyle);
    expect(completedFocus).not.toBe('none');
    await expect(progress).toHaveScreenshot(
      'wizard-progress-mobile-completed-focus.png',
      { animations: 'disabled' }
    );
  }
});

test('validation owns, announces, navigates, and completely clears errors', async ({ page }) => {
  await openFreshEditor(page);

  const nested = await page.evaluate(() => {
    window.testOriginalValidate = YamlExport.validate;
    YamlExport.validate = () => [
      { path: 'project', message: 'project structure invalid' },
      { path: 'project.name', message: 'name is required' }
    ];
    App.runValidation();
    const parent = document.querySelector('[data-path="project"]');
    const child = document.querySelector('[data-path="project.name"]');
    return {
      parentOwnsMessage: Boolean(
        parent.querySelector(':scope > [data-validation-error]')
      ),
      childOwnsMessage: Boolean(
        child.querySelector(':scope > [data-validation-error]')
      ),
      groupInvalid: parent.getAttribute('aria-invalid'),
      groupDescribed: parent.getAttribute('aria-describedby'),
      groupVisual: parent.classList.contains('validation-group-error'),
      inputInvalid: child.querySelector(':scope > input').getAttribute('aria-invalid')
    };
  });
  expect(nested).toEqual({
    parentOwnsMessage: true,
    childOwnsMessage: true,
    groupInvalid: null,
    groupDescribed: 'validation-error-0',
    groupVisual: true,
    inputInvalid: 'true'
  });
  const validationAxe = await new AxeBuilder({ page }).withTags([
    'wcag2a',
    'wcag2aa',
    'wcag21a',
    'wcag21aa'
  ]).analyze();
  expect(validationAxe.violations).toEqual([]);

  await page.evaluate(() => {
    YamlExport.validate = () => [];
    App.runValidation();
  });
  await expect(page.locator('[data-validation-error]')).toHaveCount(0);
  await expect(page.locator('[aria-invalid="true"]')).toHaveCount(0);
  await expect(page.locator('.validation-group-error')).toHaveCount(0);
  expect(await page.locator('[aria-describedby*="validation-error-"]').count()).toBe(0);

  const arrayState = await page.evaluate(() => {
    YamlExport.validate = () => [{
      path: 'project.repositories',
      message: 'at least one repository is required'
    }];
    App.runValidation();
    const field = document.querySelector('[data-path="project.repositories"]');
    const button = field.querySelector(':scope > .array-field-header button');
    return {
      invalid: button.getAttribute('aria-invalid'),
      described: button.getAttribute('aria-describedby')
    };
  });
  expect(arrayState.invalid).toBeNull();
  expect(arrayState.described).toBeTruthy();

  await page.evaluate(() => {
    YamlExport.validate = () => [
      { path: '', message: 'document is invalid' },
      { path: 'unknown.path', message: 'unknown problem' }
    ];
    App.runValidation();
  });
  await expect(page.locator('.error-text')).toHaveCount(2);
  await expect(page.locator('.error-link')).toHaveCount(0);

  await page.evaluate(() => {
    YamlExport.validate = window.testOriginalValidate;
    App.runValidation();
  });
});

test('error navigation honors motion preferences and crosses wizard steps', async ({ page }) => {
  await openFreshEditor(page);
  await page.locator('#mode-wizard').click();
  await page.evaluate(() => Wizard.goToStep(3));
  await page.locator('#mode-form').click();
  await page.locator('#mode-wizard').click();

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedTransitions = await page.locator(
    '.mode-btn, .drop-zone, .form-section-toggle .toggle-icon'
  ).evaluateAll(elements => elements.map(element => ({
    duration: getComputedStyle(element).transitionDuration,
    delay: getComputedStyle(element).transitionDelay
  })));
  expect(reducedTransitions.every(transition =>
    Number.parseFloat(transition.duration) <= 0.00001
      && Number.parseFloat(transition.delay) === 0
  )).toBe(true);
  await page.evaluate(() => {
    window.testOriginalValidate = YamlExport.validate;
    YamlExport.validate = () => [{ path: 'header.url', message: 'must be a URL' }];
    App.runValidation();
    window.testScrollBehavior = null;
    const original = Element.prototype.scrollIntoView;
    window.testOriginalScrollIntoView = original;
    Element.prototype.scrollIntoView = function (options) {
      window.testScrollBehavior = options.behavior;
    };
  });
  await page.locator('.error-link').click();
  await expect(page.locator('.wizard-progress-item[aria-current="step"]')).toContainText('Header');
  await expect(
    page.locator('#wizard-editor [data-path="header.url"] input')
  ).toBeFocused();
  expect(await page.evaluate(() => window.testScrollBehavior)).toBe('auto');

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('.error-link').click();
  expect(await page.evaluate(() => window.testScrollBehavior)).toBe('smooth');
  await page.evaluate(() => {
    Element.prototype.scrollIntoView = window.testOriginalScrollIntoView;
    YamlExport.validate = window.testOriginalValidate;
  });
});

test('form and wizard expose valid DOM and platform accessibility trees', async ({
  page,
  browserName
}) => {
  await openFreshEditor(page);

  const labelledGroups = await page.locator('[role="group"][aria-labelledby]').evaluateAll(
    groups => groups.map(group => {
      const label = document.getElementById(group.getAttribute('aria-labelledby'));
      return Boolean(label && label.textContent.trim());
    })
  );
  expect(labelledGroups.length).toBeGreaterThan(0);
  expect(labelledGroups.every(Boolean)).toBe(true);

  let results = await new AxeBuilder({ page }).withTags([
    'wcag2a',
    'wcag2aa',
    'wcag21a',
    'wcag21aa'
  ]).analyze();
  expect(results.violations).toEqual([]);

  await page.locator('#mode-wizard').click();
  await expect(page.locator('#wizard-progress')).not.toHaveAttribute('tabindex');
  await expect(page.locator('[aria-current="step"]')).toHaveCount(1);
  results = await new AxeBuilder({ page }).withTags([
    'wcag2a',
    'wcag2aa',
    'wcag21a',
    'wcag21aa'
  ]).analyze();
  expect(results.violations).toEqual([]);

  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    const tree = await cdp.send('Accessibility.getFullAXTree');
    const value = property => property && property.value;
    const tabs = tree.nodes.filter(node => value(node.role) === 'tab');
    const groups = tree.nodes.filter(node => value(node.role) === 'group');
    const steps = tree.nodes
      .map(node => ({ role: value(node.role), name: value(node.name) || '' }))
      .filter(node => node.role === 'StaticText' && /^Step \d+:/.test(node.name));

    expect(tabs).toHaveLength(2);
    expect(tabs.every(node => Boolean(value(node.name)))).toBe(true);
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every(node => Boolean(value(node.name)))).toBe(true);
    expect(steps).toHaveLength(6);
    expect(steps.filter(node => node.name === 'Step 1: Header')).toHaveLength(1);
    expect(steps.filter(node => node.name.endsWith(', upcoming'))).toHaveLength(5);

    await page.emulateMedia({ forcedColors: 'active' });
    await page.locator('#mode-form').focus();
    await page.keyboard.press('End');
    await expect(page.locator('#mode-wizard')).toBeFocused();
    const focusStyle = await page.locator('#mode-wizard').evaluate(element => ({
      outlineStyle: getComputedStyle(element).outlineStyle,
      outlineWidth: getComputedStyle(element).outlineWidth
    }));
    expect(focusStyle.outlineStyle).not.toBe('none');
    expect(Number.parseFloat(focusStyle.outlineWidth)).toBeGreaterThan(0);
    await page.emulateMedia({ forcedColors: 'none' });
  }

  const ids = await page.locator('[id]').evaluateAll(elements => elements.map(item => item.id));
  expect(new Set(ids).size).toBe(ids.length);
});

test('an imported populated document keeps dynamic arrays labelled and unique', async ({
  page
}) => {
  await routeSchemaRequests(page);
  await page.goto('/editor/');
  await expect(page.locator('#status-text')).toHaveText('Schema loaded');
  await page.locator('#file-input').setInputFiles(fullExamplePath);
  await expect(page.locator('#editor-main')).toBeVisible();

  const arrayItems = page.locator('.array-item[role="group"]');
  expect(await arrayItems.count()).toBeGreaterThan(0);
  const labels = await arrayItems.evaluateAll(items =>
    items.map(item => item.getAttribute('aria-label'))
  );
  expect(labels.every(Boolean)).toBe(true);

  const repositories = page.locator('[data-path="project.repositories"]');
  const repositoryItems = repositories.locator(':scope > .array-items > .array-item');
  await expect(repositoryItems).toHaveCount(2);
  await expect(repositoryItems.nth(0)).toHaveAttribute('aria-label', 'Repositories item 1');
  await expect(repositoryItems.nth(1)).toHaveAttribute('aria-label', 'Repositories item 2');

  await repositoryItems.nth(0).locator(':scope > .array-item-controls button').click();
  await expect(repositoryItems).toHaveCount(1);
  await expect(repositoryItems.nth(0)).toHaveAttribute('data-path', 'project.repositories[0]');
  await expect(repositoryItems.nth(0)).toHaveAttribute('aria-label', 'Repositories item 1');
  await expect(repositoryItems.nth(0).locator(':scope > .array-item-controls button'))
    .toHaveAttribute('aria-label', 'Cannot remove item 1; at least 1 item is required');

  const addButton = repositories.locator(':scope > .array-field-header button');
  await addButton.click();
  await expect(repositoryItems).toHaveCount(2);
  await expect(repositoryItems.nth(1)).toHaveAttribute('data-path', 'project.repositories[1]');
  await expect(repositoryItems.nth(1)).toHaveAttribute('aria-label', 'Repositories item 2');

  const ids = await page.locator('[id]').evaluateAll(elements => elements.map(item => item.id));
  expect(new Set(ids).size).toBe(ids.length);
  const results = await new AxeBuilder({ page }).withTags([
    'wcag2a',
    'wcag2aa',
    'wcag21a',
    'wcag21aa'
  ]).analyze();
  expect(results.violations).toEqual([]);
});

test('a valid document survives a browser export and re-import round trip', async ({
  page
}) => {
  await routeSchemaRequests(page);
  await page.goto('/editor/');
  await expect(page.locator('#status-text')).toHaveText('Schema loaded');
  await page.locator('#file-input').setInputFiles(minimumExamplePath);
  await expect(page.locator('#status-text')).toHaveText('Valid');

  const firstDownloadPromise = page.waitForEvent('download');
  await page.locator('#download-yaml-btn').click();
  const firstDownload = await firstDownloadPromise;
  const exportedText = fs.readFileSync(await firstDownload.path(), 'utf8');
  const originalData = yaml.load(fs.readFileSync(minimumExamplePath, 'utf8'));
  expect(yaml.load(exportedText)).toEqual(originalData);

  await page.locator('#file-input').setInputFiles({
    name: 'security-insights-round-trip.yml',
    mimeType: 'application/yaml',
    buffer: Buffer.from(exportedText)
  });
  await expect(page.locator('#status-text')).toHaveText('Valid');

  const secondDownloadPromise = page.waitForEvent('download');
  await page.locator('#download-yaml-btn').click();
  const secondDownload = await secondDownloadPromise;
  const secondExport = fs.readFileSync(await secondDownload.path(), 'utf8');
  expect(yaml.load(secondExport)).toEqual(originalData);
});

test('browser harness serves only regular editor assets', async ({ request }) => {
  await expect((await request.get('/editor/js/app.js')).status()).toBe(200);
  await expect((await request.get('/editor/css/')).status()).toBe(404);
  await expect((await request.get('/package.json')).status()).toBe(404);
  await expect((await request.get('/editor/%E0%A4%A')).status()).toBe(400);
});
