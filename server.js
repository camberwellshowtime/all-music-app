import index from './src/index.html'

// Audio and catalog.json come from the Cloudflare Worker/R2, not this dev
// server — there's nothing to serve locally besides the app shell.
function serve(port) {
  try {
    return Bun.serve({
      port,
      hostname: '0.0.0.0',
      routes: {
        '/*': index,
      },
      development: {
        hmr: true,
        console: true,
      },
    })
  } catch (e) {
    if (e.code === 'EADDRINUSE') return serve(port + 1)
    throw e
  }
}

const server = serve(3000)

console.log(`Dev server running at ${server.url}`)
