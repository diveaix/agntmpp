export type Chain = 'ethereum' | 'near' | 'zcash'

// Official NEAR symbol from the NEAR documentation logo, without the wordmark.
// https://raw.githubusercontent.com/near/docs/master/assets/logo.svg
const nearPath = 'm421.61,108c-13,0-25.07,6.74-31.88,17.82l-73.37,108.93c-2.39,3.59-1.42,8.43,2.17,10.82,2.91,1.94,6.76,1.7,9.41-.58l72.22-62.64c1.2-1.08,3.05-.97,4.13.23.49.55.75,1.26.75,1.99v196.12c0,1.62-1.31,2.92-2.93,2.92-.87,0-1.69-.38-2.24-1.05L181.56,121.24c-7.11-8.39-17.55-13.23-28.54-13.24h-7.63c-20.65,0-37.39,16.74-37.39,37.39v276.22c0,20.65,16.74,37.39,37.39,37.39,13,0,25.07-6.74,31.88-17.82l73.37-108.93c2.39-3.59,1.42-8.43-2.17-10.82-2.91-1.94-6.76-1.7-9.41.58l-72.22,62.64c-1.2,1.08-3.05.97-4.13-.23-.49-.55-.75-1.26-.74-1.99v-196.17c0-1.62,1.31-2.92,2.93-2.92.86,0,1.69.38,2.24,1.05l218.28,261.37c7.11,8.39,17.55,13.23,28.54,13.24h7.63c20.65.01,37.4-16.72,37.42-37.37V145.39c0-20.65-16.74-37.39-37.39-37.39Z'

// Identical symbol path to public/chains/zcash.svg, centered on its own bounds.
const zcashPath = 'm246.92,186.54v11.19l-31.13,42.23h31.13v14.85h-20.07v12.3h-12.34v-12.3h-20.07v-11.19l31.1-42.23h-31.1v-14.85h20.07v-12.34h12.34v12.34h20.07Z'

/** Draw on a logical 512px square; the caller controls backing resolution. */
export function drawChainSymbol(ctx: CanvasRenderingContext2D, chain: Chain) {
  ctx.save()
  if (chain === 'ethereum') {
    const facets = [
      { color: '#8d8d8d', path: 'M256 106L163 256L256 214Z' },
      { color: '#575757', path: 'M256 106L256 214L349 256Z' },
      { color: '#5a5a5a', path: 'M163 256L256 214L256 311Z' },
      { color: '#2e2e2e', path: 'M256 214L349 256L256 311Z' },
      { color: '#8a8a8a', path: 'M163 281L256 334L256 406Z' },
      { color: '#4b4b4b', path: 'M349 281L256 406L256 334Z' },
    ]
    for (const facet of facets) {
      ctx.fillStyle = facet.color
      ctx.fill(new Path2D(facet.path))
    }
  } else if (chain === 'near') {
    ctx.translate(256, 256)
    ctx.scale(300 / 351, 300 / 351)
    ctx.translate(-283.5, -283.5)
    ctx.fillStyle = '#303030'
    ctx.fill(new Path2D(nearPath))
  } else {
    ctx.translate(256, 256)
    ctx.scale(300 / 92.91, 300 / 92.91)
    ctx.translate(-220.68, -220.655)
    ctx.fillStyle = '#151515'
    ctx.fill(new Path2D(zcashPath))
  }
  ctx.restore()
}
