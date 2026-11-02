import { getTranscript } from '../../../api/materials'
/** Keep copies, citations and the reference panel complete beyond the first page. */
export async function getCompleteTranscript(materialId: string) {
  const first = await getTranscript(materialId, { page: 1, page_size: 100 })
  const segments = [...first.segments]
  for (let page = 2; segments.length < first.total_segments; page++) {
    const next = await getTranscript(materialId, { version_id: first.version.id, page, page_size: 100 })
    if (!next.segments.length) break
    segments.push(...next.segments)
  }
  return { ...first, segments }
}
