// Splits file content into overlapping chunks of ~512 tokens (approximated by chars)

export interface ChunkOptions {
  maxChunkSize?: number   // chars, default 2000 (~512 tokens)
  overlap?: number        // chars of overlap between chunks, default 200
}

export interface RawChunk {
  id: string
  path: string
  index: number
  content: string
  startLine: number
  endLine: number
}

const DEFAULT_MAX = 2000
const DEFAULT_OVERLAP = 200

export function chunkFile(
  relativePath: string,
  content: string,
  opts: ChunkOptions = {}
): RawChunk[] {
  const max = opts.maxChunkSize ?? DEFAULT_MAX
  const overlap = opts.overlap ?? DEFAULT_OVERLAP
  const lines = content.split('\n')
  const chunks: RawChunk[] = []

  let charPos = 0
  let linePos = 0
  let index = 0

  while (charPos < content.length) {
    const end = Math.min(charPos + max, content.length)
    const slice = content.slice(charPos, end)

    const sliceLines = slice.split('\n')
    const startLine = linePos
    const endLine = linePos + sliceLines.length - 1

    chunks.push({
      id: `${relativePath}#${index}`,
      path: relativePath,
      index,
      content: slice,
      startLine,
      endLine,
    })

    // Advance by (max - overlap) so consecutive chunks share context
    const advance = Math.max(max - overlap, 1)
    const advanced = content.slice(charPos, charPos + advance)
    linePos += advanced.split('\n').length - 1
    charPos += advance
    index++
  }

  // If file is empty, return one empty chunk so the path is still indexed
  if (chunks.length === 0) {
    chunks.push({ id: `${relativePath}#0`, path: relativePath, index: 0, content: '', startLine: 0, endLine: lines.length })
  }

  return chunks
}
