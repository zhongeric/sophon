// A Worker entry for test/cloudflare-scan.test.ts only: it calls the RPC methods of ScanBoxes from HTTP routes. No
// production route calls a scan box. It is JavaScript, because the Node typecheck of test/ has no Worker types.
export { DevelopmentRuns, PullRequestRuns, ResearchRuns, ScanBoxes } from '../../src/cloudflare/worker.ts'

const bytes = (base64) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))

export default {
  /** POST /<method> with the JSON body { name, ... }, where name is <pool>/<slot>. An error gives HTTP 500 with its message. */
  async fetch(request, env) {
    const method = new URL(request.url).pathname.slice(1)
    const body = await request.json()
    const box = env.SCAN_BOXES.get(env.SCAN_BOXES.idFromName(body.name))
    try {
      if (method === 'start') {
        const inputs = body.inputs.map((input) => ({ data: bytes(input.base64), path: input.path }))
        return Response.json(await box.start(body.name, { argv: body.argv, inputs, timeoutMs: body.timeoutMs }))
      }
      if (method === 'poll') return Response.json(await box.poll(body.name))
      if (method === 'kill') {
        await box.kill(body.name)
        return Response.json({})
      }
      if (method === 'read') return new Response(await box.read(body.name, body.path))
      return new Response(`no route ${method}`, { status: 404 })
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 500 })
    }
  },
}
