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
  assert.match(admin, /bcMap[\s\S]*logoImage[\s\S]*bannerImage[\s\S]*mobileBannerImage[\s\S]*videoUrl[\s\S]*title\.el[\s\S]*subtitle\.el[\s\S]*helperText\.el/);
  assert.match(admin, /showFlags[\s\S]*showVideoCTA[\s\S]*showTrustRow/);
});

test('syncBuilderConfigPanel loads all fields from product data', () => {
  assert.match(admin, /kit-bc-logo.*logoImage/);
  assert.match(admin, /kit-bc-mobile-logo.*mobileLogoImage/);
  assert.match(admin, /kit-bc-show-logo.*showLogo/);
  assert.match(admin, /kit-bc-logo-position.*logoPosition/);
  assert.match(admin, /kit-bc-logo-size.*logoSize/);
  assert.match(admin, /kit-bc-banner.*bannerImage/);
  assert.match(admin, /kit-bc-mobile-banner.*mobileBannerImage/);
  assert.match(admin, /kit-bc-video.*videoUrl/);
  assert.match(admin, /kit-bc-show-video.*showVideoCTA/);
  assert.match(admin, /kit-bc-helper-el/);
  assert.match(admin, /kit-bc-helper-en/);
  assert.match(admin, /kit-bc-slogan-el.*slogan/);
  assert.match(admin, /kit-bc-slogan2-el.*sloganSecondary/);
  assert.match(admin, /kit-bc-show-slogan.*showSlogan/);
  assert.match(admin, /kit-bc-show-trust.*showTrustRow/);
  assert.match(admin, /kit-bc-summary-sub-el.*summarySubtitle/);
  assert.match(admin, /kit-bc-vcta-title-el.*videoCTATitle/);
  assert.match(admin, /kit-bc-vcta-sub-el.*videoCTASubtitle/);
  assert.match(admin, /renderBenefitsList/);
  assert.match(admin, /renderTrustList/);
});

test('normalizeProductRecord preserves mobileBannerImage, showVideo, showTrustRow', () => {
  assert.match(server, /mobileBannerImage:\s*normalizeMediaPath/);
  assert.match(server, /showVideo:\s*_bc\.showVideo\s*!==\s*false/);
  assert.match(server, /showTrustRow:\s*_bc\.showTrustRow\s*!==\s*false/);
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
  assert.match(intro, /headerBanner|logoPath/);
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
  assert.match(index, /steps: selected\.map/);
  assert.match(index, /total: finalPrice/);
  assert.match(index, /timestamp: new Date\(\)\.toISOString\(\)/);
});

