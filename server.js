const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();

// Paths
const DATA_DIR = path.join(__dirname, "data");
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");
const CONFIG_FILE = path.join(DATA_DIR, "store-config.json");

// Basic helpers
function loadJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`Could not load ${filePath}:`, err.message);
    return fallback;
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function loadProducts() {
  return loadJson(PRODUCTS_FILE, []);
}

function loadConfig() {
  return loadJson(CONFIG_FILE, {
    storeName: "Thronos Demo Store",
    primaryColor: "#222222",
    accentColor: "#00ff88",
    fontFamily:
      "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    heroText: "Καλωσήρθατε στο Thronos Commerce!",
    web3Domain: "",
    logoPath: "/logo.png"
  });
}

// Blockchain stub – εδώ “κουμπώνεις” Thronos chain αργότερα
function recordOrderOnChain(order) {
  const payload = {
    orderId: order.id,
    total: order.total,
    timestamp: order.createdAt,
    customerEmail: order.email
  };

  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");

  console.log("Thronos Commerce – order hash (to be recorded on-chain):", hash);

  // TODO: μελλοντικά στείλτο σε THRONOS_CHAIN_NODE_URL (HTTP POST)
  // if (process.env.THRONOS_NODE_URL) { ... }

  return hash;
}

// View engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Static + body parsing
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));

// Home – λίστα προϊόντων
app.get("/", (req, res) => {
  const products = loadProducts();
  const config = loadConfig();
  res.render("index", { products, config });
});

// Product page
app.get("/product/:id", (req, res) => {
  const products = loadProducts();
  const config = loadConfig();
  const product = products.find((p) => p.id === req.params.id);

  if (!product) {
    return res.status(404).send("Product not found");
  }

  res.render("product", { product, config });
});

// Checkout – demo φόρμα
app.post("/checkout", (req, res) => {
  const products = loadProducts();
  const config = loadConfig();

  const { name, email, wallet, productId, notes } = req.body;
  const product = products.find((p) => p.id === productId);

  if (!product) {
    return res.status(400).send("Invalid product");
  }

  const order = {
    id: Date.now().toString(),
    productId: product.id,
    productName: product.name,
    price: product.price,
    customerName: name,
    email,
    wallet: wallet || "",
    notes: notes || "",
    createdAt: new Date().toISOString(),
    total: product.price
  };

  console.log("New order received:", order);

  const proofHash = recordOrderOnChain(order);

  res.render("thanks", { order, proofHash, config });
});

// -------- ADMIN PANEL --------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";

// πόρτα διαχείρισης
app.get("/admin", (req, res) => {
  const config = loadConfig();
  const products = loadProducts();

  res.render("admin", {
    config,
    productsJson: JSON.stringify(products, null, 2),
    message: null,
    error: null
  });
});

app.post("/admin/settings", (req, res) => {
  const { password, storeName, primaryColor, accentColor, fontFamily, heroText, web3Domain, logoPath } =
    req.body;

  if (password !== ADMIN_PASSWORD) {
    const config = loadConfig();
    const products = loadProducts();
    return res.status(401).render("admin", {
      config,
      productsJson: JSON.stringify(products, null, 2),
      message: null,
      error: "Λάθος κωδικός διαχειριστή."
    });
  }

  const config = loadConfig();
  config.storeName = storeName || config.storeName;
  config.primaryColor = primaryColor || config.primaryColor;
  config.accentColor = accentColor || config.accentColor;
  config.fontFamily = fontFamily || config.fontFamily;
  config.heroText = heroText || config.heroText;
  config.web3Domain = web3Domain || config.web3Domain;
  config.logoPath = logoPath || config.logoPath;

  saveJson(CONFIG_FILE, config);

  const products = loadProducts();

  res.render("admin", {
    config,
    productsJson: JSON.stringify(products, null, 2),
    message: "Οι ρυθμίσεις αποθηκεύτηκαν.",
    error: null
  });
});

app.post("/admin/products", (req, res) => {
  const { password, productsJson } = req.body;

  if (password !== ADMIN_PASSWORD) {
    const config = loadConfig();
    const products = loadProducts();
    return res.status(401).render("admin", {
      config,
      productsJson: JSON.stringify(products, null, 2),
      message: null,
      error: "Λάθος κωδικός διαχειριστή."
    });
  }

  try {
    const parsed = JSON.parse(productsJson);
    if (!Array.isArray(parsed)) {
      throw new Error("Products JSON must be an array.");
    }
    saveJson(PRODUCTS_FILE, parsed);

    const config = loadConfig();
    res.render("admin", {
      config,
      productsJson: JSON.stringify(parsed, null, 2),
      message: "Τα προϊόντα αποθηκεύτηκαν.",
      error: null
    });
  } catch (err) {
    const config = loadConfig();
    const currentProducts = loadProducts();
    res.status(400).render("admin", {
      config,
      productsJson: productsJson,
      message: null,
      error: "Σφάλμα στο JSON προϊόντων: " + err.message
    });
  }
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Thronos Commerce running on port ${PORT}`);
});
