'use strict';

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getCustomerSubscriptionStatus(customer, tenant, nowValue) {
  const now = validDate(nowValue) || new Date();
  const subscription = customer && customer.subscription && typeof customer.subscription === 'object'
    ? customer.subscription
    : {};
  const rawStatus = String(subscription.status || customer && customer.subscriptionStatus || '').toLowerCase();
  const startsAt = validDate(subscription.startedAt || subscription.startsAt || subscription.startDate || customer && customer.subscriptionStart);
  const expiresAt = validDate(subscription.expiresAt || subscription.renewsAt || customer && customer.subscriptionExpiry);
  const cancelledAt = validDate(subscription.cancelledAt || customer && customer.subscriptionCancelledAt);
  let status = 'none';
  if (rawStatus === 'cancelled' || cancelledAt) status = 'cancelled';
  else if (expiresAt && expiresAt.getTime() <= now.getTime()) status = 'expired';
  else if (rawStatus === 'active' || (expiresAt && expiresAt.getTime() > now.getTime())) status = 'active';
  return {
    status,
    active: status === 'active',
    plan: String(subscription.plan || customer && customer.subscriptionPlan || ''),
    startsAt: startsAt ? startsAt.toISOString() : null,
    startedAt: startsAt ? startsAt.toISOString() : null,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    cancelledAt: cancelledAt ? cancelledAt.toISOString() : null,
    sourceOrderId: String(subscription.sourceOrderId || ''),
    tenantId: tenant && tenant.id ? String(tenant.id) : null
  };
}

module.exports = { getCustomerSubscriptionStatus };
