// This preview uses the existing server/desktop pipeline for links and batches.
// Browser-only processing is disabled at the user's request. IndexedDB data is retained.
export function browserLocal() { return false }
export function switchProcessingMode(_remote: boolean) {
  localStorage.setItem('ynote.processing-mode.v1', 'remote')
  location.assign('/')
}
