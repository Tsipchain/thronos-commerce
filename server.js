const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const multer = require('multer');
const bcrypt = require('bcryptjs');

const app = express();

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// Data root config + auto-seeding for volumes
const EMBEDDED_DATA_ROOT = path.join(__dirname, 'data');

function copyDirRecursiveSync(srcDir, destDir) {
  ensureDir(destDir);
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursiveSync(srcPath, destPath);
    } else if (entry.isFile()) {
      // μην overwrite αν υπάρχει ήδη
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}

let DATA_ROOT = EMBEDDED_DATA_ROOT;

if (process.env.THRC_DATA_ROOT) {
  const candidateRoot = process.env.THRC_DATA_ROOT;

  try {
    ensureDir(candidateRoot);
    const candidateRegistry = path.join(candidateRoot, 'tenants.json');

    if (fs.existsSync(candidateRegistry)) {
      // υπάρχει ήδη tenants.json στο volume → δουλεύουμε από εκεί
      DATA_ROOT = candidateRoot;
      console.log(
        '[Thronos Commerce] Using data root from THRC_DATA_ROOT:',
        candidateRoot
      );
    } else {
      // δεν υπάρχει tenants.json → seed από το embedded ./data
      console.warn(
        '[Thronos Commerce] THRC_DATA_ROOT is set to',
        candidateRoot,
        'but tenants.json is missing – seeding from embedded ./data.'
      );
      copyDirRecursiveSync(EMBEDDED_DATA_ROOT, candidateRoot);
      DATA_ROOT = candidateRoot;
    }
  } catch (err) {
    console.error(
      '[Thronos Commerce] Failed to use THRC_DATA_ROOT, falling back to embedded ./data:',
      err.message
    );
    DATA_ROOT = EMBEDDED_DATA_ROOT;
  }
} else {
  console.log(
    '[Thronos Commerce] THRC_DATA_ROOT not set – using embedded ./data as DATA_ROOT.'
  );
}

// Ensure base dirs for the final DATA_ROOT
ensureDir(DATA_ROOT);

const TENANTS_DIR = path.join(DATA_ROOT, 'tenants');
ensureDir(TENANTS_DIR);

const TENANTS_REGISTRY = path.join(DATA_ROOT, 'tenants.json');

function loadJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`Could not load ${filePath}: ${err.message}`);
    return fallback;
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function loadTenantsRegistry() {
  const tenants = loadJson(TENANTS_REGISTRY, []);
  return Array.isArray(tenants) ? tenants : [];
}

function saveTenantsRegistry(tenants) {
  saveJson(TENANTS_REGISTRY, tenants);
}

function findTenantById(tenantId) {
  return loadTenantsRegistry().find((t) => t.id === tenantId) || null;
}

function tenantPaths(tenantId) {
  const base = path.join(TENANTS_DIR, tenantId);
  ensureDir(base);
  const media = path.join(base, 'media');
  ensureDir(media);
  return {
    base,
    config: path.join(base, 'config.json'),
    products: path.join(base, 'products.json'),
    categories: path.join(base, 'categories.json'),
    orders: path.join(base, 'orders.json'),
    media
  };
}

