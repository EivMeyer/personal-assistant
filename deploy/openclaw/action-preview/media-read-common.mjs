import { imageChunk } from "./media-source.mjs";
import { imageMime } from "./whatsapp-media.mjs";
export async function boundedAttachmentBody(response, limit, label) {
  if (
    !response.ok ||
    !response.body ||
    Number(response.headers.get("content-length")) > limit
  )
    throw Error(label + " attachment download failed or exceeds limit");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error(label + " attachment exceeds limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
export function readImageAttachment(source, args, identity) {
  if (args.start_seconds || args.frame_seconds !== undefined)
    throw Error("Images have no time windows");
  return imageChunk(source.bytes, args.offset, {
    ...identity,
    mime_type: imageMime(source.bytes),
  });
}