test('Snapshot includes stepId, stepLabel, optionId, optionLabel, linkedProductId, price per step', () => {
  assert.match(index, /stepId:\s*o\.groupId/);
  assert.match(index, /stepLabel:\s*o\.groupLabel/);
  assert.match(index, /optionId:\s*o\.choiceId/);
  assert.match(index, /optionLabel:\s*o\.choiceLabel/);
  assert.match(index, /linkedProductId:\s*o\.linkedProductId/);
  assert.match(index, /price:\s*o\.priceDelta/);
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
  assert.ok(index.includes('steps: selected.map'), 'Steps are pre-computed from selected choices');
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
  assert.match(index, /sbs-builder-body.*grid-template-columns:\s*minmax\(0,\s*72fr\)\s+minmax\(280px,\s*28fr\)/s);
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
  assert.match(server, /showTitle:\s*_bc\.showTitle\s*!==\s*false/);
  assert.match(server, /showSubtitle:\s*_bc\.showSubtitle\s*!==\s*false/);
  assert.match(server, /showHelperText:\s*_bc\.showHelperText\s*!==\s*false/);
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
  assert.match(admin, /showLogo.*showSlogan.*showVideoCTA.*showTitle.*showSubtitle.*showHelperText.*showTrustRow/s);
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

// === Section 20: Builder Logo independence ===

test('Builder logo is independent from site Header Logo', () => {
  assert.match(index, /bc\.logoImage/);
  assert.match(index, /bc\.showLogo/);
  assert.doesNotMatch(index, /openSbs[\s\S]{0,500}headerLogo|openSbs[\s\S]{0,500}config\.logo/);
});

test('Builder logo uses builderConfig.logoImage not header logo', () => {
  const bc = rollKit.builderConfig;
  assert.ok('logoImage' in bc, 'logoImage field exists in builderConfig');
  assert.ok('mobileLogoImage' in bc, 'mobileLogoImage field exists');
  assert.ok('showLogo' in bc, 'showLogo field exists');
});

test('normalizeProductRecord preserves logo fields with allowAbsoluteUrl', () => {
  assert.match(server, /logoImage:\s*normalizeMediaPath\(_bc\.logoImage/);
  assert.match(server, /mobileLogoImage:\s*normalizeMediaPath\(_bc\.mobileLogoImage/);
  assert.match(server, /showLogo:\s*_bc\.showLogo\s*!==\s*false/);
});

test('Logo position validated to left/center/right', () => {
  assert.match(server, /\['left','center','right'\]\.includes\(_bc\.logoPosition\)/);
});

test('Logo size validated to small/medium/large', () => {
  assert.match(server, /\['small','medium','large'\]\.includes\(_bc\.logoSize\)/);
});

test('Admin has logo position and size controls', () => {
  assert.match(admin, /id="kit-bc-logo-position"/);
  assert.match(admin, /id="kit-bc-logo-size"/);
  assert.match(admin, /id="kit-bc-logo"/);
  assert.match(admin, /id="kit-bc-mobile-logo"/);
  assert.match(admin, /id="kit-bc-show-logo"/);
});

test('Mobile logo fallback works in storefront', () => {
  assert.match(index, /isMobile && bc\.mobileLogoImage/);
});

// === Section 21: Banner overlay with slogans ===

test('Banner has overlay with slogan elements', () => {
  assert.match(index, /sbs-banner-overlay/);
  assert.match(index, /sbs-banner-slogan/);
  assert.match(index, /sbs-banner-slogan-secondary/);
});

test('Slogans are bilingual EL/EN in builderConfig', () => {
  const bc = rollKit.builderConfig;
  assert.ok(bc.slogan && typeof bc.slogan === 'object', 'slogan is bilingual object');
  assert.ok(bc.sloganSecondary && typeof bc.sloganSecondary === 'object', 'sloganSecondary is bilingual');
});

test('normalizeProductRecord preserves slogan fields', () => {
  assert.match(server, /slogan:\s*_bc\.slogan/);
  assert.match(server, /sloganSecondary:\s*_bc\.sloganSecondary/);
  assert.match(server, /showSlogan:\s*_bc\.showSlogan\s*!==\s*false/);
});

test('Admin has slogan EL/EN inputs and showSlogan toggle', () => {
  assert.match(admin, /id="kit-bc-slogan-el"/);
  assert.match(admin, /id="kit-bc-slogan-en"/);
  assert.match(admin, /id="kit-bc-slogan2-el"/);
  assert.match(admin, /id="kit-bc-slogan2-en"/);
  assert.match(admin, /id="kit-bc-show-slogan"/);
});

// === Section 22: Benefits strip ===

test('Benefits strip renders with controlled icon set', () => {
  assert.match(index, /sbs-benefits/);
  assert.match(index, /sbs-benefit-icon/);
  assert.match(index, /benefitIcons/);
});

test('benefitIcons contains SVG for tools, quality, delivery, shield, support', () => {
  assert.match(index, /benefitIcons\s*=\s*\{/);
  assert.match(index, /tools:\s*'/);
  assert.match(index, /quality:\s*'/);
  assert.match(index, /delivery:\s*'/);
  assert.match(index, /shield:\s*'/);
  assert.match(index, /support:\s*'/);
});

test('Benefits are configurable array in builderConfig', () => {
  const bc = rollKit.builderConfig;
  assert.ok(Array.isArray(bc.benefits), 'benefits is array');
  assert.ok(bc.benefits.length >= 1, 'has at least one benefit');
  const b = bc.benefits[0];
  assert.ok(b.icon, 'benefit has icon');
  assert.ok(b.title && typeof b.title === 'object', 'benefit title is bilingual');
});

test('normalizeProductRecord preserves benefits array', () => {
  assert.match(server, /benefits:\s*Array\.isArray\(_bc\.benefits\)/);
});

test('Admin has benefits editor with add/remove', () => {
  assert.match(admin, /id="kit-bc-benefit-add"/);
  assert.match(admin, /id="kit-bc-benefit-icon"/);
  assert.match(admin, /id="kit-bc-benefit-el"/);
  assert.match(admin, /id="kit-bc-benefit-en"/);
  assert.match(admin, /renderBenefitsList/);
  assert.match(admin, /data-benefit-rm/);
});

// === Section 23: Stepper visual parity ===

test('Progress stepper uses numbered circles with connecting lines', () => {
  assert.match(index, /sbs-step-num/);
  assert.match(index, /sbs-progress-line/);
});

test('Done steps show check SVG instead of number', () => {
  assert.match(index, /svg.*viewBox.*M9 16\.17/s);
});

test('Step labels are short (max 2 words) below circles', () => {
  assert.match(index, /sbs-step-label/);
  assert.match(index, /parts\.slice\(0,\s*2\)\.join/);
});

// === Section 24: Step header with orange bar ===

test('Step header uses orange vertical bar prefix', () => {
  assert.match(index, /sbs-step-title-bar/);
  assert.match(index, /sbs-step-title-num/);
});

// === Section 25: Option card check markers ===

test('Option cards have check marker circles', () => {
  assert.match(index, /sbs-option-check/);
});

// === Section 26: Summary improvements ===

test('Summary rows have thumbnails, step labels, and Change buttons', () => {
  assert.match(index, /sbs-sum-thumb/);
  assert.match(index, /sbs-sum-step/);
  assert.match(index, /sbs-sum-change/);
});

test('Change button navigates to specific step', () => {
  assert.match(index, /data-step/);
  assert.match(index, /sbs-sum-change.*forEach/s);
  assert.match(index, /sbsState\.step = parseInt/);
});

test('Summary shows Παράλειψη/Skipped for skipped steps', () => {
  assert.match(index, /Παράλειψη/);
  assert.match(index, /Skipped/);
});

// === Section 27: Trust row ===

test('Trust row renders configurable items', () => {
  assert.match(index, /sbs-trust-row/);
  assert.match(index, /sbs-trust-item/);
  assert.match(index, /bc\.trustItems/);
});

test('Trust items are bilingual in builderConfig', () => {
  const bc = rollKit.builderConfig;
  assert.ok(Array.isArray(bc.trustItems), 'trustItems is array');
  assert.ok(bc.trustItems.length >= 1, 'has at least one trust item');
  const t = bc.trustItems[0];
  assert.ok(t.icon, 'trust item has icon');
  assert.ok(t.title && typeof t.title === 'object', 'trust item title is bilingual');
});

test('normalizeProductRecord preserves trustItems array', () => {
  assert.match(server, /trustItems:\s*Array\.isArray\(_bc\.trustItems\)/);
});

test('Admin has trust items editor with add/remove', () => {
  assert.match(admin, /id="kit-bc-trust-add"/);
  assert.match(admin, /id="kit-bc-trust-icon"/);
  assert.match(admin, /id="kit-bc-trust-el"/);
  assert.match(admin, /id="kit-bc-trust-en"/);
  assert.match(admin, /renderTrustList/);
  assert.match(admin, /data-trust-rm/);
});

// === Section 28: Video CTA ===

test('Video CTA shown only when showVideoCTA and videoUrl are set', () => {
  assert.match(index, /bc\.showVideoCTA && bc\.videoUrl/);
  assert.match(index, /sbs-video-cta/);
});

test('showVideoCTA defaults to false (opt-in)', () => {
  assert.match(server, /showVideoCTA:\s*_bc\.showVideoCTA\s*===\s*true/);
});

test('Admin has video CTA title/subtitle EL/EN fields', () => {
  assert.match(admin, /id="kit-bc-vcta-title-el"/);
  assert.match(admin, /id="kit-bc-vcta-title-en"/);
  assert.match(admin, /id="kit-bc-vcta-sub-el"/);
  assert.match(admin, /id="kit-bc-vcta-sub-en"/);
});

test('normalizeProductRecord preserves videoCTA fields', () => {
  assert.match(server, /videoCTATitle:\s*_bc\.videoCTATitle/);
  assert.match(server, /videoCTASubtitle:\s*_bc\.videoCTASubtitle/);
});

// === Section 29: Summary subtitle ===

test('Summary subtitle is bilingual and rendered', () => {
  assert.match(index, /sbs-summary-subtitle/);
  assert.match(index, /bc\.summarySubtitle/);
});

test('normalizeProductRecord preserves summarySubtitle', () => {
  assert.match(server, /summarySubtitle:\s*_bc\.summarySubtitle/);
});

test('Admin has summary subtitle EL/EN fields', () => {
  assert.match(admin, /id="kit-bc-summary-sub-el"/);
  assert.match(admin, /id="kit-bc-summary-sub-en"/);
});

// === Section 30: No global site elements in builder ===

test('Builder does not include main site navigation, search, account, or global cart', () => {
  const start = index.indexOf('id="sbs-builder-backdrop"');
  assert.ok(start !== -1, 'SBS builder section found');
  const sbsBlock = index.slice(start, start + 5000);
  assert.doesNotMatch(sbsBlock, /id="site-nav"|id="main-nav"|id="global-search"|id="account-icon"|id="global-cart"/);
});

test('Builder close-alt button works for non-banner mode', () => {
  assert.match(index, /id="sbs-close-alt"/);
  assert.match(index, /closeAltBtn.*addEventListener.*closeSbs/s);
});

// === Section 31: No raw IDs in stepper/summary ===

test('Stepper uses resolved labels, not raw group IDs', () => {
  assert.match(index, /resolveF\(g\.label\)/);
});

// === Section 32: Admin organized sections ===

test('Admin builder config has organized A/B/C/D sections', () => {
  assert.match(admin, /A\.\s*Branding/);
  assert.match(admin, /B\.\s*Hero.*Banner/);
  assert.match(admin, /C\.\s*Benefits/);
  assert.match(admin, /D\.\s*Summary/);
});

// === Section 33: Visual parity — no raw IDs visible ===

test('Stepper has short label lookup map for known step IDs', () => {
  assert.match(index, /stepShortLabels\s*=\s*\{/);
  assert.match(index, /'tampakiera-karoulaki':\s*\{\s*el:\s*'Ταμπακιέρα'/);
  assert.match(index, /'aristeri-plevra':\s*\{\s*el:\s*'Αριστερά'/);
  assert.match(index, /'dexia-plevra':\s*\{\s*el:\s*'Δεξιά'/);
  assert.match(index, /'tirantes':\s*\{\s*el:\s*'Τιράντες'/);
  assert.match(index, /'exoterika-stoper':\s*\{\s*el:\s*'Στόπερ'/);
});

test('Stepper short labels include EN translations', () => {
  assert.match(index, /en:\s*'Shutter Box'/);
  assert.match(index, /en:\s*'Left'/);
  assert.match(index, /en:\s*'Right'/);
  assert.match(index, /en:\s*'Straps'/);
  assert.match(index, /en:\s*'Stoppers'/);
});

test('renderProgress uses stepShortLabel helper, not raw g.id', () => {
  assert.match(index, /stepShortLabel\(g\)/);
  assert.doesNotMatch(index, /sbs-step-label[^<]*escAttr\(g\.id\)/);
});

test('Step heading uses localized label via resolveF(g.label)', () => {
  assert.match(index, /elStepTitle\.innerHTML[\s\S]*?escAttr\(resolveF\(g\.label\)\)/);
});

test('Summary rows use resolveF(g.label) for step names', () => {
  assert.match(index, /sbs-sum-step[^<]*escAttr\(resolveF\(g\.label\)\)/);
});

test('No raw step IDs rendered in visible builder text', () => {
  const visibleIdPattern = /textContent\s*=\s*['"]?(tampakiera-karoulaki|aristeri-plevra|dexia-plevra|tirantes|exoterika-stoper)/;
  assert.doesNotMatch(index, visibleIdPattern);
});

// === Section 34: Builder logo renders only from builderConfig ===

test('Builder logo rendered only when showLogo and logoImage configured', () => {
  assert.match(index, /bc\.showLogo\s*!==\s*false\s*&&\s*logoSrc/);
  assert.match(index, /bc\.logoImage/);
});

test('Builder logo hidden when logoImage is empty', () => {
  assert.match(index, /elBuilderLogo\.style\.display\s*=\s*'none'/);
});

// === Section 35: Benefits strip rendering ===

test('Benefits strip renders from builderConfig.benefits array', () => {
  assert.match(index, /bc\.benefits/);
  assert.match(index, /sbs-benefit-icon/);
  assert.match(index, /sbs-benefit-text/);
});

// === Section 36: Change action navigates to step ===

test('Change button sets sbsState.step and re-renders', () => {
  assert.match(index, /sbs-sum-change[\s\S]*?data-step/);
  assert.match(index, /sbsState\.step\s*=\s*parseInt\(btn\.getAttribute\('data-step'\)/);
});

// === Section 37: Trust row visibility ===

test('Trust row respects showTrustRow config flag', () => {
  assert.match(index, /bc\.showTrustRow\s*!==\s*false/);
});

// === Section 38: Video CTA visibility ===

test('Video CTA requires both showVideoCTA and videoUrl', () => {
  assert.match(index, /bc\.showVideoCTA\s*&&\s*bc\.videoUrl/);
});

// === Section 39: EL/EN bilingual rendering ===

test('Builder uses LANG variable for EL/EN rendering', () => {
  assert.match(index, /LANG\s*===\s*'el'/);
  assert.match(index, /Βήμα/);
  assert.match(index, /Step/);
});

// === Section 40: No global nav inside builder ===

test('Builder backdrop does not contain global nav elements', () => {
  const backdropStart = index.indexOf('id="sbs-builder-backdrop"');
  assert.ok(backdropStart > -1, 'sbs-builder-backdrop must exist');
  const backdropEnd = index.indexOf('<!-- /sbs-builder-backdrop -->', backdropStart);
  const builderSection = backdropEnd > -1
    ? index.substring(backdropStart, backdropEnd)
    : index.substring(backdropStart, backdropStart + 5000);
  assert.doesNotMatch(builderSection, /id="main-nav"/);
  assert.doesNotMatch(builderSection, /id="search-bar"/);
  assert.doesNotMatch(builderSection, /id="account-menu"/);
});

// === Section 41: Builder max-width and proportions ===

test('Builder max-width is 1500px for desktop', () => {
  assert.match(index, /\.sbs-builder\s*\{[^}]*max-width:\s*1500px/);
});

test('Builder body grid uses ~72/28 split', () => {
  assert.match(index, /\.sbs-builder-body\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*72fr\)\s+minmax\(280px,\s*28fr\)/);
});

// === Section 42: Mobile breakpoint at 768px ===

test('Mobile breakpoint is 768px', () => {
  assert.match(index, /@media\s*\(max-width:\s*768px\)/);
});

test('Mobile nav is sticky', () => {
  assert.match(index, /\.sbs-nav\s*\{[^}]*position:\s*sticky/);
});

// === Section 43: Summary thumbnail placeholder for unselected ===

test('Summary renders placeholder thumbs for unselected steps', () => {
  assert.match(index, /emptyThumb\s*=/);
  assert.match(index, /sbs-sum-thumb/);
});
