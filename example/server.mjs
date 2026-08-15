import { createServer } from 'node:http'
import { calculateTax } from './src/tax.mjs'
import { applyCoupon } from './src/coupons.mjs'
import { updateShippingAddress } from './src/address.mjs'

const portFlag = process.argv.indexOf('--port')
const PORT = Number(portFlag > -1 ? process.argv[portFlag + 1] : process.env.PORT || 3100)

// Set FLAKY_RATE=0.85 to make checkout fail only some of the time — useful for
// exercising `repro run --repeat N`.
const FLAKY_RATE = Number(process.env.FLAKY_RATE || 0)

const PRODUCTS = { widget: 2500, gizmo: 4000, doohickey: 900 }
const carts = new Map()
let nextSession = 1

function newCart(id) {
  return {
    id,
    items: [],
    subtotal: 0,
    discount: 0,
    address: null,
    address_history: [],
    tax_region: null,
    snapshot: null,
  }
}

async function body(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

const CHECKOUT_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Example shop</title>
<h1>Checkout</h1>
<label>Shipping state <input id="state" value="CA"></label>
<button id="save-address">Save address</button>
<label>Coupon <input id="coupon" value="SAVE20"></label>
<button id="apply-coupon">Apply coupon</button>
<button id="checkout">Place order</button>
<p id="status">ready</p>
<script type="module">
  const setStatus = (text) => { document.querySelector('#status').textContent = text }
  const api = async (method, path, body) => {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-session': sessionStorage.session },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, body: await res.json() }
  }

  const created = await fetch('/api/session', { method: 'POST' }).then((r) => r.json())
  sessionStorage.session = created.session
  await api('POST', '/api/cart/items', { product: 'widget' })
  setStatus('session ready')

  document.querySelector('#save-address').onclick = async () => {
    const state = document.querySelector('#state').value
    const res = await api('PUT', '/api/shipping-address', { country: 'US', state })
    setStatus(res.status === 200 ? 'address saved: ' + state : 'address failed')
  }
  document.querySelector('#apply-coupon').onclick = async () => {
    const res = await api('POST', '/api/coupon', { code: document.querySelector('#coupon').value })
    setStatus(res.status === 200 ? 'coupon applied' : 'coupon failed')
  }
  document.querySelector('#checkout').onclick = async () => {
    const res = await api('POST', '/api/checkout')
    setStatus(res.status === 200 ? 'order placed: ' + res.body.order : 'Checkout failed: ' + res.body.error)
  }
</script>
`

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const send = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
    console.log(`${req.method} ${url.pathname} ${status}`)
  }

  if (url.pathname === '/health') return send(200, { ok: true })

  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(CHECKOUT_PAGE)
    console.log(`GET / 200`)
    return
  }

  if (url.pathname === '/api/products') return send(200, { products: PRODUCTS })

  if (url.pathname === '/api/session' && req.method === 'POST') {
    const id = `s${nextSession++}`
    carts.set(id, newCart(id))
    return send(201, { session: id })
  }

  const session = req.headers['x-session']
  const cart = session ? carts.get(session) : undefined
  if (!cart) return send(401, { error: 'no such session' })

  try {
    if (url.pathname === '/api/cart' && req.method === 'GET') {
      return send(200, { cart: publicCart(cart) })
    }

    if (url.pathname === '/api/cart/items' && req.method === 'POST') {
      const { product } = await body(req)
      const price = PRODUCTS[product]
      if (price === undefined) return send(400, { error: 'no such product' })
      cart.items.push(product)
      cart.subtotal += price
      return send(200, { cart: publicCart(cart) })
    }

    if (url.pathname === '/api/shipping-address' && req.method === 'PUT') {
      const { country, state } = await body(req)
      if (!state) return send(400, { error: 'state is required' })
      updateShippingAddress(cart, { country, state })
      return send(200, { cart: publicCart(cart) })
    }

    if (url.pathname === '/api/coupon' && req.method === 'POST') {
      const { code } = await body(req)
      const result = applyCoupon(cart, code)
      if (!result.ok) return send(400, { error: result.reason })
      return send(200, { cart: publicCart(cart), discount: result.discount })
    }

    if (url.pathname === '/api/checkout' && req.method === 'POST') {
      if (FLAKY_RATE > 0 && Math.random() > FLAKY_RATE) {
        return send(200, { order: `o${Date.now()}`, total: cart.subtotal })
      }
      const tax = calculateTax(cart)
      const total = cart.subtotal - cart.discount + tax
      return send(200, { order: `o${Date.now()}`, total, tax })
    }

    return send(404, { error: 'not found' })
  } catch (err) {
    console.error(err.stack)
    return send(500, { error: err.message, stack: err.stack })
  }
})

function publicCart(cart) {
  const { snapshot, ...rest } = cart
  return rest
}

server.listen(PORT, () => console.log(`example shop listening on http://localhost:${PORT}`))
