const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const index = read('views/index.ejs');
const admin = read('views/admin.ejs');
const server = read('server.js');
const intro = read('views/intro.ejs');
const products = JSON.parse(read('data/tenants/eukolakis/products.json'));
const config = JSON.parse(read('data/tenants/eukolakis/config.json'));

const rollKit = products.find(p => p.builderType === 'step_by_step');
const kitOptions = rollKit ? rollKit.kitOptions : [];

// === Section 1: Skip / Navigation behavior ===

test('Step 1 is required and cannot be skipped', () => {
  assert.ok(rollKit, 'Roll Kit exists');
  const step1 = kitOptions[0];
  assert.ok(step1, 'Step 1 exists');
  assert.strictEqual(step1.required, true, 'Step 1 is required');
  assert.ok(!step1.allowSkip, 'Step 1 does not allow skip');
});

test('Steps 2-5 are optional and allowSkip is true', () => {
  for (let i = 1; i < kitOptions.length; i++) {
    const step = kitOptions[i];
    assert.ok(step.allowSkip === true, `Step ${i + 1} (${step.id}) has allowSkip: true`);
  }
});

test('Skip button visibility is driven by allowSkip', () => {
  assert.match(index, /canSkip = !g\.required && g\.allowSkip/);
  assert.match(index, /btnSkip\.style\.display = canSkip \? '' : 'none'/);
});

test('Skip handler deletes selection and advances step', () => {
  assert.match(index, /delete sbsState\.selections\[g\.id\]/);
  assert.match(index, /sbsState\.step \+= 1/);
});

test('Back button decrements step and re-renders', () => {
  assert.match(index, /sbsState\.step -= 1;\s*renderStep\(\)/);
});

test('Next button is disabled for required steps without selection', () => {
  assert.match(index, /btnNext\.disabled = g\.required && !sbsState\.selections\[g\.id\]/);
});

test('One option per step — radio-style selection replaces previous choice', () => {
  assert.match(index, /sbsState\.selections\[g\.id\] = c\.id/);
});

// === Section 2: Live summary sidebar ===

test('Summary sidebar renders "Η επιλογή μου" heading', () => {
  assert.match(index, /Η επιλογή μου/);
});

test('Summary shows thumbnails and prices for selected options', () => {
  assert.match(index, /sbs-sum-label.*img src.*sbs-sum-price/s);
});

test('Summary shows "Παράλειψη" with 0,00€ for skipped optional steps', () => {
  assert.match(index, /Παράλειψη/);
  assert.match(index, /0,00 &euro;/);
  assert.match(index, /gi < sbsState\.step && !g\.required && g\.allowSkip/);
});

test('Summary total accumulates only selected option deltas', () => {
  assert.match(index, /total \+= delta/);
  assert.match(index, /elTotal\.textContent = total\.toFixed\(2\)/);
});

test('Add-to-cart buttons are disabled until all required steps are valid', () => {
  assert.match(index, /allRequiredValid = groups\.every\(function\(g\) \{ return !g\.required \|\| !!sbsState\.selections\[g\.id\]; \}\)/);
  assert.match(index, /btnNext\.disabled = !allRequiredValid/);
  assert.match(index, /btnCartSidebar\.disabled = !allRequiredValid/);
});

// === Section 3: Builder config persistence ===

test('Admin has all builder config input fields', () => {
  assert.match(admin, /id="kit-bc-banner"/);
  assert.match(admin, /id="kit-bc-mobile-banner"/);
  assert.match(admin, /id="kit-bc-video"/);
  assert.match(admin, /id="kit-bc-show-video"/);
  assert.match(admin, /id="kit-bc-title-el"/);
  assert.match(admin, /id="kit-bc-title-en"/);
  assert.match(admin, /id="kit-bc-subtitle-el"/);
  assert.match(admin, /id="kit-bc-subtitle-en"/);
  assert.match(admin, /id="kit-bc-helper-el"/);
  assert.match(admin, /id="kit-bc-helper-en"/);
  assert.match(admin, /id="kit-bc-show-trust"/);
});

test('Builder config fields are bound via JS change listeners', () => {
  assert.match(admin, /bcMap.*bannerImage.*mobileBannerImage.*videoUrl.*title\.el.*title\.en.*subtitle\.el.*subtitle\.en.*helperText\.el.*helperText\.en/);
  assert.match(admin, /showVideo.*showTrustRow/);
});

