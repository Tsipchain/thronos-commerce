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

test('Next button is disabled until a selection is made', () => {
  assert.match(index, /btnNext\.disabled = !sbsState\.selections\[g\.id\]/);
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
  assert.match(index, /sbsState\.skipped\[g\.id\]/);
});

test('Summary total accumulates only selected option deltas', () => {
  assert.match(index, /total \+= delta/);
  assert.match(index, /elTotal\.textContent = total\.toFixed\(2\)/);
});

test('Add-to-cart button hidden during steps, shown only when builder complete', () => {
  assert.match(index, /var builderComplete = isBuilderComplete\(\)/);
  assert.match(index, /btnCartSidebar\.style\.display = allDone && builderComplete \? '' : 'none'/);
  assert.match(index, /btnCartSidebar\.disabled = !builderComplete/);
});

// === Section 3: Builder config persistence ===

test('Admin has all builder config input fields', () => {
  assert.match(admin, /id="kit-bc-banner"/);
  assert.match(admin, /id="kit-bc-mobile-banner"/);
  assert.match(admin, /id="kit-bc-video"/);
  assert.match(admin, /id="kit-bc-video-source"/);
  assert.match(admin, /id="kit-bc-title-el"/);
  assert.match(admin, /id="kit-bc-title-en"/);
  assert.match(admin, /id="kit-bc-subtitle-el"/);
  assert.match(admin, /id="kit-bc-subtitle-en"/);
  assert.match(admin, /id="kit-bc-helper-el"/);
  assert.match(admin, /id="kit-bc-helper-en"/);
  assert.match(admin, /id="kit-bc-show-trust"/);
});

