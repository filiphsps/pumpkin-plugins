/** Distant Horizons client release this implementation targets. */
export const DH_VERSION = '3.3.4';
/** Network protocol used by the supported Distant Horizons release. */
export const PROTOCOL = 16;
/** Block-detail value for an LOD section. */
export const SECTION_DETAIL = 6;
/** Number of blocks along one side of an LOD section. */
export const SECTION_SIZE_BLOCKS = 2 ** SECTION_DETAIL;
/** Number of block columns in one LOD section. */
export const SECTION_AREA = SECTION_SIZE_BLOCKS ** 2;
/** Number of blocks along one side of a Pumpkin chunk. */
export const CHUNK_SIZE_BLOCKS = 16;
/** Number of chunks along one side of an LOD section. */
export const SECTION_CHUNKS_PER_SIDE = SECTION_SIZE_BLOCKS / CHUNK_SIZE_BLOCKS;
/** Total number of chunks required to build an LOD section. */
export const SECTION_CHUNK_COUNT = SECTION_CHUNKS_PER_SIDE ** 2;
/** Maximum payload size for one DH transfer packet. */
export const TRANSFER_PACKET_BYTES = 30_000;