test('syncBuilderConfigPanel loads all fields from product data', () => {
  assert.match(admin, /kit-bc-banner.*bannerImage/);
  assert.match(admin, /kit-bc-mobile-banner.*mobileBannerImage/);
  assert.match(admin, /kit-bc-video.*videoUrl/);
  assert.match(admin, /kit-bc-show-video.*showVideo/);
  assert.match(admin, /kit-bc-helper-el/);
  assert.match(admin, /kit-bc-helper-en/);
  assert.match(admin, /kit-bc-show-trust.*showTrustRow/);
});

test('normalizeProductRecord preserves mobileBannerImage, showVideo, showTrustRow', () => {
  assert.match(server, /mobileBannerImage:\s*normalizeMediaPath/);
  assert.match(server, /showVideo:\s*normalized\.builderConfig\.showVideo\s*!==\s*false/);
  assert.match(server, /showTrustRow:\s*normalized\.builderConfig\.showTrustRow\s*!==\s*false/);
});

// === Section 4: Hero visibility controls ===

test('Block visibility hero toggle exists in admin and server', () => {
  assert.match(admin, /name="homepageBlockHero"/);
  assert.match(server, /blockVisibility\.hero/);
});

test('Hero section respects blockVisibility.hero gate in storefront', () => {
  assert.match(index, /homeBlockVisibility\.hero !== false/);
});

