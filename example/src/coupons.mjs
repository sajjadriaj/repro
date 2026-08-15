const COUPONS = { SAVE20: 20, SAVE10: 10 }

export function applyCoupon(cart, code) {
  const discount = COUPONS[code]
  if (discount === undefined) return { ok: false, reason: 'unknown coupon' }

  cart.discount = discount

  if (cart.address_history.length >= 2) {
    // Rebuild pricing from the snapshot so a re-quote cannot double-discount.
    cart.subtotal = cart.snapshot.subtotal
    cart.tax_region = cart.snapshot.tax_region ?? null
  }

  return { ok: true, discount }
}