function loadTenantOrders(req) {
  try {
    const raw = fs.readFileSync(req.tenantPaths.orders, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[Thronos Commerce] Malformed orders.json for tenant ${req.tenant.id}: ${err.message} – falling back to empty array.`);
    }
    return [];
  }
}

function appendTenantOrder(req, order) {
  ensureDir(req.tenantPaths.base);
  const orders = loadTenantOrders(req);
  orders.push(order);
  saveJson(req.tenantPaths.orders, orders);
}

function getTenantByHost(hostname) {
  const tenants = loadTenantsRegistry();
  const host = (hostname || '').toLowerCase();
  let tenant = tenants.find(
    (t) =>
      t.domain &&
      t.domain.toLowerCase() === host
  );
  if (!tenant && tenants.length > 0) {
    // dev fallback to demo or first active tenant
    tenant = tenants.find((t) => t.id === 'demo') || tenants.find((t) => t.active) || tenants[0];
  }
  return tenant;
}

// Tenant-scoped loaders
function loadTenantConfig(req) {
  const fallback = {
    storeName: 'Thronos Demo Store',
    primaryColor: '#222222',
    accentColor: '#00ff88',
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    heroText: 'Καλωσήρθατε στο Thronos Commerce!',
    web3Domain: '',
    logoPath: '/logo.svg',
    shippingOptions: [],
    paymentOptions: [],
    theme: {
      menuBg: '#111111',
      menuText: '#ffffff',
      menuActiveBg: '#f06292',
      menuActiveText: '#ffffff',
      buttonRadius: '4px'
    }
  };
  return loadJson(req.tenantPaths.config, fallback);
}

function loadTenantProducts(req) {
  return loadJson(req.tenantPaths.products, []);
}

function loadTenantCategories(req) {
  return loadJson(req.tenantPaths.categories, []);
}

function saveTenantCategories(req, categories) {
  saveJson(req.tenantPaths.categories, categories);
}

function getSupportPermissions(supportTier) {
  const map = {
    SELF_SERVICE: {
      canEditSettings: true,
      canEditProducts: true,
      canUploadMedia: true,
      canEditCategories: true
    },
    MANAGEMENT_START: {
      canEditSettings: true,
      canEditProducts: true,
      canUploadMedia: true,
      canEditCategories: true
    },
    FULL_OPS_START: {
      canEditSettings: false,
      canEditProducts: false,
      canUploadMedia: false,
      canEditCategories: false
    }
  };
  return map[supportTier] || map.SELF_SERVICE;
}

function calculateTotals(config, product, shippingMethodId, paymentMethodId) {
  const shippingMethod = (config.shippingOptions || []).find((s) => s.id === shippingMethodId);
  const paymentMethod = (config.paymentOptions || []).find((p) => p.id === paymentMethodId);

  if (!shippingMethod) {
    throw new Error('Invalid shipping method');
  }
  if (!paymentMethod) {
    throw new Error('Invalid payment method');
  }
  if (
    Array.isArray(shippingMethod.allowedPaymentMethods) &&
    !shippingMethod.allowedPaymentMethods.includes(paymentMethod.id)
  ) {
    throw new Error('Ο συγκεκριμένος τρόπος πληρωμής δεν είναι διαθέσιμος για αυτή τη μέθοδο αποστολής.');
  }

  const subtotal = Number(product.price) || 0;
  const shippingCost = Number(shippingMethod.base) || 0;
  const codFee =
    paymentMethod.id === 'COD' ? Number(shippingMethod.codFee || 0) : 0;
  const gatewaySurchargePercent = Number(paymentMethod.gatewaySurchargePercent) || 0;
  const gatewayFee = subtotal * gatewaySurchargePercent;

  const total = subtotal + shippingCost + codFee + gatewayFee;

  return {
    subtotal,
    shippingCost,
    codFee,
    gatewayFee,
    total,
    shippingMethod,
    paymentMethod
  };
}

async function recordOrderOnChain(order, tenant) {
  const payload = {
    orderId: order.id,
    total: order.total,
    timestamp: order.createdAt,
    customerEmail: order.email,
    wallet: order.wallet || null,
    tenantId: tenant ? tenant.id : null
  };

  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');

  const nodeUrl = (process.env.THRONOS_NODE_URL || '').replace(/\/$/, '');
  const apiKey = process.env.THRONOS_COMMERCE_API_KEY || null;

  if (!nodeUrl) {
    console.log('THRONOS_NODE_URL not set; skipping on-chain call. Hash:', hash);
    return hash;
  }

  try {
    const response = await axios.post(
      `${nodeUrl}/api/commerce/attest`,
      {
        ...payload,
        hash,
        apiKey
      },
      { timeout: 4000 }
    );
    console.log('Thronos node response:', response.data);
  } catch (err) {
    console.error('Failed to send order to Thronos node:', err.message);
  }

  return hash;
}

async function verifyAdminPassword(tenant, plainPassword) {
  if (!tenant.adminPasswordHash) {
    return false;
  }
  const ok = await bcrypt.compare(plainPassword || '', tenant.adminPasswordHash);
  return ok;
}

// Root operator auth
const ROOT_ADMIN_PASSWORD = process.env.THRONOS_ROOT_ADMIN_PASSWORD || '';

function verifyRootPassword(plain) {
  if (!ROOT_ADMIN_PASSWORD) return false;
  return (plain || '') === ROOT_ADMIN_PASSWORD;
}

// Seed a new tenant's files from a template tenant (default: 'demo')
function seedTenantFilesFromTemplate(tenantId, templateId = 'demo') {
  const newPaths = tenantPaths(tenantId);
  const tplPaths = tenantPaths(templateId);

  if (!fs.existsSync(newPaths.config)) {
    const tplConfig = loadJson(tplPaths.config, {
      storeName: tenantId,
      primaryColor: '#222222',
      accentColor: '#00ff88',
      fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      heroText: 'Καλωσήρθατε στο κατάστημά μας!',
      web3Domain: '',
      logoPath: '/logo.svg',
      shippingOptions: [],
      paymentOptions: [],
      theme: { menuBg: '#111111', menuText: '#ffffff', menuActiveBg: '#f06292', menuActiveText: '#ffffff', buttonRadius: '4px' }
    });
    tplConfig.storeName = tenantId;
    saveJson(newPaths.config, tplConfig);
  }

  if (!fs.existsSync(newPaths.products)) {
    saveJson(newPaths.products, loadJson(tplPaths.products, []));
  }

  if (!fs.existsSync(newPaths.categories)) {
    saveJson(newPaths.categories, loadJson(tplPaths.categories, []));
  }
}

// Multer storage for per-tenant media
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const mediaDir =
      (req.tenantPaths && req.tenantPaths.media) ||
      path.join(TENANTS_DIR, '_uploads');
    ensureDir(mediaDir);
    cb(null, mediaDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const base = path
      .basename(file.originalname || 'upload', ext)
      .replace(/[^a-z0-9_-]/gi, '-')
      .toLowerCase();
    cb(null, `${Date.now()}-${base}${ext || '.jpg'}`);
  }
});

const upload = multer({ storage });

// View engine & middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/tenants', express.static(TENANTS_DIR));
app.use(express.urlencoded({ extended: true }));

// Tenant resolution middleware (skips root operator panel)
app.use((req, res, next) => {
  if (req.path.startsWith('/root')) return next();
  const hostHeader = (req.headers.host || '').split(':')[0];
  const tenant = getTenantByHost(hostHeader);
  if (!tenant) {
    return res
      .status(503)
      .send('No tenant configured for this host. Check tenants.json.');
  }
  req.tenant = tenant;
  req.tenantPaths = tenantPaths(tenant.id);
  next();
});

function buildAdminViewModel(req, extra) {
  const config = loadTenantConfig(req);
  const products = loadTenantProducts(req);
  const categories = loadTenantCategories(req);
  const permissions = getSupportPermissions(req.tenant.supportTier);

  return {
    tenant: req.tenant,
    permissions,
    config,
    categories,
    productsJson: JSON.stringify(products, null, 2),
    message: null,
    error: null,
    ...(extra || {})
  };
}

// Routes

// Storefront home
app.get('/', (req, res) => {
  const config = loadTenantConfig(req);
  const categories = loadTenantCategories(req);
  const allProducts = loadTenantProducts(req);

  const catSlug = req.query.category;
  let products = allProducts;

  if (catSlug) {
    const cat = categories.find((c) => c.slug === catSlug);
    if (cat) {
      products = allProducts.filter((p) => p.categoryId === cat.id);
    } else {
      products = [];
    }
  }

  res.render('index', {
    config,
    categories,
    products,
    activeCategory: catSlug || null,
    tenant: req.tenant
  });
});

// Product detail
app.get('/product/:id', (req, res) => {
  const config = loadTenantConfig(req);
  const products = loadTenantProducts(req);
  const product = products.find((p) => p.id === req.params.id);

  if (!product) {
    return res.status(404).send('Product not found');
  }

  res.render('product', {
    config,
    product,
    tenant: req.tenant
  });
});

// Checkout
app.post('/checkout', async (req, res) => {
  const config = loadTenantConfig(req);
  const products = loadTenantProducts(req);
  const { name, email, wallet, productId, notes, shippingMethodId, paymentMethodId } =
    req.body;

  const product = products.find((p) => p.id === productId);
  if (!product) {
    return res.status(400).send('Invalid product');
  }

  let totals;
  try {
    totals = calculateTotals(config, product, shippingMethodId, paymentMethodId);
  } catch (err) {
    return res.status(400).send(err.message);
  }

  const order = {
    id: Date.now().toString(),
    tenantId: req.tenant.id,
    productId: product.id,
    productName: product.name,
    price: Number(product.price) || 0,
    customerName: name,
    email,
    wallet: wallet || '',
    notes: notes || '',
    shippingMethodId,
    paymentMethodId,
    shippingMethodLabel: totals.shippingMethod.label,
    paymentMethodLabel: totals.paymentMethod.label,
    subtotal: totals.subtotal,
    shippingCost: totals.shippingCost,
    codFee: totals.codFee,
    gatewayFee: totals.gatewayFee,
    total: totals.total,
    paymentStatus: paymentMethodId === 'CARD' ? 'PENDING_STRIPE' : 'PENDING_COD',
    createdAt: new Date().toISOString()
  };

  console.log('[Thronos Commerce] New order:', JSON.stringify(order));

  appendTenantOrder(req, order);
  const proofHash = await recordOrderOnChain(order, req.tenant);

  res.render('thanks', {
    config,
    order,
    proofHash,
    tenant: req.tenant
  });
});

// Admin panel
app.get('/admin', (req, res) => {
  res.render('admin', buildAdminViewModel(req));
});

// Admin orders view
app.get('/admin/orders', (req, res) => {
  const config = loadTenantConfig(req);
  const allOrders = loadTenantOrders(req);
  const orders = allOrders.slice(-100).reverse();
  res.render('admin-orders', {
    tenant: req.tenant,
    config,
    orders,
    permissions: getSupportPermissions(req.tenant.supportTier)
  });
});

app.post('/admin/settings', async (req, res) => {
  const {
    password,
    storeName,
    primaryColor,
    accentColor,
    fontFamily,
    heroText,
    web3Domain,
    logoPath,
    themeMenuBg,
    themeMenuText,
    themeMenuActiveBg,
    themeMenuActiveText,
    themeButtonRadius
  } = req.body;

  const permissions = getSupportPermissions(req.tenant.supportTier);
  if (!permissions.canEditSettings) {
    return res
      .status(403)
      .render(
        'admin',
        buildAdminViewModel(req, {
          error: 'Το πακέτο υποστήριξης δεν επιτρέπει αλλαγή ρυθμίσεων.'
        })
      );
  }

  const ok = await verifyAdminPassword(req.tenant, password);
  if (!ok) {
    return res
      .status(401)
      .render(
        'admin',
        buildAdminViewModel(req, { error: 'Λάθος κωδικός διαχειριστή.' })
      );
  }

  const config = loadTenantConfig(req);
  config.storeName = storeName || config.storeName;
  config.primaryColor = primaryColor || config.primaryColor;
  config.accentColor = accentColor || config.accentColor;
  config.fontFamily = fontFamily || config.fontFamily;
  config.heroText = heroText || config.heroText;
  config.web3Domain = web3Domain || config.web3Domain;
  config.logoPath = logoPath || config.logoPath;
  config.theme = config.theme || {};
  config.theme.menuBg = themeMenuBg || config.theme.menuBg || '#111111';
  config.theme.menuText = themeMenuText || config.theme.menuText || '#ffffff';
  config.theme.menuActiveBg =
    themeMenuActiveBg || config.theme.menuActiveBg || '#f06292';
  config.theme.menuActiveText =
    themeMenuActiveText || config.theme.menuActiveText || '#ffffff';
  config.theme.buttonRadius =
    themeButtonRadius || config.theme.buttonRadius || '4px';

  saveJson(req.tenantPaths.config, config);

  res.render(
    'admin',
    buildAdminViewModel(req, { message: 'Οι ρυθμίσεις αποθηκεύτηκαν.' })
  );
});

// Shipping & Payment options editor
app.post('/admin/shipping-payment', async (req, res) => {
  const { password } = req.body;

  const permissions = getSupportPermissions(req.tenant.supportTier);
  if (!permissions.canEditSettings) {
    return res
      .status(403)
      .render('admin', buildAdminViewModel(req, {
        error: 'Το πακέτο υποστήριξης δεν επιτρέπει αλλαγή μεταφορικών/πληρωμών.'
      }));
  }

  const ok = await verifyAdminPassword(req.tenant, password);
  if (!ok) {
    return res
      .status(401)
      .render('admin', buildAdminViewModel(req, { error: 'Λάθος κωδικός διαχειριστή.' }));
  }

  const config = loadTenantConfig(req);

  // Update shippingOptions: only label, base, codFee — never touch id or allowedPaymentMethods
  (config.shippingOptions || []).forEach((opt, i) => {
    const label  = req.body[`ship_label_${i}`];
    const base   = req.body[`ship_base_${i}`];
    const codFee = req.body[`ship_codFee_${i}`];
    if (label  !== undefined) opt.label  = label;
    if (base   !== undefined) opt.base   = parseFloat(base)   || 0;
    if (codFee !== undefined) opt.codFee = parseFloat(codFee) || 0;
  });

  // Update paymentOptions: only label, gatewaySurchargePercent — never touch id or type
  (config.paymentOptions || []).forEach((opt, i) => {
    const label     = req.body[`pay_label_${i}`];
    const surcharge = req.body[`pay_surcharge_${i}`];
    if (label     !== undefined) opt.label                   = label;
    if (surcharge !== undefined) opt.gatewaySurchargePercent = parseFloat(surcharge) || 0;
  });

  saveJson(req.tenantPaths.config, config);

  res.render('admin', buildAdminViewModel(req, {
    message: 'Τα μεταφορικά και οι τρόποι πληρωμής αποθηκεύτηκαν.'
  }));
});

// Categories CRUD
app.post('/admin/categories/add', async (req, res) => {
  const { password, id, name, slug } = req.body;
  const permissions = getSupportPermissions(req.tenant.supportTier);
  if (!permissions.canEditCategories) {
    return res
      .status(403)
      .render(
        'admin',
        buildAdminViewModel(req, {
          error: 'Το πακέτο υποστήριξης δεν επιτρέπει αλλαγή κατηγοριών.'
        })
      );
  }

  const ok = await verifyAdminPassword(req.tenant, password);
  if (!ok) {
    return res
      .status(401)
      .render(
        'admin',
        buildAdminViewModel(req, { error: 'Λάθος κωδικός διαχειριστή.' })
      );
  }

  const categories = loadTenantCategories(req);
  if (categories.some((c) => c.id === id || c.slug === slug)) {
    return res
      .status(400)
      .render(
        'admin',
        buildAdminViewModel(req, {
          error: 'Υπάρχει ήδη κατηγορία με αυτό το id ή slug.'
        })
      );
  }

  categories.push({ id, name, slug });
  saveTenantCategories(req, categories);

  res.render(
    'admin',
    buildAdminViewModel(req, { message: 'Η κατηγορία προστέθηκε.' })
  );
});

app.post('/admin/categories/update', async (req, res) => {
  const { password, categoryId, name, slug } = req.body;
  const permissions = getSupportPermissions(req.tenant.supportTier);
  if (!permissions.canEditCategories) {
    return res
      .status(403)
      .render(
        'admin',
        buildAdminViewModel(req, {
          error: 'Το πακέτο υποστήριξης δεν επιτρέπει αλλαγή κατηγοριών.'
        })
      );
  }

  const ok = await verifyAdminPassword(req.tenant, password);
  if (!ok) {
    return res
      .status(401)
      .render(
        'admin',
        buildAdminViewModel(req, { error: 'Λάθος κωδικός διαχειριστή.' })
      );
  }

  const categories = loadTenantCategories(req);
  const idx = categories.findIndex((c) => c.id === categoryId);
  if (idx === -1) {
    return res
      .status(404)
      .render(
        'admin',
        buildAdminViewModel(req, { error: 'Η κατηγορία δεν βρέθηκε.' })
      );
  }

  if (
    slug &&
    categories.some((c) => c.id !== categoryId && c.slug === slug)
  ) {
    return res
      .status(400)
      .render(
        'admin',
        buildAdminViewModel(req, {
          error: 'Το slug χρησιμοποιείται ήδη από άλλη κατηγορία.'
        })
      );
  }

  categories[idx].name = name || categories[idx].name;
  categories[idx].slug = slug || categories[idx].slug;
  saveTenantCategories(req, categories);

  res.render(
    'admin',
    buildAdminViewModel(req, { message: 'Η κατηγορία ενημερώθηκε.' })
  );
});

app.post('/admin/categories/delete', async (req, res) => {
  const { password, categoryId } = req.body;
  const permissions = getSupportPermissions(req.tenant.supportTier);
  if (!permissions.canEditCategories) {
    return res
      .status(403)
      .render(
        'admin',
        buildAdminViewModel(req, {
          error: 'Το πακέτο υποστήριξης δεν επιτρέπει αλλαγή κατηγοριών.'
        })
      );
  }

  const ok = await verifyAdminPassword(req.tenant, password);
  if (!ok) {
    return res
      .status(401)
      .render(
        'admin',
        buildAdminViewModel(req, { error: 'Λάθος κωδικός διαχειριστή.' })
      );
  }

  const categories = loadTenantCategories(req);
  const filtered = categories.filter((c) => c.id !== categoryId);
  saveTenantCategories(req, filtered);

  res.render(
    'admin',
    buildAdminViewModel(req, { message: 'Η κατηγορία διαγράφηκε.' })
  );
});

// Product JSON editor
app.post('/admin/products', async (req, res) => {
  const { password, productsJson } = req.body;
  const permissions = getSupportPermissions(req.tenant.supportTier);
  if (!permissions.canEditProducts) {
    return res
      .status(403)
      .render(
        'admin',
        buildAdminViewModel(req, {
          error: 'Το πακέτο υποστήριξης δεν επιτρέπει αλλαγή προϊόντων.',
          productsJson
        })
      );
  }

  const ok = await verifyAdminPassword(req.tenant, password);
  if (!ok) {
    return res
      .status(401)
      .render(
        'admin',
        buildAdminViewModel(req, {
          error: 'Λάθος κωδικός διαχειριστή.',
          productsJson
        })
      );
  }

  try {
    const parsed = JSON.parse(productsJson);
    if (!Array.isArray(parsed)) {
      throw new Error('Το JSON πρέπει να είναι array.');
    }
    saveJson(req.tenantPaths.products, parsed);
    res.render(
      'admin',
      buildAdminViewModel(req, {
        message: 'Τα προϊόντα αποθηκεύτηκαν.',
        productsJson: JSON.stringify(parsed, null, 2)
      })
    );
  } catch (err) {
    res.status(400).render(
      'admin',
      buildAdminViewModel(req, {
        error: 'Σφάλμα στο JSON προϊόντων: ' + err.message,
        productsJson
      })
    );
  }
});

// Image upload
app.post(
  '/admin/upload-image',
  upload.single('image'),
  async (req, res) => {
    const permissions = getSupportPermissions(req.tenant.supportTier);
    if (!permissions.canUploadMedia) {
      return res
        .status(403)
        .json({ ok: false, error: 'Upload not allowed for this support tier.' });
    }

    const password = req.body.password;
    const ok = await verifyAdminPassword(req.tenant, password);
    if (!ok) {
      return res.status(401).json({ ok: false, error: 'Invalid admin password.' });
    }

    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No file uploaded.' });
    }

    const url = `/tenants/${req.tenant.id}/media/${req.file.filename}`;
    return res.json({ ok: true, url });
  }
);

// Thronos Commerce marketing landing
app.get('/thronos-commerce', (req, res) => {
  const packages = [
    {
      id: 'MANAGEMENT_START',
      title: 'Management Start',
      description:
        'Ιδανικό για μικρά brands που θέλουν managed setup, χωρίς WordPress / WooCommerce.',
      features: [
        'Στήσιμο e-shop πάνω στο Thronos Commerce',
        'Βασικό theme & λογότυπο',
        'Admin panel για προϊόντα',
        'Σύνδεση με δικό σας domain & email'
      ]
    },
    {
      id: 'FULL_OPS_START',
      title: 'Full Ops Start',
      description:
        'Για brands που θέλουν πλήρη διαχείριση λειτουργίας από την ομάδα Thronos.',
      features: [
        'Όλα του Management Start',
        'Πλήρης διαχείριση προϊόντων & περιεχομένου',
        'Παρακολούθηση παραγγελιών & επικοινωνίας',
        'Συμβουλευτικό growth roadmap'
      ]
    }
  ];

  res.render('landing', { packages, message: null });
});

app.post('/thronos-commerce/offer', (req, res) => {
  const lead = {
    id: `lead_${Date.now()}`,
    createdAt: new Date().toISOString(),
    ...req.body
  };
  console.log('New Thronos Commerce lead:', lead);

  const leadsFile = path.join(DATA_ROOT, 'leads.json');
  const leads = loadJson(leadsFile, []);
  leads.push(lead);
  saveJson(leadsFile, leads);

  const packages = [
    {
      id: 'MANAGEMENT_START',
      title: 'Management Start',
      description:
        'Ιδανικό για μικρά brands που θέλουν managed setup, χωρίς WordPress / WooCommerce.',
      features: [
        'Στήσιμο e-shop πάνω στο Thronos Commerce',
        'Βασικό theme & λογότυπο',
        'Admin panel για προϊόντα',
        'Σύνδεση με δικό σας domain & email'
      ]
    },
    {
      id: 'FULL_OPS_START',
      title: 'Full Ops Start',
      description:
        'Για brands που θέλουν πλήρη διαχείριση λειτουργίας από την ομάδα Thronos.',
      features: [
        'Όλα του Management Start',
        'Πλήρης διαχείριση προϊόντων & περιεχομένου',
        'Παρακολούθηση παραγγελιών & επικοινωνίας',
        'Συμβουλευτικό growth roadmap'
      ]
    }
  ];

  res.render('landing', {
    packages,
    message: 'Ευχαριστούμε! Θα επικοινωνήσουμε μαζί σας σύντομα.'
  });
});

// ─── Root Admin: Tenants Management ──────────────────────────────────────────

const SUPPORT_TIERS = ['SELF_SERVICE', 'MANAGEMENT_START', 'FULL_OPS_START'];

function buildRootViewModel(extra) {
  const tenants = loadTenantsRegistry();
  return { tenants, message: null, error: null, ...(extra || {}) };
}

app.get('/root/tenants', (req, res) => {
  res.render('root-tenants', buildRootViewModel());
});

app.post('/root/tenants/create', async (req, res) => {
  const { rootPassword, id, domain, supportTier, adminPasswordPlain, templateId } = req.body;

  if (!verifyRootPassword(rootPassword)) {
    return res.status(401).render('root-tenants',
      buildRootViewModel({ error: 'Λάθος root κωδικός.' }));
  }

  const cleanId = (id || '').trim();
  if (!cleanId || !/^[a-z0-9_-]+$/i.test(cleanId)) {
    return res.status(400).render('root-tenants',
      buildRootViewModel({ error: 'Το tenant id είναι υποχρεωτικό και επιτρέπονται μόνο a-z, 0-9, _ και -.' }));
  }

  if (!adminPasswordPlain) {
    return res.status(400).render('root-tenants',
      buildRootViewModel({ error: 'Ο κωδικός admin είναι υποχρεωτικός.' }));
  }

  const tenants = loadTenantsRegistry();
  if (tenants.some((t) => t.id === cleanId)) {
    return res.status(400).render('root-tenants',
      buildRootViewModel({ error: `Υπάρχει ήδη tenant με id "${cleanId}".` }));
  }

  const adminPasswordHash = await bcrypt.hash(adminPasswordPlain, 10);
  const resolvedTier = SUPPORT_TIERS.includes(supportTier) ? supportTier : 'SELF_SERVICE';

  const newTenant = {
    id: cleanId,
    domain: (domain || '').trim(),
    supportTier: resolvedTier,
    adminPasswordHash,
    createdAt: new Date().toISOString(),
    active: true
  };

  seedTenantFilesFromTemplate(cleanId, (templateId || '').trim() || 'demo');
  tenants.push(newTenant);
  saveTenantsRegistry(tenants);
  console.log(`[Root Admin] Created tenant: ${cleanId} (${resolvedTier})`);

  res.render('root-tenants',
    buildRootViewModel({ message: `Ο tenant "${cleanId}" δημιουργήθηκε επιτυχώς.` }));
});

app.post('/root/tenants/update', (req, res) => {
  const { rootPassword, tenantId, domain, supportTier, active } = req.body;

  if (!verifyRootPassword(rootPassword)) {
    return res.status(401).render('root-tenants',
      buildRootViewModel({ error: 'Λάθος root κωδικός.' }));
  }

  const tenants = loadTenantsRegistry();
  const idx = tenants.findIndex((t) => t.id === tenantId);
  if (idx === -1) {
    return res.status(404).render('root-tenants',
      buildRootViewModel({ error: `Tenant "${tenantId}" δεν βρέθηκε.` }));
  }

  if (domain !== undefined) tenants[idx].domain = (domain || '').trim();
  if (supportTier && SUPPORT_TIERS.includes(supportTier)) tenants[idx].supportTier = supportTier;
  tenants[idx].active = active === 'true' || active === '1' || active === 'on';

  saveTenantsRegistry(tenants);
  console.log(`[Root Admin] Updated tenant: ${tenantId}`);

  res.render('root-tenants',
    buildRootViewModel({ message: `Ο tenant "${tenantId}" ενημερώθηκε.` }));
});

app.post('/root/tenants/reset-admin-password', async (req, res) => {
  const { rootPassword, tenantId, newPassword } = req.body;

  if (!verifyRootPassword(rootPassword)) {
    return res.status(401).render('root-tenants',
      buildRootViewModel({ error: 'Λάθος root κωδικός.' }));
  }

  if (!newPassword) {
    return res.status(400).render('root-tenants',
      buildRootViewModel({ error: 'Ο νέος κωδικός είναι υποχρεωτικός.' }));
  }

  const tenants = loadTenantsRegistry();
  const idx = tenants.findIndex((t) => t.id === tenantId);
  if (idx === -1) {
    return res.status(404).render('root-tenants',
      buildRootViewModel({ error: `Tenant "${tenantId}" δεν βρέθηκε.` }));
  }

  tenants[idx].adminPasswordHash = await bcrypt.hash(newPassword, 10);
  saveTenantsRegistry(tenants);
  console.log(`[Root Admin] Reset admin password for tenant: ${tenantId}`);

  res.render('root-tenants',
    buildRootViewModel({ message: `Ο κωδικός admin για τον tenant "${tenantId}" ενημερώθηκε.` }));
});

// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Thronos Commerce running on port ${PORT}`);
});
