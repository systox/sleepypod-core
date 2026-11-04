/** Sleepypod's own API, loaded when first needed rather than when the fork's modules load. */
export async function caller() {
  const { getCaller } = await import('@/src/mcp/caller')
  return getCaller()
}
