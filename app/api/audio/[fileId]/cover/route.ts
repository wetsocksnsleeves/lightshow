import { readCover } from "@/server/audio-info";
import { isAudioFileId, isBuiltinAudio } from "@/server/audio-store";
import { isAudioOwnedBy } from "@/server/db";
import { guardApiRequest } from "@/server/http";
import { readOwnerId } from "@/server/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ fileId: string }> };

/**
 * Serve the cover art embedded in a built-in audio file or one owned by the
 * caller's browser, or 404 when it has none or is not accessible.
 */
export async function GET(
  request: Request,
  { params }: Context,
): Promise<Response> {
  const refused = guardApiRequest(request, { write: false });
  if (refused) return refused;
  const { fileId } = await params;
  if (!isAudioFileId(fileId)) {
    return Response.json({ error: "no cover art" }, { status: 404 });
  }
  const builtin = isBuiltinAudio(fileId);
  if (!builtin) {
    const ownerId = readOwnerId(request);
    if (!ownerId || !isAudioOwnedBy(fileId, ownerId)) {
      return Response.json({ error: "no cover art" }, { status: 404 });
    }
  }
  const cover = await readCover(fileId);
  if (!cover) {
    return Response.json({ error: "no cover art" }, { status: 404 });
  }
  return new Response(new Blob([cover.data.slice()]), {
    headers: {
      "Content-Type": cover.mimeType,
      "Cache-Control": `${builtin ? "public" : "private"}, max-age=31536000, immutable`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
