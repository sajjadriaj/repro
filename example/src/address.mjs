export function updateShippingAddress(cart, { country, state }) {
  // Pricing snapshot is taken on the first address write only.
  cart.snapshot ??= { subtotal: cart.subtotal, discount: cart.discount }

  cart.address_history.push({ country, state })
  cart.address = { country: country ?? cart.address?.country ?? null, state }
  cart.tax_region = state
  return cart
}
