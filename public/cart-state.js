(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ThrcCartState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  function identity(item) {
    if (item && item.cartKey) return String(item.cartKey);
    const id = String(item && item.id || '');
    const variant = String(item && item.variantId || '');
    return variant ? `${id}::variant:${variant}` : id;
  }
  function isKitComponent(item) { return !!(item && item.sourceKitCartKey); }
  function visibleItems(cart) { return (Array.isArray(cart) ? cart : []).filter((item) => !isKitComponent(item)); }
  function add(cart, product) {
    const next = Array.isArray(cart) ? cart.map((item) => ({ ...item })) : [];
    const key = identity(product);
    const index = next.findIndex((item) => identity(item) === key);
    if (index >= 0) {
      const stock = next[index].stock === null || next[index].stock === undefined || next[index].stock === '' ? NaN : Number(next[index].stock);
      const qty = Number(next[index].qty) || 1;
      if (!Number.isFinite(stock) || stock < 0 || qty < stock) next[index].qty = qty + 1;
    } else {
      next.push({ ...product, qty: 1, cartKey: key });
    }
    return next;
  }
  function groupedIndexes(cart, key) {
    const index = cart.findIndex((item) => identity(item) === key);
    if (index < 0) return [];
    const item = cart[index];
    if (!item.isKitSummary) return [index];
    return cart.reduce((indexes, candidate, candidateIndex) => {
      if (candidateIndex === index || candidate.sourceKitCartKey === key) indexes.push(candidateIndex);
      return indexes;
    }, []);
  }
  function change(cart, key, delta) {
    const next = Array.isArray(cart) ? cart.map((item) => ({ ...item })) : [];
    const indexes = groupedIndexes(next, key);
    if (!indexes.length || !delta) return next;
    const current = Number(next[indexes[0]].qty) || 1;
    if (delta > 0) {
      const blocked = indexes.some((index) => {
        const stock = next[index].stock === null || next[index].stock === undefined || next[index].stock === '' ? NaN : Number(next[index].stock);
        return Number.isFinite(stock) && stock >= 0 && current >= stock;
      });
      if (blocked) return next;
    }
    if (current + delta <= 0) return next.filter((_, index) => !indexes.includes(index));
    indexes.forEach((index) => { next[index].qty = current + delta; });
    return next;
  }
  function removeLine(cart, key) {
    const source = Array.isArray(cart) ? cart : [];
    const indexes = groupedIndexes(source, key);
    return source.filter((_, index) => !indexes.includes(index));
  }
  function subtotal(cart) {
    return (Array.isArray(cart) ? cart : []).reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.qty) || 1), 0);
  }
  function badgeCount(cart) {
    return visibleItems(cart).reduce((sum, item) => sum + (Number(item.qty) || 1), 0);
  }
  return { identity, isKitComponent, visibleItems, add, change, removeLine, subtotal, badgeCount };
});
