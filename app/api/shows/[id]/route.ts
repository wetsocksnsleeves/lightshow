import { isBuiltinAudio } from "@/server/audio-store";
import { deleteShow, getAudioOwner, getShow, updateShow } from "@/server/db";
import { errorResponse, guardApiRequest, readJson } from "@/server/http";
import { readOwnerId } from "@/server/owner";
import { parseShowPatch } from "@/server/show-validation";

// better-sqlite3 is a native module, so this must run on Node.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function notFound(): Response {
  return errorResponse(404, "show not found");
}

/** `{ show }`, or 404. */
export async function GET(
  request: Request,
  { params }: Context,
): Promise<Response> {
  const refused = guardApiRequest(request, { write: false });
  if (refused) return refused;
  const ownerId = readOwnerId(request);
  if (!ownerId) return notFound();
  const show = getShow((await params).id, ownerId);
  return show
    ? Response.json(
        { show },
        { headers: { "Cache-Control": "private, no-store" } },
      )
    : notFound();
}

/**
 * Update a show owned by this browser. Any of `name`, `venue`, `audio`, `clips`
 * may be sent; fields left out keep their stored value. Replies `{ show }` with
 * the saved show.
 */
export async function PUT(
  request: Request,
  { params }: Context,
): Promise<Response> {
  const refused = guardApiRequest(request, { write: true });
  if (refused) return refused;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const patch = parseShowPatch(body.value);
  if (!patch.ok) return errorResponse(400, patch.error);
  const ownerId = readOwnerId(request);
  if (!ownerId) return notFound();
  const fileId = patch.value.audio?.fileId;
  if (fileId && !isBuiltinAudio(fileId)) {
    const fileOwner = getAudioOwner(fileId);
    if (fileOwner && fileOwner !== ownerId) {
      return errorResponse(403, "audio belongs to another user");
    }
  }
  const show = updateShow((await params).id, patch.value, ownerId);
  return show ? Response.json({ show }) : notFound();
}

export const PATCH = PUT;

/** 204, or 404. */
export async function DELETE(
  request: Request,
  { params }: Context,
): Promise<Response> {
  const refused = guardApiRequest(request, { write: true });
  if (refused) return refused;
  const ownerId = readOwnerId(request);
  if (!ownerId) return notFound();
  return deleteShow((await params).id, ownerId)
    ? new Response(null, { status: 204 })
    : notFound();
}
