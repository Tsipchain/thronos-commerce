'use strict';

function date(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

function appendHistory(customer, entry) {
  if (!Array.isArray(customer.subscriptionHistory)) customer.subscriptionHistory = [];
  customer.subscriptionHistory.push(entry);
}

function activatePaidSubscription(customers, order, products, nowValue) {
  if (!order || order.paymentStatus !== 'PAID' || !order.id) return { activated: false, reason: 'unverified_payment' };
  const email = String(order.userEmail || order.email || '').trim().toLowerCase();
  const customer = (Array.isArray(customers) ? customers : []).find((row) => String(row.email || '').trim().toLowerCase() === email);
  if (!customer) return { activated: false, reason: 'customer_not_found' };
  const history = Array.isArray(customer.subscriptionHistory) ? customer.subscriptionHistory : [];
  if ((customer.subscription && customer.subscription.sourceOrderId === order.id) || history.some((entry) => entry.sourceOrderId === order.id && entry.action === 'payment_activation')) {
    return { activated: false, reason: 'already_processed', customer };
  }
  const catalog = Array.isArray(products) ? products : [];
  const items = Array.isArray(order.items) && order.items.length ? order.items : [{ id: order.productId, qty: 1 }];
  const plans = items.map((item) => {
    if (Object.prototype.hasOwnProperty.call(item, 'subscriptionEntitlement')) {
      const entitlement = item.subscriptionEntitlement;
      const durationDays = Number(entitlement && entitlement.durationDays);
      if (!entitlement || !entitlement.plan || !Number.isInteger(durationDays) || durationDays <= 0) return null;
      return { plan: String(entitlement.plan), durationDays: durationDays * Math.max(1, Number(item.qty) || 1) };
    }
    // Compatibility for orders created before entitlement snapshots existed.
    const product = catalog.find((row) => row.id === item.id);
    const durationDays = Number(product && product.subscriptionDurationDays);
    if (!product || !product.subscriptionPlan || !Number.isInteger(durationDays) || durationDays <= 0) return null;
    return { plan: String(product.subscriptionPlan), durationDays: durationDays * Math.max(1, Number(item.qty) || 1) };
  }).filter(Boolean);
  if (!plans.length) return { activated: false, reason: 'no_subscription_product' };
  const now = date(nowValue) || new Date();
  const currentExpiry = date(customer.subscription && customer.subscription.expiresAt);
  const base = currentExpiry && currentExpiry > now ? currentExpiry : now;
  const durationDays = plans.reduce((sum, plan) => sum + plan.durationDays, 0);
  const expiresAt = new Date(base.getTime() + durationDays * 86400000);
  const startedAt = date(customer.subscription && customer.subscription.startedAt) || now;
  customer.subscription = {
    status: 'active', plan: plans.map((plan) => plan.plan).join(' + '),
    startedAt: startedAt.toISOString(), expiresAt: expiresAt.toISOString(), cancelledAt: null,
    sourceOrderId: order.id, updatedAt: now.toISOString()
  };
  appendHistory(customer, { action: 'payment_activation', timestamp: now.toISOString(), resultingStatus: 'active', resultingExpiry: expiresAt.toISOString(), source: 'verified_payment', sourceOrderId: order.id });
  return { activated: true, customer, durationDays };
}

function applyManualSubscriptionAction(customer, input, nowValue) {
  if (!customer) throw new Error('Customer not found.');
  const action = String(input && input.action || 'grant');
  if (!['grant', 'extend', 'cancel', 'reactivate'].includes(action)) throw new Error('Invalid subscription action.');
  const now = date(nowValue) || new Date();
  const current = customer.subscription && typeof customer.subscription === 'object' ? customer.subscription : {};
  let expiry = date(input && input.expiresAt);
  const durationDays = Number(input && input.durationDays);
  if (!expiry && Number.isInteger(durationDays) && durationDays > 0) {
    const existingExpiry = date(current.expiresAt);
    const base = action === 'extend' && existingExpiry && existingExpiry > now ? existingExpiry : now;
    expiry = new Date(base.getTime() + durationDays * 86400000);
  }
  if (action !== 'cancel' && !expiry) throw new Error('A duration or expiry date is required.');
  const status = action === 'cancel' ? 'cancelled' : 'active';
  customer.subscription = {
    ...current,
    status,
    plan: String(input && input.plan || current.plan || 'Video subscription').trim(),
    startedAt: current.startedAt || now.toISOString(),
    expiresAt: expiry ? expiry.toISOString() : current.expiresAt || null,
    cancelledAt: action === 'cancel' ? now.toISOString() : null,
    updatedAt: now.toISOString()
  };
  appendHistory(customer, { action, timestamp: now.toISOString(), resultingStatus: status, resultingExpiry: customer.subscription.expiresAt, source: 'admin_manual' });
  return customer.subscription;
}

module.exports = { activatePaidSubscription, applyManualSubscriptionAction };