test('heroOverlay.showOverlay master toggle is persisted by server', () => {
  assert.match(server, /heroOverlay\.showOverlay = readCheckbox\(req\.body, 'heroOverlayShowOverlay'/);
});

test('heroOverlay.showOverlay has admin checkbox', () => {
  assert.match(admin, /name="heroOverlayShowOverlay"/);
});

test('showOverlay master toggle wraps all overlay elements in storefront', () => {
  assert.match(index, /showOverlay !== false/);
});

test('Per-element hero visibility toggles exist and persist', () => {
  const elements = ['showKicker', 'showTitle', 'showSubtitle', 'showPrimaryCta', 'showSecondaryCta'];
  for (const el of elements) {
    assert.match(server, new RegExp(`heroOverlay\\.${el}\\s*=\\s*readCheckbox`), `${el} persists`);
    assert.match(admin, new RegExp(`heroOverlay${el.charAt(0).toUpperCase() + el.slice(1)}`), `${el} in admin`);
  }
});

// === Section 5: Hero CTA customization ===

test('Primary CTA label EL/EN persists', () => {
  assert.match(server, /heroPrimaryCta\.label\s*=\s*buildTranslatableFromBody\(req\.body, 'heroPrimaryCtaLabel'/);
  assert.match(admin, /name="heroPrimaryCtaLabel_el"/);
  assert.match(admin, /name="heroPrimaryCtaLabel_en"/);
});

test('Primary CTA action (kit-launch/link) persists', () => {
  assert.match(server, /heroPrimaryCtaAction/);
  assert.match(server, /\['kit-launch', 'link'\]/);
});

test('Primary CTA URL persists', () => {
  assert.match(server, /heroPrimaryCtaUrl/);
  assert.match(admin, /name="heroPrimaryCtaUrl"/);
});

test('Secondary CTA label and URL persist', () => {
  assert.match(server, /heroSecondaryCta\.label\s*=\s*buildTranslatableFromBody/);
  assert.match(server, /heroSecondaryCtaUrl/);
  assert.match(admin, /name="heroSecondaryCtaLabel_el"/);
  assert.match(admin, /name="heroSecondaryCtaLabel_en"/);
});

// === Section 6: Strict asset separation ===

test('Builder banner uses builderConfig.bannerImage, not hero image', () => {
  assert.match(index, /bc\.bannerImage/);
  const bannerInit = index.match(/var bannerSrc = (.*?);/);
  assert.ok(bannerInit, 'Banner source is assigned');
  assert.match(bannerInit[1], /bc\.bannerImage/, 'Banner comes from builderConfig, not hero');
});

test('Intro image uses introImageSource logic, not hero image', () => {
  assert.match(intro, /introImageSource/);
  assert.match(intro, /homepage\.introImage|config\.logoPath/);
  assert.doesNotMatch(intro, /headerBanner/);
});

test('Builder banner, hero image, and intro image are independent admin fields', () => {
  assert.match(admin, /id="kit-bc-banner"/);
  assert.match(admin, /name="homepageHeroImage"/);
  assert.match(admin, /name="homepageIntroImageSource"/);
});

test('Product imageUrl and builder banner are separate admin fields', () => {
  assert.ok(rollKit.builderConfig, 'builderConfig exists');
  assert.ok('bannerImage' in rollKit.builderConfig, 'bannerImage is a distinct config field');
  assert.ok('imageUrl' in rollKit, 'imageUrl is a product-level field');
});

// === Section 7: Admin builder editor usability ===

test('Admin has add/delete for option groups', () => {
  assert.match(admin, /addKitGroup|kg-id/);
  assert.match(admin, /removeKitGroup/);
});

test('Admin has add/delete for choices', () => {
  assert.match(admin, /addLinkedChoice/);
  assert.match(admin, /removeKitChoice/);
});

test('Admin option group form includes required and allowSkip toggles', () => {
  assert.match(admin, /id="kg-required"/);
  assert.match(admin, /id="kg-allow-skip"/);
});

test('Groups are sorted by numeric order field', () => {
  assert.match(admin, /kitOptions\.sort\(function\(a, b\)\s*\{ return \(Number\(a\.order\)\s*\|\|\s*0\)\s*-\s*\(Number\(b\.order\)\s*\|\|\s*0\)/);
});

// === Section 8: Roll Kit exact 5-step flow ===

test('Roll Kit has exactly 5 steps', () => {
  assert.strictEqual(kitOptions.length, 5, 'Kit has 5 option groups');
});

test('Roll Kit step labels are bilingual {el, en} objects', () => {
  for (const group of kitOptions) {
    assert.ok(group.label && typeof group.label === 'object', `Group ${group.id} label is an object`);
    assert.ok(group.label.el, `Group ${group.id} has Greek label`);
    assert.ok(group.label.en, `Group ${group.id} has English label`);
  }
});

test('Roll Kit is parts_only mode', () => {
  assert.strictEqual(rollKit.kitPayMode, 'parts_only');
});

test('Each Roll Kit step has at least one choice with linkedProductId', () => {
  for (const group of kitOptions) {
    const linked = group.choices.filter(c => c.linkedProductId);
    assert.ok(linked.length > 0, `Group ${group.id} has linked product choices`);
  }
});

// === Section 9: Server-side price validation ===

test('Server validates kit checkout options against kitOptions', () => {
  assert.match(server, /found\.kitOptions\.find.*g\.id === opt\.groupId/s);
  assert.match(server, /group\.choices.*find.*c\.id === opt\.choiceId/s);
});

test('Server rejects missing required groups', () => {
  assert.match(server, /missing.*required|required.*miss/i);
});

test('Server recomputes prices server-side, not trusting client total', () => {
  assert.match(server, /serverPrice/);
  assert.match(server, /selectedOptions\.reduce.*priceDelta/s);
});

// === Section 10: Cart snapshot ===

test('addToCartFromBuilder builds complete builderSnapshot', () => {
  assert.match(index, /type: 'step_by_step'/);
  assert.match(index, /builderType: 'step_by_step'/);
  assert.match(index, /productId: sbsState\.product\.id/);
  assert.match(index, /steps: groups\.map/);
  assert.match(index, /total: finalPrice/);
  assert.match(index, /timestamp: new Date\(\)\.toISOString\(\)/);
});

test('Snapshot includes stepId, stepLabel, optionId, optionLabel, linkedProductId, price per step', () => {
  assert.match(index, /stepId:\s*o\.groupId/);
  assert.match(index, /stepTitle:\s*o\.groupLabel/);
  assert.match(index, /optionId:\s*o\.choiceId/);
  assert.match(index, /optionTitle:\s*o\.choiceLabel/);
  assert.match(index, /linkedProductId:\s*o\.linkedProductId/);
  assert.match(index, /linePrice:\s*o\.priceDelta/);
});

test('Parts-only mode adds individual linked products to cart', () => {
  assert.match(index, /kitPayMode === 'parts_only'/);
  assert.match(index, /selected\.filter.*linkedProductId.*forEach/s);
  assert.match(index, /thrcAddToCart.*id: linked\.id/s);
});

// === Section 11: Order snapshot immutability ===

test('builderSnapshot includes timestamp for historical reference', () => {
  assert.match(index, /timestamp:\s*new Date\(\)\.toISOString\(\)/);
});

test('Snapshot is attached to cart item, not derived from live product data', () => {
  assert.match(index, /builderSnapshot:\s*snapshot/);
  assert.ok(index.includes('steps: groups.map'), 'Steps are pre-computed from selected choices');
});

// === Section 12: Spare parts ===

test('Spare parts category filter exists', () => {
  assert.match(index, /spare-filter-search/);
  assert.match(index, /spare-filter-tag/);
  assert.match(index, /spare-filter-price/);
});

test('All kit-linked products exist in products.json', () => {
  const linkedIds = new Set();
  for (const group of kitOptions) {
    for (const choice of group.choices) {
      if (choice.linkedProductId) linkedIds.add(choice.linkedProductId);
    }
  }
  assert.ok(linkedIds.size > 0, 'Kit has linked products');
  for (const id of linkedIds) {
    const part = products.find(p => p.id === id);
    assert.ok(part, `Linked product ${id} exists in catalog`);
    assert.ok(part.type !== 'KIT', `Linked product ${id} is not a KIT`);
  }
});

// === Section 13: Products.json churn ===

test('Products.json has expected product structure', () => {
  const kits = products.filter(p => p.type === 'KIT');
  const nonKits = products.filter(p => p.type !== 'KIT');
  assert.ok(kits.length >= 1, 'At least 1 KIT');
  assert.ok(nonKits.length >= 10, 'At least 10 non-KIT products');
  assert.strictEqual(products.length, 21, 'Total product count is 21');
});

// === Section 14: Responsive ===

test('SBS builder has responsive breakpoint at 700px', () => {
  assert.match(index, /@media.*max-width:\s*700px/);
});

test('SBS builder body uses grid layout with summary sidebar', () => {
  assert.match(index, /sbs-builder-body.*grid-template-columns:\s*1fr\s+280px/s);
});

// === Section 16: Builder bilingual support ===

test('hydrateKitProduct resolves bilingual labels via resolveTranslatable', () => {
  assert.match(server, /resolveTranslatable\(choice\.label/);
  assert.match(server, /resolveTranslatable\(choice\.description/);
  assert.match(server, /resolveTranslatable\(group\.label/);
});

test('SBS builder client resolves bilingual fields via resolveF', () => {
  assert.match(index, /function resolveF\(v\)/);
  assert.match(index, /resolveF\(g\.label\)/);
  assert.match(index, /resolveF\(choice\.label\)/);
  assert.match(index, /resolveF\(bc\.title\)/);
  assert.match(index, /resolveF\(bc\.subtitle\)/);
});

test('helperText in products.json is bilingual object', () => {
  const bc = rollKit.builderConfig;
  assert.ok(bc.helperText && typeof bc.helperText === 'object', 'helperText is an object');
  assert.ok(bc.helperText.el, 'helperText has Greek');
  assert.ok(bc.helperText.en, 'helperText has English');
});

test('Choice labels and descriptions in products.json are bilingual', () => {
  for (const group of kitOptions) {
    for (const choice of group.choices) {
      if (choice.label && typeof choice.label === 'object') {
        assert.ok(choice.label.el || choice.label.en, `Choice ${choice.id} has bilingual label`);
      }
    }
  }
});

// === Section 3 extended: builderType ===

test('builderType is validated to classic or step_by_step', () => {
  assert.match(server, /\['classic', 'step_by_step'\]\.includes\(_bt\)/);
});

test('Admin has builderType select with both options', () => {
  assert.match(admin, /id="kit-builder-type"/);
  assert.match(admin, /value="classic"/);
  assert.match(admin, /value="step_by_step"/);
});

// XSS prevention
test('SBS builder escapes attribute values to prevent XSS', () => {
  assert.match(index, /function escAttr\(s\)/);
  assert.match(index, /escAttr\(resolveF\(c\.label\)\)/);
  assert.match(index, /escAttr\(resolveF\(g\.label\)\)/);
});

// === Section 19a: Admin step/group controls ===

test('Admin has moveKitGroup function for reordering steps', () => {
  assert.match(admin, /window\.moveKitGroup\s*=\s*function\s*\(idx,\s*dir\)/);
});

test('moveKitGroup swaps array elements without regenerating IDs', () => {
  assert.match(admin, /var tmp = opts\[idx\];\s*opts\[idx\] = opts\[target\];\s*opts\[target\] = tmp/);
  assert.doesNotMatch(admin, /moveKitGroup[\s\S]{0,200}generateId/);
});

test('Admin has moveKitChoice function for reordering choices', () => {
  assert.match(admin, /window\.moveKitChoice\s*=\s*function\s*\(idx,\s*dir\)/);
});

test('moveKitChoice swaps array elements without regenerating IDs', () => {
  assert.match(admin, /moveKitChoice[\s\S]{0,300}var tmp = choices\[idx\]/);
  assert.doesNotMatch(admin, /moveKitChoice[\s\S]{0,200}generateId/);
});

test('Admin has editKitGroup for inline field editing with dot-notation', () => {
  assert.match(admin, /window\.editKitGroup\s*=\s*function\s*\(idx,\s*path,\s*value\)/);
  assert.match(admin, /parts = path\.split\('\.'\)/);
});

test('Admin has editKitChoice for inline field editing with dot-notation', () => {
  assert.match(admin, /window\.editKitChoice\s*=\s*function\s*\(idx,\s*path,\s*value\)/);
});

test('Group cards render move up/down buttons', () => {
  assert.match(admin, /moveKitGroup\(.*,\s*-1\)/);
  assert.match(admin, /moveKitGroup\(.*,\s*1\)/);
});

test('Choice cards render move up/down buttons', () => {
  assert.match(admin, /moveKitChoice\(.*,\s*-1\)/);
  assert.match(admin, /moveKitChoice\(.*,\s*1\)/);
});

test('Group inline editing includes label EL/EN, description EL/EN, required, allowSkip', () => {
  assert.match(admin, /editKitGroup\(.*\\?'label\.el\\?'/);
  assert.match(admin, /editKitGroup\(.*\\?'label\.en\\?'/);
  assert.match(admin, /editKitGroup\(.*\\?'description\.el\\?'/);
  assert.match(admin, /editKitGroup\(.*\\?'description\.en\\?'/);
  assert.match(admin, /editKitGroup\(.*\\?'required\\?'/);
  assert.match(admin, /editKitGroup\(.*\\?'allowSkip\\?'/);
});

test('Choice inline editing includes label EL/EN, description EL/EN, priceDelta', () => {
  assert.match(admin, /editKitChoice\(.*\\?'label\.el\\?'/);
  assert.match(admin, /editKitChoice\(.*\\?'label\.en\\?'/);
  assert.match(admin, /editKitChoice\(.*\\?'description\.el\\?'/);
  assert.match(admin, /editKitChoice\(.*\\?'description\.en\\?'/);
  assert.match(admin, /editKitChoice\(.*\\?'priceDelta\\?'/);
});

// === Section 19b: Visual flag persistence ===

test('normalizeProductRecord preserves showTitle, showSubtitle, showHelperText', () => {
  assert.match(server, /showTitle:\s*normalized\.builderConfig\.showTitle\s*!==\s*false/);
  assert.match(server, /showSubtitle:\s*normalized\.builderConfig\.showSubtitle\s*!==\s*false/);
  assert.match(server, /showHelperText:\s*normalized\.builderConfig\.showHelperText\s*!==\s*false/);
});

test('Admin has showTitle, showSubtitle, showHelperText checkboxes', () => {
  assert.match(admin, /id="kit-bc-show-title"/);
  assert.match(admin, /id="kit-bc-show-subtitle"/);
  assert.match(admin, /id="kit-bc-show-helper"/);
});

test('syncBuilderConfigPanel loads showTitle, showSubtitle, showHelperText from product', () => {
  assert.match(admin, /kit-bc-show-title.*showTitle/);
  assert.match(admin, /kit-bc-show-subtitle.*showSubtitle/);
  assert.match(admin, /kit-bc-show-helper.*showHelperText/);
});

test('Checkbox change listeners update builderConfig for all show flags', () => {
  assert.match(admin, /showTitle.*showSubtitle.*showHelperText/s);
});

// === Section 19c: Mobile banner fallback ===

test('Storefront uses mobileBannerImage on mobile with fallback to bannerImage', () => {
  assert.match(index, /isMobile && bc\.mobileBannerImage/);
  assert.match(index, /bannerSrc = bc\.bannerImage/);
});

test('isMobile detection exists in storefront', () => {
  assert.match(index, /var isMobile = window\.innerWidth <= 700/);
});

// === Section 19d: helperText rendering ===

test('Storefront renders helperText element', () => {
  assert.match(index, /id="sbs-helper-text"/);
  assert.match(index, /var elHelperText = document\.getElementById\('sbs-helper-text'\)/);
});

test('helperText uses resolveF and never outputs [object Object]', () => {
  assert.match(index, /resolveF\(bc\.helperText\)/);
  assert.match(index, /elHelperText\.textContent = helperText/);
  assert.doesNotMatch(index, /elHelperText\.textContent = bc\.helperText[^.]/);
});

test('helperText respects showHelperText visibility flag', () => {
  assert.match(index, /bc\.showHelperText !== false && helperText/);
});

// === Section 19e: Title/subtitle visibility flags ===

test('showTitle flag controls title visibility in storefront', () => {
  assert.match(index, /bc\.showTitle !== false/);
  assert.match(index, /elTitle\.style\.display/);
});

test('showSubtitle flag controls subtitle visibility in storefront', () => {
  assert.match(index, /bc\.showSubtitle !== false/);
  assert.match(index, /elSubtitle\.style\.display/);
});

// === Section 19f: Stable IDs ===

test('All kitOption group IDs in products.json are unique', () => {
  const allGroupIds = [];
  for (const p of products) {
    if (p.kitOptions) {
      for (const g of p.kitOptions) allGroupIds.push(g.id);
    }
  }
  const unique = new Set(allGroupIds);
  assert.strictEqual(unique.size, allGroupIds.length, 'No duplicate group IDs');
});

test('All kitOption choice IDs within each group are unique', () => {
  for (const p of products) {
    if (!p.kitOptions) continue;
    for (const g of p.kitOptions) {
      const ids = g.choices.map(c => c.id);
      const unique = new Set(ids);
      assert.strictEqual(unique.size, ids.length, `Group ${g.id} has unique choice IDs`);
    }
  }
});

test('All product IDs in products.json are unique', () => {
  const ids = products.map(p => p.id);
  const unique = new Set(ids);
  assert.strictEqual(unique.size, ids.length, 'No duplicate product IDs');
});

// === Section 19g: No fake skip products ===

test('No fake skip product exists in products.json', () => {
  const skip = products.find(p => /skip|παράλειψη/i.test(p.id) || /skip|παράλειψη/i.test(JSON.stringify(p.name)));
  assert.ok(!skip, 'No fake skip/Παράλειψη product in catalog');
});

test('allowSkip is the canonical skip mechanism, not a fake product', () => {
  assert.match(index, /g\.allowSkip/);
  const fakeSkip = kitOptions.flatMap(g => g.choices).find(c => /skip|παράλειψη/i.test(c.id));
  assert.ok(!fakeSkip, 'No fake skip choice inside kitOptions');
});

// Supplementary deterministic UI contract checks; checkout security is exercised
// end-to-end in builder-behavior.test.js.
test('SBS storefront omits disabled choices from rendering', () => {
  assert.match(index, /choices \|\| \[\]\)\.filter\(function\(c\) \{ return c\.enabled !== false; \}\)/);
});

test('Assistant is left anchored on desktop and mobile without an active right anchor', () => {
  const assistantCss = index.slice(index.indexOf('#thrc-chat-fab {'), index.indexOf('</style>', index.indexOf('#thrc-chat-fab {')));
  assert.match(assistantCss, /left: 20px; right: auto/);
  assert.match(assistantCss, /left: 12px; right: auto; bottom: calc\(12px \+ env\(safe-area-inset-bottom\)\)/);
  assert.doesNotMatch(assistantCss, /right: (?!auto)[^;]+/);
});

test('Cart stack is above assistant and cart-open collapses assistant', () => {
  const cart = read('views/_cart.ejs');
  const assistantZ = Number(index.match(/#thrc-chat-panel \{[\s\S]*?z-index: (\d+)/)[1]);
  const cartZ = Number(cart.match(/#cart-panel \{[\s\S]*?z-index: (\d+)/)[1]);
  assert.ok(cartZ > assistantZ);
  assert.match(cart, /dispatchEvent\(new CustomEvent\('thrc:cart-open'\)\)/);
  assert.match(index, /addEventListener\('thrc:cart-open',[\s\S]*?panel\.hidden = true/);
});
