import type { ChunkMetadata } from 'types/metadata'
import type { OutputChunk, RenderedChunk } from 'rolldown'
import type { Plugin } from '../plugin'

// TODO: avoid memory leak
const chunkMetadataMap = new Map<string, ChunkMetadata>()

/**
 * Prepares the rendered chunks to contain additional metadata during build.
 */
export function metadataPlugin(): Plugin {
  return {
    name: 'vite:build-metadata',

    async renderChunk(_code, chunk) {
      // Since the chunk come from rust side, mutate it directly will not sync back to rust side.
      // The next usage will lost the metadata
      chunkMetadataMap.set(chunk.name, {
        importedAssets: new Set(),
        importedCss: new Set(),
      })
      return null
    },
  }
}

// TODO: give users a way to access the metadata
export function getChunkMetadata(
  chunk: RenderedChunk | OutputChunk,
): ChunkMetadata | undefined {
  // TODO: chunk.name is not unique, use something unique like chunk.preliminaryFileName / chunk.fileName
  return chunkMetadataMap.get(chunk.name)
}