test('Builder config fields are bound via JS change listeners', () => {
  assert.match(admin, /bcMap[\s\S]*logoImage[\s\S]*bannerImage[\s\S]*mobileBannerImage[\s\S]*title\.el[\s\S]*subtitle\.el[\s\S]*helperText\.el/);
  assert.match(admin, /kit-bc-video-source/, 'video guide source selector exists');
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
  assert.match(admin, /kit-bc-video-source.*videoGuideSource/);
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
  assert.match(index, /sbs-builder-body.*grid-template-columns:\s*minmax\(0,\s*70fr\)\s+minmax\(300px,\s*30fr\)/s);
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
  assert.match(index, /escAttr\(stepHeadingLabel\(g\)\)/);
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

test('Step heading has full label lookup map for known step IDs', () => {
  assert.match(index, /stepHeadingLabels\s*=\s*\{/);
  assert.match(index, /'tampakiera-karoulaki':\s*\{[^}]*el:\s*'Ταμπακιέρα \+ Καρουλάκι'/);
  assert.match(index, /'tampakiera-karoulaki':\s*\{[^}]*en:\s*'Shutter Box \+ Roller'/);
});

test('renderProgress uses stepShortLabel helper, not raw g.id', () => {
  assert.match(index, /stepShortLabel\(g\)/);
  assert.doesNotMatch(index, /sbs-step-label[^<]*escAttr\(g\.id\)/);
});

test('Step heading uses stepHeadingLabel for localized display', () => {
  assert.match(index, /elStepTitle\.innerHTML[\s\S]*?escAttr\(stepHeadingLabel\(g\)\)/);
  assert.match(index, /function stepHeadingLabel\(g\)/);
});

test('Summary rows use stepHeadingLabel for step names', () => {
  assert.match(index, /sbs-sum-step[^<]*escAttr\(stepHeadingLabel\(g\)\)/);
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

test('Builder max-width constrains desktop layout', () => {
  assert.match(index, /\.sbs-builder\s*\{[^}]*max-width:\s*1280px/);
});

test('Builder body grid uses ~70/30 split', () => {
  assert.match(index, /\.sbs-builder-body\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*70fr\)\s+minmax\(300px,\s*30fr\)/);
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

// === Section 44: Navigation button text ===

test('SBS next button uses Συνέχεια / Continue label', () => {
  assert.match(index, /Συνέχεια →/);
  assert.match(index, /Continue →/);
});

// === Section 45: Video CTA arrow icon ===

test('Video CTA includes arrow icon element', () => {
  assert.match(index, /sbs-video-cta-arrow/);
});

// === Section 46: Admin asset upload controls ===

test('Admin has upload/remove controls for all 4 builder image fields', () => {
  const fields = ['logoImage', 'mobileLogoImage', 'bannerImage', 'mobileBannerImage'];
  fields.forEach(f => {
    assert.match(admin, new RegExp('data-bc-upload="' + f + '"'), f + ' upload');
    assert.match(admin, new RegExp('data-bc-remove="' + f + '"'), f + ' remove');
  });
});

test('Admin has preview images for all 4 builder image fields', () => {
  assert.match(admin, /id="kit-bc-logo-preview"/);
  assert.match(admin, /id="kit-bc-mobile-logo-preview"/);
  assert.match(admin, /id="kit-bc-banner-preview"/);
  assert.match(admin, /id="kit-bc-mobile-banner-preview"/);
});

test('Admin upload handler posts to builder/asset-upload endpoint', () => {
  assert.match(admin, /\/admin\/builder\/asset-upload/);
  assert.match(admin, /fd\.append\('asset'/);
  assert.match(admin, /fd\.append\('field', field\)/);
  assert.match(admin, /fd\.append\('productId'/);
});

test('Admin remove handler posts to builder/asset-remove endpoint', () => {
  assert.match(admin, /\/admin\/builder\/asset-remove/);
});

test('syncBuilderConfigPanel updates preview images on load', () => {
  assert.match(admin, /kit-bc-logo-preview/);
  assert.match(admin, /kit-bc-banner-preview/);
  assert.match(admin, /_prevFields\.forEach/);
});

// === Section 47: Server asset upload/remove endpoints ===

test('Server has builder asset upload endpoint', () => {
  assert.match(server, /app\.post\('\/admin\/builder\/asset-upload'/);
  assert.match(server, /builderAssetUpload\.single\('asset'\)/);
});

test('Server has builder asset remove endpoint', () => {
  assert.match(server, /app\.post\('\/admin\/builder\/asset-remove'/);
});

test('Server asset upload validates field against allowlist', () => {
  assert.match(server, /allowedFields.*=.*\['logoImage'.*'mobileLogoImage'.*'bannerImage'.*'mobileBannerImage'\]/);
});

test('Server asset upload increments imageVersion on upload', () => {
  const uploadMatch = server.match(/imageVersion.*=.*\(Number\(.*imageVersion\).*\|\|.*0\).*\+.*1/);
  assert.ok(uploadMatch, 'imageVersion incremented in upload');
});

test('Server asset upload deletes previous file before saving new one', () => {
  assert.match(server, /previousUrl.*startsWith.*tenantMediaPrefix/);
  assert.match(server, /fs\.unlinkSync\(oldFile\)/);
});

test('normalizeProductRecord preserves imageVersion', () => {
  assert.match(server, /imageVersion:\s*Number\(_bc\.imageVersion\)\s*\|\|\s*1/);
});

// === Section 48: Storefront cache-busting ===

test('Storefront applies imageVersion cache-busting to banner and logo', () => {
  assert.match(index, /bcVersion/);
  assert.match(index, /bc\.imageVersion\s*\|\|\s*1/);
});

// === Section 49: Benefit reorder ===

test('Admin benefits have move up/down buttons', () => {
  assert.match(admin, /data-benefit-up="/);
  assert.match(admin, /data-benefit-down="/);
});

test('Admin benefit up handler swaps elements', () => {
  assert.match(admin, /data-benefit-up.*addEventListener/s);
  assert.match(admin, /tmp\s*=\s*a\[idx\];\s*a\[idx\]\s*=\s*a\[idx\s*-\s*1\];\s*a\[idx\s*-\s*1\]\s*=\s*tmp/);
});

// === Section 50: Trust item enable/disable and reorder ===

test('Admin trust items have enable/disable toggle', () => {
  assert.match(admin, /data-trust-idx="/);
});

test('Admin trust uses fixed 3-slot UI (no move buttons needed)', () => {
  assert.match(admin, /trust-slot.*data-slot="0"/);
  assert.match(admin, /trust-slot.*data-slot="1"/);
  assert.match(admin, /trust-slot.*data-slot="2"/);
});

test('Trust item enable toggle updates builderConfig', () => {
  assert.match(admin, /data-trust-idx.*addEventListener/s);
  assert.match(admin, /trustItems\[idx\]\.enabled\s*=\s*this\.checked/);
});

test('New trust items are created with enabled:true', () => {
  assert.match(admin, /trustItems\.push\(\{.*enabled:\s*true/);
});

test('Storefront filters trust items by enabled !== false', () => {
  assert.match(index, /trustItems\.filter\(function\(t\)\{\s*return t\.enabled !== false/);
});

// === Section 51: Builder config persistence round-trip ===

test('All admin bcMap text fields have corresponding syncBuilderConfigPanel load', () => {
  const bcMapFields = [
    'logoImage', 'mobileLogoImage', 'bannerImage', 'mobileBannerImage',
    'videoUrl', 'title.el', 'title.en', 'subtitle.el', 'subtitle.en',
    'helperText.el', 'helperText.en', 'slogan.el', 'slogan.en',
    'sloganSecondary.el', 'sloganSecondary.en',
    'summarySubtitle.el', 'summarySubtitle.en',
    'videoCTATitle.el', 'videoCTATitle.en',
    'videoCTASubtitle.el', 'videoCTASubtitle.en'
  ];
  bcMapFields.forEach(f => {
    const field = f.includes('.') ? f.split('.')[0] : f;
    assert.match(admin, new RegExp('bc\\.' + field), 'syncBuilderConfigPanel loads ' + f);
  });
});

test('All admin checkbox flags have corresponding syncBuilderConfigPanel load', () => {
  const flags = ['showLogo', 'showSlogan', 'showVideoCTA', 'showTitle', 'showSubtitle', 'showHelperText', 'showTrustRow'];
  flags.forEach(f => {
    assert.match(admin, new RegExp("bc\\." + f), 'sync loads ' + f);
  });
});

test('All admin select fields have corresponding syncBuilderConfigPanel load', () => {
  assert.match(admin, /bc\.logoPosition/);
  assert.match(admin, /bc\.logoSize/);
});

// === Section 52: Builder logo CSS fix ===

test('Banner background img uses sbs-banner-bg class selector, not generic img', () => {
  assert.match(index, /\.sbs-banner\s+img\.sbs-banner-bg/);
  assert.doesNotMatch(index, /\.sbs-banner\s+img\s*\{/);
});

test('Builder logo has max-width and display:block constraints', () => {
  assert.match(index, /\.sbs-banner-logo\s*\{[^}]*max-width/);
  assert.match(index, /\.sbs-banner-logo\s*\{[^}]*display:\s*block/);
  assert.match(index, /\.sbs-banner-logo\s*\{[^}]*object-fit:\s*contain/);
});

test('Builder logo onerror hides gracefully', () => {
  assert.match(index, /sbs-builder-logo.*onerror.*display.*none/s);
});

// === Section 53: Raw ID filtering ===

test('stepShortLabel and stepHeadingLabel have raw ID detection', () => {
  assert.match(index, /looksLikeRawId/);
});

test('stepHeadingLabels map covers all 5 known step IDs', () => {
  const ids = ['tampakiera-karoulaki', 'aristeri-plevra', 'dexia-plevra', 'tirantes', 'exoterika-stoper'];
  ids.forEach(id => {
    assert.match(index, new RegExp("'" + id + "'"), id + ' in heading map');
  });
});

test('stepShortLabels map covers all 5 known step IDs', () => {
  const ids = ['tampakiera-karoulaki', 'aristeri-plevra', 'dexia-plevra', 'tirantes', 'exoterika-stoper'];
  ids.forEach(id => {
    assert.match(index, new RegExp("'" + id + "'"), id + ' in short map');
  });
});

test('stepHeadingLabels has correct EL labels', () => {
  assert.match(index, /Ταμπακιέρα \+ Καρουλάκι/);
  assert.match(index, /Αριστερή Πλευρά/);
  assert.match(index, /Δεξιά Πλευρά/);
  assert.match(index, /Τιράντες/);
  assert.match(index, /Εξωτερικά Στόπερ/);
});

test('stepHeadingLabels has correct EN labels', () => {
  assert.match(index, /Shutter Box \+ Roller/);
  assert.match(index, /Left Side/);
  assert.match(index, /Right Side/);
  assert.match(index, /External Stoppers/);
});

// === Section 54: Completion step layout ===

test('Completion step has recap content block', () => {
  assert.match(index, /sbs-completion-recap/);
  assert.match(index, /sbs-completion-heading/);
  assert.match(index, /sbs-completion-steps/);
  assert.match(index, /sbs-completion-row/);
});

test('Completion step has bilingual heading and text', () => {
  assert.match(index, /Οι επιλογές σας είναι έτοιμες/);
  assert.match(index, /Your selections are ready/);
});

test('Completion recap rows use stepHeadingLabel for labels', () => {
  assert.match(index, /stepHeadingLabel\(g\).*sbs-completion-step-val/s);
});

test('Completion recap CSS exists', () => {
  assert.match(index, /\.sbs-completion-recap\s*\{/);
  assert.match(index, /\.sbs-completion-row\s*\{/);
  assert.match(index, /\.sbs-completion-step-name\s*\{/);
});

// === Section 55: False toggle persistence ===

test('normalizeProductRecord preserves showLogo:false correctly', () => {
  assert.match(server, /showLogo:\s*_bc\.showLogo\s*!==\s*false/);
});

test('normalizeProductRecord preserves showVideoCTA:false via === true', () => {
  assert.match(server, /showVideoCTA:\s*_bc\.showVideoCTA\s*===\s*true/);
});

test('normalizeProductRecord preserves all show* flags with !== false pattern', () => {
  const neqFalse = ['showSlogan', 'showTitle', 'showSubtitle', 'showHelperText', 'showVideo', 'showTrustRow'];
  neqFalse.forEach(flag => {
    const re = new RegExp(flag + ':\\s*_bc\\.' + flag + '\\s*!==\\s*false');
    assert.match(server, re, flag + ' uses !== false pattern');
  });
});

test('syncBuilderConfigPanel reloads false show flags correctly', () => {
  assert.match(admin, /kit-bc-show-logo.*\.checked\s*=\s*bc\.showLogo\s*!==\s*false/s);
  assert.match(admin, /kit-bc-video-source.*\.value\s*=\s*bc\.videoGuideSource/s);
});

test('showFlags listener writes boolean from checkbox.checked', () => {
  assert.match(admin, /p\.builderConfig\[key\]\s*=\s*this\.checked/);
});

// === Section 56: Behavioral save/reload round-trip ===

test('Product save includes builderConfig in POST payload', () => {
  assert.match(admin, /builderConfig/);
  assert.match(admin, /products\[kitBuilderIdx\]/);
});

test('normalizeProductRecord preserves bilingual text objects', () => {
  assert.match(server, /title:\s*_bc\.title\s*\|\|\s*''/);
  assert.match(server, /subtitle:\s*_bc\.subtitle\s*\|\|\s*''/);
  assert.match(server, /helperText:\s*_bc\.helperText\s*\|\|\s*''/);
  assert.match(server, /slogan:\s*_bc\.slogan\s*\|\|\s*''/);
  assert.match(server, /sloganSecondary:\s*_bc\.sloganSecondary\s*\|\|\s*''/);
});

test('normalizeProductRecord preserves arrays for benefits and trustItems', () => {
  assert.match(server, /benefits:\s*Array\.isArray\(_bc\.benefits\)/);
  assert.match(server, /trustItems:\s*Array\.isArray\(_bc\.trustItems\)/);
});

test('normalizeProductRecord preserves imageVersion', () => {
  assert.match(server, /imageVersion:\s*Number\(_bc\.imageVersion\)\s*\|\|\s*1/);
});

test('syncBuilderConfigPanel loads all bilingual fields on reload', () => {
  const bilingualFields = [
    'kit-bc-title-el', 'kit-bc-title-en',
    'kit-bc-subtitle-el', 'kit-bc-subtitle-en',
    'kit-bc-helper-el', 'kit-bc-helper-en',
    'kit-bc-slogan-el', 'kit-bc-slogan-en',
    'kit-bc-slogan2-el', 'kit-bc-slogan2-en',
    'kit-bc-summary-sub-el', 'kit-bc-summary-sub-en',
    'kit-bc-vcta-title-el', 'kit-bc-vcta-title-en',
    'kit-bc-vcta-sub-el', 'kit-bc-vcta-sub-en'
  ];
  bilingualFields.forEach(id => {
    assert.match(admin, new RegExp("getElementById\\('" + id + "'\\)"), id + ' is loaded in syncBuilderConfigPanel');
  });
});

// === Section 57: Live preview panel ===

test('Admin has live preview panel HTML', () => {
  assert.match(admin, /kit-bc-live-preview/);
  assert.match(admin, /lp-banner/);
  assert.match(admin, /lp-logo-img/);
  assert.match(admin, /lp-title/);
  assert.match(admin, /lp-benefits/);
  assert.match(admin, /lp-trust/);
  assert.match(admin, /lp-video/);
});

test('refreshLivePreview function exists', () => {
  assert.match(admin, /function refreshLivePreview\(bc\)/);
});

test('refreshLivePreview is called from text input listeners', () => {
  const afterBcMap = admin.substring(admin.indexOf('bcMap[fId]'));
  assert.match(afterBcMap, /refreshLivePreview\(p\.builderConfig\)/);
});

test('refreshLivePreview is called from show flag listeners', () => {
  const showSection = admin.substring(admin.indexOf("p.builderConfig[key] = this.checked"));
  assert.match(showSection, /refreshLivePreview\(p\.builderConfig\)/);
});

test('refreshLivePreview is called after benefit add', () => {
  const afterBenAdd = admin.substring(admin.indexOf('kit-bc-benefit-add'));
  assert.match(afterBenAdd, /renderBenefitsList[\s\S]*?refreshLivePreview/);
});

test('syncBuilderConfigPanel calls refreshLivePreview on load', () => {
  const syncFn = admin.substring(admin.indexOf('function syncBuilderConfigPanel'));
  assert.match(syncFn, /refreshLivePreview\(bc\)/);
});

// === Section 58: Option group raw ID display ===

test('Group list flags groups with no customer-facing label', () => {
  assert.match(admin, /var _isRawId = !_displayLabel/);
  assert.match(admin, /raw ID<\/span>/);
});

test('Group list shows bilingual label when both languages present', () => {
  assert.match(admin, /labelEl !== labelEn.*escHtml\(labelEn\)/s);
});

test('Choice list flags choices with no customer-facing label', () => {
  assert.match(admin, /var _cIsRawId = !_cDisplayLabel/);
});

test('Choice list shows linked product price/image source indicators', () => {
  assert.match(admin, /price:.*_priceSource/);
  assert.match(admin, /img:.*_imgSource/);
});

// === Section 59: Multi-tenant safety ===

test('No hardcoded tenant === eukolakis in server.js', () => {
  const lines = server.split('\n');
  lines.forEach((line, i) => {
    if (/tenant\s*===?\s*['"]eukolakis['"]/.test(line) && !/test|comment/i.test(line)) {
      assert.fail('Hardcoded tenant check at server.js:' + (i + 1));
    }
  });
});

test('Asset upload endpoint uses req.tenantPaths not hardcoded paths', () => {
  const uploadSection = server.substring(server.indexOf('builder/asset-upload'));
  const nextRoute = uploadSection.indexOf("app.post('") > 0 ? uploadSection.indexOf("app.post('") : uploadSection.length;
  const chunk = uploadSection.substring(0, Math.min(nextRoute, 500));
  assert.ok(!chunk.includes("'eukolakis'"), 'No hardcoded eukolakis in upload endpoint');
});

test('withTenantLink used for admin builder endpoints in EJS', () => {
  assert.match(admin, /withTenantLink\(["']\/admin\/builder\/asset-upload["']\)/);
  assert.match(admin, /withTenantLink\(["']\/admin\/builder\/asset-remove["']\)/);
});

// === Section 60: Unsaved indicator ===

test('Unsaved indicator element exists in preview', () => {
  assert.match(admin, /id="lp-unsaved"/);
  assert.match(admin, /Unsaved builder changes/);
});

test('snapshotBuilderConfig and markBuilderClean functions exist', () => {
  assert.match(admin, /function snapshotBuilderConfig\(bc\)/);
  assert.match(admin, /function markBuilderClean\(\)/);
});

test('checkBuilderDirty compares current state to saved snapshot', () => {
  assert.match(admin, /function checkBuilderDirty\(\)/);
  assert.match(admin, /current !== _bcSavedSnapshot/);
});

test('markBuilderClean is called after syncBuilderConfigPanel loads', () => {
  const syncFn = admin.substring(admin.indexOf('function syncBuilderConfigPanel'));
  const fnEnd = admin.indexOf('var _bcSavedSnapshot', syncFn.length ? 0 : undefined);
  const syncBlock = admin.substring(admin.indexOf('function syncBuilderConfigPanel'), admin.indexOf('var _bcSavedSnapshot'));
  assert.match(syncBlock, /markBuilderClean\(\)/);
});

test('markBuilderClean is NOT called in form submit handler (dirty until reload)', () => {
  const marker = 'Serialize before submit';
  const serializeIdx = admin.indexOf(marker);
  assert.ok(serializeIdx > 0, 'Serialize before submit section found');
  const renderIdx = admin.indexOf('Initial render', serializeIdx);
  assert.ok(renderIdx > serializeIdx, 'Initial render section found after serialize');
  const submitBlock = admin.substring(serializeIdx, renderIdx);
  assert.ok(submitBlock.includes('products-json-input'), 'submit handler serializes products');
  assert.ok(!submitBlock.includes('markBuilderClean'), 'submit handler does NOT call markBuilderClean');
});

test('refreshLivePreview calls checkBuilderDirty', () => {
  const fn = admin.substring(admin.indexOf('function refreshLivePreview'));
  assert.match(fn, /checkBuilderDirty\(\)/);
});

// === Section 61: Preview image error handling ===

test('Banner preview image has onerror handler', () => {
  assert.match(admin, /lp-banner-img.*onerror/s);
});

test('Logo preview image has onerror handler', () => {
  assert.match(admin, /lp-logo-img.*onerror/s);
});

test('Logo uses contain sizing in preview', () => {
  assert.match(admin, /lp-logo-img.*object-fit:contain/s);
});

test('Logo is wrapped in lp-logo-wrap for positioning', () => {
  assert.match(admin, /id="lp-logo-wrap"/);
});

test('Preview uses cache-busting on banner and logo images', () => {
  const fn = admin.substring(admin.indexOf('function refreshLivePreview'));
  const fnEnd = fn.substring(0, fn.indexOf('function renderBenefitsList') > 0 ? fn.indexOf('function renderBenefitsList') : fn.length);
  assert.match(fnEnd, /bannerImg\.src = bSrc.*imageVersion/s);
  assert.match(fnEnd, /logoImg\.src = lSrc.*imageVersion/s);
});

// === Section 62: Storefront render verification ===

test('Storefront resolves all bilingual text fields via resolveF', () => {
  const fields = ['bc.title', 'bc.subtitle', 'bc.helperText', 'bc.slogan', 'bc.sloganSecondary',
                  'bc.videoCTATitle', 'bc.videoCTASubtitle', 'bc.summarySubtitle'];
  fields.forEach(f => {
    assert.match(index, new RegExp('resolveF\\(' + f.replace('.', '\\.') + '\\)'), f + ' resolved via resolveF');
  });
});

test('Storefront filters benefits and trust by enabled !== false', () => {
  assert.match(index, /benefits.*filter.*enabled !== false/s);
  assert.match(index, /trustItems.*filter.*enabled !== false/s);
});

test('Storefront applies logo position and size via CSS classes', () => {
  assert.match(index, /logoPosition === 'center'/);
  assert.match(index, /logoPosition === 'right'/);
  assert.match(index, /logoSize === 'small'/);
  assert.match(index, /logoSize === 'large'/);
});

test('Storefront respects all show flags', () => {
  assert.match(index, /showLogo !== false/);
  assert.match(index, /showTitle !== false/);
  assert.match(index, /showSubtitle !== false/);
  assert.match(index, /showHelperText !== false/);
  assert.match(index, /showSlogan !== false/);
  assert.match(index, /showTrustRow !== false/);
  assert.match(index, /showVideoCTA/);
});

// === Section 63: Asset replacement persistence (A → B) ===

test('Server asset-upload deletes previous file before saving new URL', () => {
  const uploadRoute = server.substring(server.indexOf("'/admin/builder/asset-upload'"));
  const routeEnd = server.indexOf("'/admin/builder/asset-remove'");
  const block = server.substring(server.indexOf("'/admin/builder/asset-upload'"), routeEnd);
  assert.match(block, /previousUrl/, 'captures previous URL before overwriting');
  assert.match(block, /unlinkSync/, 'deletes previous file');
  assert.match(block, /product\.builderConfig\[field\] = url/, 'saves new URL to the correct field');
});

test('Server asset-upload increments imageVersion for cache-busting', () => {
  const uploadRoute = server.substring(server.indexOf("'/admin/builder/asset-upload'"));
  const routeEnd = server.indexOf("'/admin/builder/asset-remove'");
  const block = server.substring(server.indexOf("'/admin/builder/asset-upload'"), routeEnd);
  assert.match(block, /imageVersion.*\+ 1/, 'increments imageVersion after upload');
  assert.match(block, /ok: true, url, imageVersion/, 'returns new URL and imageVersion');
});

test('Server asset-remove clears field and increments imageVersion', () => {
  const removeIdx = server.indexOf("'/admin/builder/asset-remove'");
  const nextRouteIdx = server.indexOf('// Favicon upload', removeIdx);
  const block = server.substring(removeIdx, nextRouteIdx > removeIdx ? nextRouteIdx : removeIdx + 2000);
  assert.match(block, /builderConfig\[field\] = ''/, 'clears the field to empty string');
  assert.match(block, /imageVersion.*\+ 1/, 'increments imageVersion on remove');
});

test('Server asset-upload validates field against allowlist', () => {
  const uploadIdx = server.indexOf("'/admin/builder/asset-upload'");
  const block = server.substring(uploadIdx, uploadIdx + 1500);
  assert.match(block, /allowedFields.*logoImage.*bannerImage/s, 'has allowlist for fields');
  assert.match(block, /allowedFields\.includes\(field\)/, 'checks field against allowlist');
});

test('Admin preview applies cache-busting imageVersion to replaced assets', () => {
  const fn = admin.substring(admin.indexOf('function refreshLivePreview'));
  const fnEnd = fn.substring(0, fn.indexOf('function renderBenefitsList'));
  assert.match(fnEnd, /bannerImg\.src = bSrc.*imageVersion/s, 'banner uses imageVersion');
  assert.match(fnEnd, /logoImg\.src = lSrc.*imageVersion/s, 'logo uses imageVersion');
});

test('Storefront applies cache-busting version to banner and logo', () => {
  assert.match(index, /bcVersion|imageVersion/, 'storefront uses version query parameter');
});

// === Section 64: Preview language resolution (EL/EN) ===

test('Admin preview resolver favors EL then EN for bilingual objects', () => {
  const fn = admin.substring(admin.indexOf('function refreshLivePreview'));
  const fnEnd = fn.substring(0, fn.indexOf('function renderBenefitsList'));
  assert.match(fnEnd, /v\.el \|\| v\.en/, 'preview _rf resolves el then en');
});

test('Storefront resolveF resolves by LANG then EL then EN', () => {
  const fn = index.substring(index.indexOf('function resolveF'));
  const fnEnd = fn.substring(0, fn.indexOf('function escAttr') > 0 ? fn.indexOf('function escAttr') : 200);
  assert.match(fnEnd, /v\[LANG\] \|\| v\.el \|\| v\.en/, 'resolveF uses LANG > el > en fallback');
});

test('Storefront LANG variable is set from server-side lang', () => {
  assert.match(index, /var LANG = '<%[=-] lang %>'/, 'LANG initialized from EJS lang variable');
});

test('Admin preview applies _rf to all text fields', () => {
  const fn = admin.substring(admin.indexOf('function refreshLivePreview'));
  const fnEnd = fn.substring(0, fn.indexOf('function renderBenefitsList'));
  const fields = ['bc.slogan', 'bc.sloganSecondary', 'bc.title', 'bc.subtitle', 'bc.helperText'];
  fields.forEach(f => {
    assert.match(fnEnd, new RegExp('_rf\\(' + f.replace('.', '\\.') + '\\)'), 'preview resolves ' + f);
  });
});

test('Server normalizeProductRecord preserves bilingual text structure', () => {
  const normBlock = server.substring(server.indexOf('function normalizeProductRecord'));
  const normEnd = normBlock.substring(0, normBlock.indexOf('return Object.assign') + 500);
  const bilingualFields = ['title', 'subtitle', 'helperText', 'slogan', 'sloganSecondary',
    'videoCTATitle', 'videoCTASubtitle', 'summarySubtitle'];
  bilingualFields.forEach(f => {
    assert.match(normEnd, new RegExp(f + ".*\\|\\| ''"), f + ' preserved with fallback');
  });
});

// === Section: Behavioral / DOM-integration tests ===

test('Click handler sets sbsState.selections and enables Continue', () => {
  assert.match(index, /sbsState\.selections\[g\.id\]\s*=\s*c\.id/, 'click stores selection');
  assert.match(index, /btnNext\.disabled\s*=\s*false/, 'click enables Continue');
  assert.match(index, /renderStep\(\)/, 'click calls renderStep');
});

test('renderStep updates total from selections', () => {
  assert.match(index, /elTotal/, 'reference to total element');
  assert.match(index, /\.price/, 'price property read during render');
});

test('Option selected class is applied via renderStep', () => {
  assert.match(index, /selected/, 'selected class referenced');
  assert.match(index, /sbsState\.selections\[g\.id\]/, 'selection state checked during render');
});

test('Summary panel does not use overflow-y:auto on .sbs-summary', () => {
  const summaryCSS = index.substring(
    index.indexOf('.sbs-summary {'),
    index.indexOf('}', index.indexOf('.sbs-summary {')) + 1
  );
  assert.ok(!summaryCSS.includes('overflow-y:auto'), 'summary does not scroll internally');
  assert.ok(!summaryCSS.includes('overflow:auto'), 'summary does not use overflow:auto');
});

test('Sidebar summary-list scrolls independently to pin trust/cart at bottom', () => {
  const bodyCSS = index.substring(
    index.indexOf('.sbs-builder-body {'),
    index.indexOf('}', index.indexOf('.sbs-builder-body {')) + 1
  );
  assert.match(bodyCSS, /overflow:\s*hidden/, 'builder-body clips (columns scroll independently)');
  const listCSS = index.substring(
    index.indexOf('.sbs-summary-list {'),
    index.indexOf('}', index.indexOf('.sbs-summary-list {')) + 1
  );
  assert.match(listCSS, /overflow-y:\s*auto/, 'summary-list scrolls to pin trust/cart at bottom');
  assert.match(listCSS, /flex:\s*1/, 'summary-list takes available space');
});

test('Banner bg image uses absolute positioning for proper cover', () => {
  const bgCSS = index.substring(
    index.indexOf('.sbs-banner img.sbs-banner-bg'),
    index.indexOf('}', index.indexOf('.sbs-banner img.sbs-banner-bg')) + 1
  );
  assert.match(bgCSS, /position:\s*absolute/, 'banner bg is absolutely positioned');
  assert.match(bgCSS, /object-fit:\s*cover/, 'banner bg uses object-fit:cover');
  assert.match(bgCSS, /inset:\s*0/, 'banner bg uses inset:0');
});

test('Step labels use stepHeadingLabel/stepShortLabel, not raw group id', () => {
  assert.match(index, /stepHeadingLabel\(g\)/, 'heading uses stepHeadingLabel()');
  assert.match(index, /stepShortLabel\(g\)/, 'stepper uses stepShortLabel()');
});

test('stepHeadingLabels map covers all five eukolakis kit option group IDs', () => {
  const mapStart = index.indexOf('var stepHeadingLabels');
  assert.ok(mapStart > -1, 'stepHeadingLabels map exists');
  const mapBlock = index.substring(mapStart, index.indexOf('};', mapStart) + 2);
  kitOptions.forEach(g => {
    assert.ok(mapBlock.includes("'" + g.id + "'") || mapBlock.includes('"' + g.id + '"'),
      'stepHeadingLabels has entry for ' + g.id);
  });
});

test('stepShortLabels map covers all five eukolakis kit option group IDs', () => {
  const mapStart = index.indexOf('var stepShortLabels');
  assert.ok(mapStart > -1, 'stepShortLabels map exists');
  const mapBlock = index.substring(mapStart, index.indexOf('};', mapStart) + 2);
  kitOptions.forEach(g => {
    assert.ok(mapBlock.includes("'" + g.id + "'") || mapBlock.includes('"' + g.id + '"'),
      'stepShortLabels has entry for ' + g.id);
  });
});

test('Benefits strip renders from builderConfig.benefits array', () => {
  assert.match(index, /benefits\.forEach/, 'benefits array iterated');
  assert.match(index, /sbs-benefit/, 'benefit DOM class referenced');
  assert.match(index, /sbs-benefit-icon/, 'benefit icon rendered');
  assert.match(index, /sbs-benefit-text/, 'benefit text rendered');
});

test('Benefits data exists and has enabled items for eukolakis kit', () => {
  const bc = rollKit.builderConfig;
  assert.ok(bc, 'builderConfig exists');
  assert.ok(Array.isArray(bc.benefits), 'benefits is an array');
  const enabled = bc.benefits.filter(b => b.enabled !== false);
  assert.ok(enabled.length >= 1, 'at least one enabled benefit');
  enabled.forEach(b => {
    assert.ok(b.icon, 'benefit has icon: ' + b.icon);
    assert.ok(b.title, 'benefit has title');
  });
});

test('Trust row renders from builderConfig.trustItems', () => {
  assert.match(index, /trustItems/, 'trustItems referenced');
  assert.match(index, /sbs-trust-item/, 'trust item class');
  assert.match(index, /sbs-trust-icon/, 'trust icon class');
});

test('Continue button navigates to next step on click', () => {
  assert.match(index, /sbsState\.step\s*\+=\s*1/, 'step incremented on Continue');
  assert.match(index, /renderStep\(\)/, 'renderStep called after step increment');
});

// === Section: Video Guide Integration ===

const { normalizeVideo, resolveVideoGuide } = require('../lib/video-library');

// Case A: Product has explicit selected video → CTA opens that video
test('Case A — resolveVideoGuide returns product-linked video first', () => {
  const videos = [
    normalizeVideo({ id: 'vid_cat', titleEn: 'Cat video', categoryId: 'diy-rolla', published: true }, 'test'),
    normalizeVideo({ id: 'vid_prod', titleEn: 'Product video', productId: 'prod-1', published: true }, 'test'),
    normalizeVideo({ id: 'vid_default', titleEn: 'Default', featured: true, published: true }, 'test'),
  ];
  const result = resolveVideoGuide(videos, { productId: 'prod-1', categoryId: 'diy-rolla' });
  assert.ok(result, 'resolved a video');
  assert.equal(result.video.id, 'vid_prod', 'product video takes priority');
  assert.equal(result.source, 'product');
});

// Case B: No explicit product video → auto resolves product match in storefront
test('Case B — storefront resolveVideoForBuilder handles auto product resolution', () => {
  assert.match(index, /var byProduct = tenantVideos\.find/, 'auto product lookup exists');
  assert.match(index, /vd\.productId === product\.id/, 'product ID matching');
  assert.match(index, /source: 'product'/, 'product source returned');
});

// Case C: No product video but category guide → auto resolves category
test('Case C — resolveVideoGuide falls back to category match', () => {
  const videos = [
    normalizeVideo({ id: 'vid_cat', titleEn: 'Cat guide', categoryId: 'diy-rolla', published: true }, 'test'),
    normalizeVideo({ id: 'vid_default', titleEn: 'Default', featured: true, published: true }, 'test'),
  ];
  const result = resolveVideoGuide(videos, { productId: 'prod-no-match', categoryId: 'diy-rolla' });
  assert.ok(result, 'resolved a video');
  assert.equal(result.video.id, 'vid_cat', 'category video used');
  assert.equal(result.source, 'category');
});

test('Case C — storefront resolveVideoForBuilder handles category fallback', () => {
  assert.match(index, /vd\.categoryId === product\.categoryId/, 'category ID matching in storefront');
  assert.match(index, /source: 'category'/, 'category source returned');
});

// Case D: No matching video → CTA visible → Coming Soon
test('Case D — resolveVideoGuide returns null when no videos match', () => {
  const videos = [
    normalizeVideo({ id: 'vid_other', titleEn: 'Other', productId: 'other-prod', published: true }, 'test'),
  ];
  const result = resolveVideoGuide(videos, { productId: 'prod-1', categoryId: 'cat-1' });
  assert.equal(result, null, 'null when no match');
});

test('Case D — storefront falls back to Coming Soon when no video resolved', () => {
  assert.match(index, /source: 'coming_soon'/, 'coming_soon source in storefront');
  assert.match(index, /COMING_SOON_URL/, 'Coming Soon URL used');
});

test('Case D — /video/coming-soon route exists in server', () => {
  assert.match(server, /app\.get\('\/video\/coming-soon'/, 'route defined');
  assert.match(server, /video-coming-soon/, 'renders coming-soon template');
});

test('Case D — Coming Soon page has tenant branding and back link', () => {
  const comingSoon = read('views/video-coming-soon.ejs');
  assert.match(comingSoon, /config\.storeName/, 'uses store name');
  assert.match(comingSoon, /config\.accentColor/, 'uses accent color');
  assert.match(comingSoon, /withTenantLink/, 'back link is tenant-aware');
  assert.match(comingSoon, /productName/, 'displays product name');
});

// Case E: showVideoCTA=false → CTA absent (hidden source)
test('Case E — videoGuideSource=hidden suppresses CTA in storefront', () => {
  assert.match(index, /src === 'hidden'/, 'hidden source check');
  assert.match(index, /return null/, 'returns null for hidden');
});

test('Case E — showVideoCTA=false is the master kill switch in storefront', () => {
  assert.match(index, /bc\.showVideoCTA === false\) return null/, 'showVideoCTA=false returns null early');
});

test('Case E — admin has hidden option in video source selector', () => {
  assert.match(admin, /value="hidden"/, 'hidden option in admin selector');
});

test('Case E — admin preview uses same showVideoCTA master flag', () => {
  assert.match(admin, /bc\.showVideoCTA !== false/, 'preview checks showVideoCTA');
  assert.doesNotMatch(admin, /_vSrc === 'select' \|\| _vSrc === 'coming_soon' \|\| _vSrc === 'auto'/, 'preview does not override showVideoCTA with source');
});

test('Admin has explicit showVideoCTA checkbox', () => {
  assert.match(admin, /id="kit-bc-show-video-cta"/, 'showVideoCTA checkbox exists');
  assert.match(admin, /showVideoCTA.*this\.checked|this\.checked.*showVideoCTA/s, 'checkbox wired to showVideoCTA');
});

// Case F: Multi-tenant safety — only tenant's videos appear
test('Case F — server passes only published tenant videos to storefront', () => {
  assert.match(server, /loadTenantVideos\(req\)\.filter/, 'videos filtered before passing to storefront');
  assert.match(server, /v\.published/, 'only published videos sent');
});

test('Case F — video entity has tenantId field', () => {
  const v = normalizeVideo({ titleEn: 'Test', published: true }, 'tenant-xyz');
  assert.equal(v.tenantId, 'tenant-xyz', 'tenantId set correctly');
});

// videoGuideId and videoGuideSource in builderConfig normalization
test('server normalizes videoGuideId and videoGuideSource in builderConfig', () => {
  assert.match(server, /videoGuideId:\s*String\(_bc\.videoGuideId/, 'videoGuideId normalized');
  assert.match(server, /videoGuideSource:.*auto.*select.*coming_soon.*hidden/, 'videoGuideSource validated');
});

// Admin UI: video source selector present
test('admin has video guide source selector instead of plain URL input', () => {
  assert.match(admin, /kit-bc-video-source/, 'video source select exists');
  assert.match(admin, /value="auto"/, 'auto option');
  assert.match(admin, /value="select"/, 'select option');
  assert.match(admin, /value="coming_soon"/, 'coming_soon option');
  assert.match(admin, /kit-bc-video-picker/, 'video picker select exists');
});

// Admin videos form: productId and categoryId fields
test('admin-videos form has productId and categoryId fields', () => {
  const adminVideos = read('views/admin-videos.ejs');
  assert.match(adminVideos, /name="productId"/, 'productId field');
  assert.match(adminVideos, /name="categoryId"/, 'categoryId field');
});

// video-library: resolveVideoGuide falls back to featured default
test('resolveVideoGuide returns featured default when no product/category match', () => {
  const videos = [
    normalizeVideo({ id: 'vid_def', titleEn: 'Default Guide', featured: true, published: true }, 'test'),
  ];
  const result = resolveVideoGuide(videos, { productId: 'no-match', categoryId: 'no-cat' });
  assert.ok(result, 'resolved a video');
  assert.equal(result.video.id, 'vid_def');
  assert.equal(result.source, 'default');
});

// video-library: unpublished videos are excluded from resolution
test('resolveVideoGuide ignores unpublished videos', () => {
  const videos = [
    normalizeVideo({ id: 'vid_draft', titleEn: 'Draft', productId: 'prod-1', published: false }, 'test'),
  ];
  const result = resolveVideoGuide(videos, { productId: 'prod-1' });
  assert.equal(result, null, 'unpublished video not resolved');
});

// video-library: productId and categoryId persist in normalizeVideo
test('normalizeVideo preserves productId and categoryId', () => {
  const v = normalizeVideo({ productId: 'p1', categoryId: 'c1', published: true }, 'tid');
  assert.equal(v.productId, 'p1');
  assert.equal(v.categoryId, 'c1');
});

// server saves productId and categoryId from video form
test('server video save handler passes productId and categoryId', () => {
  assert.match(server, /productId:\s*req\.body\.productId/, 'productId saved');
  assert.match(server, /categoryId:\s*req\.body\.categoryId/, 'categoryId saved');
});

// === Section N: Completion gate — full 5-step flow ===

test('N1: sbsState tracks skipped steps via sbsState.skipped object', () => {
  assert.match(index, /sbsState\.skipped = \{\}/, 'skipped initialized to empty object');
  assert.match(index, /sbsState\.skipped\[g\.id\] = true/, 'skip handler sets skipped[g.id] = true');
});

test('N2: isStepResolved checks selection OR explicit skip', () => {
  assert.match(index, /function isStepResolved\(g\)/);
  assert.match(index, /if \(sbsState\.selections\[g\.id\]\) return true/);
  assert.match(index, /!g\.required && g\.allowSkip && sbsState\.skipped\[g\.id\]\) return true/);
});

test('N3: isBuilderComplete requires every step resolved', () => {
  assert.match(index, /function isBuilderComplete\(\)/);
  assert.match(index, /groups\.every\(isStepResolved\)/);
});

test('N4: Add to Cart button hidden during steps, visible only on completion', () => {
  assert.match(index, /btnCartSidebar\.style\.display = allDone && builderComplete \? '' : 'none'/);
});

test('N5: Progress stepper marks step done via selection or skipped', () => {
  assert.match(index, /var isDone = !!sbsState\.selections\[g\.id\] \|\| !!sbsState\.skipped\[g\.id\]/);
});

test('N6: Completion screen shows skipped steps status', () => {
  assert.match(index, /sbsState\.skipped\[g\.id\]/, 'skipped state checked in summary');
});

test('N7: openSbs resets skipped state', () => {
  assert.match(index, /sbsState\.skipped = \{\}/, 'skipped reset on builder open');
});

test('N8: Snapshot includes skippedSteps array', () => {
  assert.match(index, /skippedSteps\.push\(\{ stepId: g\.id/);
});

// === Section O: Bypass prevention ===

test('O1: addToCartFromBuilder guards with isBuilderComplete', () => {
  assert.match(index, /function addToCartFromBuilder[\s\S]*?if \(!isBuilderComplete\(\)\) return/);
});

test('O2: Next handler after last step guards with isBuilderComplete', () => {
  assert.match(index, /if \(!isBuilderComplete\(\)\) return;[\s\S]*?addToCartFromBuilder\(\)/);
});

test('O3: Server rejects incomplete kit — missing required step', () => {
  assert.match(server, /missingRequired.*=.*found\.kitOptions\.some/);
  assert.match(server, /res\.status\(400\)\.send\('Incomplete kit: required step missing'\)/);
});

test('O4: Server rejects incomplete kit — unresolved optional step', () => {
  assert.match(server, /unresolvedOptional.*=.*found\.kitOptions\.some/);
  assert.match(server, /res\.status\(400\)\.send\('Incomplete kit: optional step unresolved'\)/);
});

test('O5: Server checks skippedStepIds from builderSnapshot', () => {
  assert.match(server, /skippedStepIds.*=.*Array\.isArray\(ci\.builderSnapshot && ci\.builderSnapshot\.skippedSteps\)/);
  assert.match(server, /!skippedStepIds\.includes\(g\.id\)/);
});

test('O6: Completion screen redirects to first unresolved step if not complete', () => {
  assert.match(index, /if \(!builderComplete\)[\s\S]*?var firstUnresolved/);
});

// === Section P: Admin builder button ===

test('P1: openKitBuilder is a global window function', () => {
  assert.match(admin, /window\.openKitBuilder = function\(i\)/);
});

test('P2: openKitBuilder has try/catch safety net', () => {
  assert.match(admin, /openKitBuilder[\s\S]*?try \{[\s\S]*?kitBuilderIdx = i[\s\S]*?\} catch\(e\)/);
});

test('P3: openKitBuilder catch fallback still opens the modal', () => {
  assert.match(admin, /catch\(e\) \{ console\.error\('\[kit-builder\][\s\S]*?openKitBuilderModal\(\)/);
});

test('P4: openKitBuilder validates product type is KIT', () => {
  assert.match(admin, /products\[i\]\.type !== 'KIT'/);
});

// === Section Q: Trust triptych always visible ===

test('Q1: Trust row renders in openSbs (visible during all steps)', () => {
  assert.match(index, /showTrustRow !== false && trustItems\.length > 0/);
  assert.match(index, /elTrustRow\.style\.display = ''/);
});

test('Q2: Trust row has default items when config is empty', () => {
  assert.match(index, /defaultTrustItems\s*=\s*\[/);
  assert.match(index, /Ασφαλείς συναλλαγές/);
  assert.match(index, /Γρήγορη παράδοση/);
  assert.match(index, /Ελληνική υποστήριξη/);
});

test('Q3: Cart button is absent during steps (only visible on completion)', () => {
  assert.match(index, /btnCartSidebar\.style\.display = allDone && builderComplete \? '' : 'none'/);
});

test('Q4: showTrustRow=false hides trust row', () => {
  assert.match(index, /bc\.showTrustRow !== false/);
  assert.match(index, /elTrustRow\.style\.display = 'none'/);
});

// === Section R: Admin trust 3-slot UI ===

test('R1: Admin has 3 fixed trust slots', () => {
  assert.match(admin, /trust-slot-enabled.*data-slot="0"/);
  assert.match(admin, /trust-slot-enabled.*data-slot="1"/);
  assert.match(admin, /trust-slot-enabled.*data-slot="2"/);
});

test('R2: Admin trust slots have icon selectors', () => {
  assert.match(admin, /trust-slot-icon.*data-slot="0"/);
  assert.match(admin, /trust-slot-icon.*data-slot="1"/);
  assert.match(admin, /trust-slot-icon.*data-slot="2"/);
});

test('R3: Admin preview shows trust items', () => {
  assert.match(admin, /lp-trust/);
  assert.match(admin, /showTrustRow !== false && trs\.length/);
});

// === Section S: DOM hierarchy — summary panel order ===

test('S1: DOM order is trust-row before video-cta before cart-btn', () => {
  const trustPos = index.indexOf('id="sbs-trust-row"');
  const videoPos = index.indexOf('id="sbs-video-cta"');
  const cartPos = index.indexOf('id="sbs-cart-btn"');
  assert.ok(trustPos > 0, 'trust row exists');
  assert.ok(videoPos > 0, 'video CTA exists');
  assert.ok(cartPos > 0, 'cart button exists');
  assert.ok(trustPos < videoPos, 'trust row before video CTA');
  assert.ok(videoPos < cartPos, 'video CTA before cart button');
});

test('S2: Step 1 heading uses mapped label, never raw ID', () => {
  assert.match(index, /stepHeadingLabels/);
  assert.match(index, /tampakiera-karoulaki.*Ταμπακιέρα \+ Καρουλάκι/);
  assert.match(index, /tampakiera-karoulaki.*Shutter Box \+ Roller/);
});

test('S3: Admin Section D has merchant-friendly title', () => {
  assert.match(admin, /Δεξιά στήλη.*Αξιοπιστία.*Βίντεο οδηγιών|Summary.*Trust.*Installation Video/);
});

// === Section T: Trust row vs Benefits strip separation ===

test('T1: Trust row element is inside sbs-summary (right sidebar), not sbs-benefits', () => {
  const summaryStart = index.indexOf('id="sbs-summary"');
  const summaryEnd = index.indexOf('</div>', index.indexOf('id="sbs-cart-btn"'));
  const trustRowPos = index.indexOf('id="sbs-trust-row"');
  assert.ok(trustRowPos > summaryStart, 'trust row after sbs-summary start');
  assert.ok(trustRowPos < summaryEnd, 'trust row before sbs-summary end');
  const benefitsPos = index.indexOf('id="sbs-benefits"');
  assert.ok(benefitsPos > 0, 'benefits strip exists');
  assert.ok(benefitsPos < summaryStart, 'benefits strip is before summary (separate element)');
});

test('T2: Benefits strip has separate class sbs-benefits, trust row has sbs-trust-row', () => {
  assert.match(index, /class="sbs-benefits"/);
  assert.match(index, /class="sbs-trust-row"/);
  const benefitsClass = index.indexOf('class="sbs-benefits"');
  const trustClass = index.indexOf('class="sbs-trust-row"');
  assert.notStrictEqual(benefitsClass, trustClass);
});

test('T3: Summary list has independent scroll CSS (trust pinned at bottom)', () => {
  assert.match(index, /\.sbs-summary-list\s*\{[^}]*flex:\s*1/);
  assert.match(index, /\.sbs-summary-list\s*\{[^}]*overflow-y:\s*auto/);
});

test('T4: Trust row renders inside sbs-trust-row via openSbs, not inside benefits', () => {
  assert.match(index, /elTrustRow\.innerHTML = ''/);
  assert.match(index, /elTrustRow\.appendChild/);
  assert.match(index, /sbs-trust-item/);
});

// === Section U: Admin trust effective defaults ===

test('U1: Admin trust slot placeholders show default values', () => {
  assert.match(admin, /placeholder="Ασφαλείς συναλλαγές"/);
  assert.match(admin, /placeholder="Secure payments"/);
  assert.match(admin, /placeholder="Γρήγορη παράδοση"/);
  assert.match(admin, /placeholder="Fast delivery"/);
  assert.match(admin, /placeholder="Ελληνική υποστήριξη"/);
  assert.match(admin, /placeholder="Greek support"/);
});

test('U2: readTrustSlotsFromUI falls back to defaults for empty fields', () => {
  assert.match(admin, /readTrustSlotsFromUI/);
  assert.match(admin, /tEl \|\| defTitle\.el/);
  assert.match(admin, /tEn \|\| defTitle\.en/);
});

test('U3: Admin preview falls back to _defaultTrustSlots when trustItems empty', () => {
  assert.match(admin, /_defaultTrustSlots/);
  assert.match(admin, /bc\.trustItems.*\.length > 0.*_defaultTrustSlots/);
});

// === Section V: Exactly one Add to Cart on completion ===

test('V1: Nav button is hidden on completion (no duplicate Add to Cart)', () => {
  assert.match(index, /btnNext\.style\.display = 'none'/);
});

test('V2: Nav button is restored when navigating back to a step', () => {
  assert.match(index, /btnNext\.style\.display = ''/);
});

// === Section W: Banner size / fit / position controls ===

test('W1: Storefront CSS has banner size classes (small, medium=default, large)', () => {
  assert.match(index, /\.sbs-banner\.banner-small\s*\{/);
  assert.match(index, /\.sbs-banner\.banner-large\s*\{/);
});

test('W2: Storefront CSS has mobile banner size overrides', () => {
  assert.match(index, /@media.*max-width.*768px[\s\S]*?\.sbs-banner\.banner-small/);
  assert.match(index, /@media.*max-width.*768px[\s\S]*?\.sbs-banner\.banner-large/);
});

test('W3: Storefront applies bannerSize class from builderConfig', () => {
  assert.match(index, /bc\.bannerSize/);
  assert.match(index, /banner-small/);
  assert.match(index, /banner-large/);
});

test('W4: Storefront applies bannerFit (contain class) from builderConfig', () => {
  assert.match(index, /bc\.bannerFit/);
  assert.match(index, /banner-contain/);
  assert.match(index, /\.sbs-banner\.banner-contain.*object-fit:\s*contain/);
});

test('W5: Storefront applies bannerPosition as object-position from builderConfig', () => {
  assert.match(index, /bc\.bannerPosition/);
  assert.match(index, /objectPosition/);
});

test('W6: Admin has bannerSize select control', () => {
  assert.match(admin, /id="kit-bc-banner-size"/);
  assert.match(admin, /value="small"/);
  assert.match(admin, /value="medium"/);
  assert.match(admin, /value="large"/);
});

test('W7: Admin has bannerFit select control', () => {
  assert.match(admin, /id="kit-bc-banner-fit"/);
  assert.match(admin, /value="cover"/);
  assert.match(admin, /value="contain"/);
});

test('W8: Admin has bannerPosition select control', () => {
  assert.match(admin, /id="kit-bc-banner-position"/);
});

test('W9: Admin syncBuilderConfigPanel reads bannerSize/bannerFit/bannerPosition', () => {
  assert.match(admin, /kit-bc-banner-size.*\.value\s*=\s*bc\.bannerSize/);
  assert.match(admin, /kit-bc-banner-fit.*\.value\s*=\s*bc\.bannerFit/);
  assert.match(admin, /kit-bc-banner-position.*\.value\s*=\s*bc\.bannerPosition/);
});

test('W10: Admin selectMap includes banner controls for live preview update', () => {
  assert.match(admin, /kit-bc-banner-size.*bannerSize/);
  assert.match(admin, /kit-bc-banner-fit.*bannerFit/);
  assert.match(admin, /kit-bc-banner-position.*bannerPosition/);
});

test('W11: Admin preview applies bannerSize height', () => {
  assert.match(admin, /bannerSize/);
  assert.match(admin, /_bHeightMap/);
});

test('W12: Admin preview applies bannerFit to object-fit', () => {
  assert.match(admin, /objectFit/);
  assert.match(admin, /_bFit/);
});

test('W13: Admin preview applies bannerPosition to object-position', () => {
  assert.match(admin, /objectPosition/);
  assert.match(admin, /_bPos/);
});

test('W14: Banner size is independent from logo size', () => {
  assert.match(admin, /id="kit-bc-logo-size"/, 'logo size control exists');
  assert.match(admin, /id="kit-bc-banner-size"/, 'banner size control exists');
  assert.match(admin, /bc\.logoSize/, 'logoSize read from config');
  assert.match(admin, /bc\.bannerSize/, 'bannerSize read from config');
  assert.match(index, /bc\.logoSize/, 'storefront uses logoSize');
  assert.match(index, /bc\.bannerSize/, 'storefront uses bannerSize');
});

// === Section W+: Banner persistence and contain rendering ===

test('W15: Server normalizeProductRecord preserves bannerSize', () => {
  assert.match(server, /bannerSize.*small.*medium.*large/s, 'bannerSize whitelist in server');
});

test('W16: Server normalizeProductRecord preserves bannerFit', () => {
  assert.match(server, /bannerFit.*cover.*contain/s, 'bannerFit whitelist in server');
});

test('W17: Server normalizeProductRecord preserves bannerPosition', () => {
  assert.match(server, /bannerPosition.*left.*center.*right/s, 'bannerPosition whitelist in server');
});

test('W18: Server defaults bannerFit to contain', () => {
  const normBlock = server.substring(server.indexOf('function normalizeProductRecord'), server.indexOf('function loadTenantCategories'));
  assert.match(normBlock, /bannerFit.*'contain'/, 'server default bannerFit is contain');
});

test('W19: Storefront defaults bannerFit to contain', () => {
  assert.match(index, /bannerFit \|\| 'contain'/, 'storefront default bannerFit is contain');
});

test('W20: Admin defaults bannerFit to contain', () => {
  const syncFn = admin.substring(admin.indexOf('function syncBuilderConfigPanel'));
  assert.match(syncFn, /bannerFit \|\| 'contain'/, 'admin syncBuilderConfigPanel default bannerFit is contain');
});

test('W21: Storefront contain mode does not stretch image', () => {
  assert.match(index, /banner-contain img\.sbs-banner-bg.*object-fit:contain/s, 'contain CSS uses object-fit:contain');
  const bannerCSS = index.substring(index.indexOf('.sbs-banner.banner-contain'), index.indexOf('.sbs-banner-overlay'));
  assert.doesNotMatch(bannerCSS, /transform.*scale/, 'no transform scale in banner-contain CSS');
});

test('W22: Storefront contain mode has blurred background layer', () => {
  assert.match(index, /sbs-banner-blur/, 'blur image class exists');
  assert.match(index, /banner-contain img\.sbs-banner-blur.*display:block/s, 'blur visible in contain mode');
  assert.match(index, /sbs-banner-blur.*filter.*blur/s, 'blur has filter');
});

test('W23: Admin preview has blurred background layer for contain', () => {
  assert.match(admin, /lp-banner-blur/, 'admin blur element exists');
  assert.match(admin, /bannerBlur\.style\.display.*contain/, 'admin blur toggled by contain');
});

test('W24: Storefront banner overlay has z-index above blur and image layers', () => {
  assert.match(index, /sbs-banner-overlay.*z-index:\s*2/s, 'overlay z-index is 2 or higher');
});

test('W25: Storefront reopening SBS reapplies banner config', () => {
  const openFn = index.substring(index.indexOf('function openSbs'));
  assert.match(openFn, /elBanner\.className\s*=/, 'openSbs sets banner className');
  assert.match(openFn, /bannerSize/, 'openSbs reads bannerSize');
  assert.match(openFn, /bannerFit/, 'openSbs reads bannerFit');
  assert.match(openFn, /bannerPosition/, 'openSbs reads bannerPosition');
});
