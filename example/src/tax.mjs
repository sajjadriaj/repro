const RATES = { CA: 0.0925, WA: 0.065, NY: 0.08, TX: 0.0625 }

export function calculateTax(cart) {
  const region = cart.tax_region.toUpperCase()
  const rate = RATES[region] ?? 0
  return Math.round(cart.subtotal * rate)
}
