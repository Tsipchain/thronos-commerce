const express = require('express');
const path = require('path');

// Load product data from the JSON file.  In a real
// deployment you would likely pull this from a database.
const products = require('./data/products.json');

const app = express();

// Set EJS as the view engine and configure the views directory.
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files (e.g. CSS) from the public folder.
app.use(express.static(path.join(__dirname, 'public')));

// Parse URL‑encoded and JSON bodies for order submissions.
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/**
 * Home page route.
 * Renders a list of products with links to each product's details page.
 */
app.get('/', (req, res) => {
  res.render('index', { products });
});

/**
 * Product details route.
 * Finds a product by its id and displays information along with a simple
 * order form.  If the product is not found a 404 message is shown.
 */
app.get('/product/:id', (req, res) => {
  const product = products.find((p) => p.id === req.params.id);
  if (!product) {
    res.status(404).send('Product not found');
    return;
  }
  res.render('product', { product });
});

/**
 * Checkout route.
 * Receives an order, logs it to the console and thanks the customer.  A real
 * implementation would persist orders to a database and send confirmation
 * emails.
 */
app.post('/checkout', (req, res) => {
  const { name, email, product: productId } = req.body;
  const product = products.find((p) => p.id === productId);
  const order = { name, email, product };
  // In a production system you'd write this to a database and handle payment.
  console.log('New order received:', order);
  res.render('thanks', { order });
});

// Start the server on the specified port or default to 3000.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Thronos Commerce demo running on port ${PORT}`);
});