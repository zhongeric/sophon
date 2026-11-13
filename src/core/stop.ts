/** A condition under which a workflow must not start or continue, such as a missing input or credential. */
export class StopError extends Error {
  override name = 'StopError'
}
