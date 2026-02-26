# Thronos Commerce Demo Store

This repository contains a minimal demo of a custom e‑commerce storefront built with
[Express](https://expressjs.com/) and [EJS](https://ejs.co/) templates.  It is
designed to show how you can serve a simple online store without
relying on heavyweight solutions like WordPress or WooCommerce.  Use it as a
starting point for your own projects or as a proof of concept for your
multi‑tenant SaaS idea.

## Features

- List of products loaded from a JSON file
- Product detail pages with descriptions and prices
- Simple checkout form that captures customer name and email
- Order confirmation page that acknowledges the purchase (orders are
  currently logged to the console for demonstration purposes)
- Basic styling with a responsive layout
- Clean separation of templates, static assets and server code

## Platform Vision (Thronos Commerce Multi‑Tenant)

This demo is intended as the seed of a **multi‑tenant SaaS platform** for
e‑commerce.  The goal of *Thronos Commerce* is to let you host many online
stores under a single codebase, while each client (tenant) maintains their
own product catalogue, orders and branding.  To evolve this demo into a
multi‑tenant platform:

* Introduce a **Tenant** concept (for example via a `tenant_id` in the URL
  or sub‑domain such as `shopname.thronoscommerce.com`).  Each tenant’s data
  (products, orders, settings) can live in its own database schema or
  separate database.
* Provide an **admin dashboard** for store owners to manage products, orders
  and settings.
* Implement **user authentication** (for store owners and staff) and
  **customer accounts** (for shoppers).
* Create a **billing module** to charge tenants a monthly fee for using
  the platform (e.g. via Stripe subscription plans).
* Build a **provisioning API** so new tenants can sign up and have a store
  created automatically, including domain mapping and SSL certificates.

This vision keeps the core of the application lightweight and avoids the
heavy overhead of platforms like WordPress/WooCommerce.

## Payment Integration (Stripe)

The current checkout form simply logs the order.  To accept real
payments you can integrate with [Stripe](https://stripe.com/).  A simple
approach is to collect the customer’s email and create a **Payment
Intent** server‑side.  For example, in `server.js` you could add:

```js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

app.post('/create-payment-intent', async (req, res) => {
  const { amount, currency } = req.body;
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      automatic_payment_methods: { enabled: true },
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unable to create payment intent' });
  }
});
```

Then on the client (template), you would use Stripe.js to confirm the
payment.  Remember **never** to expose your secret key in the browser;
always use environment variables on the server side.

## Domains and Hosting

While this demo runs with Node.js on your own server (for example a VPS
like *Rayil*), you may choose to register domains and provide email
services for your tenants via a hosting provider such as Papaki.  Papaki’s
`Large` plan offers approximately 15 GB SSD storage and unlimited sites
with a renewal price of ~151.9 € per year and includes a free `.gr` domain
for two years【794338023772968†L99-L151】.  Because this application is
Node‑based, you would typically deploy it on your own VPS and use Papaki
for DNS/email; shared PHP hosting is not suitable for Node applications.

## Migration and Scaling

If you start by hosting clients on shared resources (e.g. Papaki) and later
wish to move them to your own data centre, design your deployment process
to be portable.  Use environment variables for configuration, keep
tenant‑specific data isolated, and implement automated backups and
restores.  This will allow you to migrate each tenant with minimal
downtime.

## Prerequisites

- [Node.js](https://nodejs.org/) (version 14 or later) installed on your
  server
- A command line with `npm` available

## Getting Started

1. **Install dependencies**

   Navigate to the project directory and run:

   ```bash
   npm install
   ```

2. **Start the server**

   ```bash
   npm start
   ```

   By default the application listens on port `3000`.  You can change this by
   setting the environment variable `PORT` before starting the server.

3. **Open the store in your browser**

   Navigate to `http://localhost:3000` (or whichever host/port you deployed
   the application to).  You should see a list of products.  Click on a
   product to view its details and fill in the order form to simulate
   purchasing the item.

## Customising the Demo

- **Products**: Edit the `data/products.json` file to change the product
  catalogue.  Each product must have an `id`, `name`, `price` and
  `description`.  You can add additional fields as needed.

- **Styling**: Modify `public/styles.css` to adjust colours, fonts and
  layout.  The styles are kept intentionally simple to be easy to adapt.

- **Templates**: The page templates live in the `views/` directory and use
  [EJS](https://ejs.co/) syntax.  You can add new pages or change the
  structure of the existing ones.

- **Order Handling**: In `server.js` the `/checkout` handler currently
  logs incoming orders to the console.  Replace this with logic to save
  orders to a database, send confirmation emails or integrate with a
  payment provider as required.

## Deployment

To deploy this application to a production server you can copy the
directory to your host, install the dependencies, and configure a process
manager like `pm2` or `systemd` to keep the node process running.  You can
also containerise the app using Docker.  For a multi‑tenant SaaS
architecture you would evolve this demo into a platform that creates a
separate schema or database per tenant and adds authentication, admin
panels and billing.

## License

This project is made available under the MIT License.  Feel free to use
and modify it for personal or commercial purposes.