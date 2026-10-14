/**
 * Host half of `dsh-preview-kit`.
 *
 * The kit is browser-side chrome, but a bundle row is imported on the Host too, so it needs an
 * entry that imports cleanly and registers nothing. Keeping it inert is deliberate: the kit must
 * never be able to affect a boot it has no part in.
 */
export function apply() {}
