import { isBuiltinAudio } from "@/server/audio-store";
import { createShow, getAudioOwner, listShows } from "@/server/db";
import { errorResponse, guardApiRequest, readJson } from "@/server/http";
import { ensureOwner, withOwnerCookie } from "@/server/owner";
import { parseShowPatch } from "@/server/show-validation";

// better-sqlite3 is a native module, so this must run on Node.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List this browser's saved shows, most recently updated first: `{ shows: ShowSummary[] }`. */
export function GET(request: Request): Response {
  const refused = guardApiRequest(request, { write: false });
  if (refused) return refused;
  const { ownerId, setCookie } = ensureOwner(request);
  const res = Response.json(
    { shows: listShows(ownerId) },
    { headers: { "Cache-Control": "private, no-store" } },
  );
  return withOwnerCookie(res, setCookie);
}

/**
 * Create a show owned by this browser. The JSON body may set `name`, `venue`,
 * `audio` and `clips`; an empty body creates an untitled, empty show. Replies
 * 201 with `{ show }`.
 */
export async function POST(request: Request): Promise<Response> {
  const refused = guardApiRequest(request, { write: true });
  if (refused) return refused;
  const body = await readJson(request, {});
  if (!body.ok) return body.response;
  const patch = parseShowPatch(body.value);
  if (!patch.ok) return errorResponse(400, patch.error);
  const { ownerId, setCookie } = ensureOwner(request);
  const fileId = patch.value.audio?.fileId;
  if (fileId && !isBuiltinAudio(fileId)) {
    const fileOwner = getAudioOwner(fileId);
    if (fileOwner && fileOwner !== ownerId) {
      return errorResponse(403, "audio belongs to another user");
    }
  }
  const show = createShow(patch.value, ownerId);
  return withOwnerCookie(Response.json({ show }, { status: 201 }), setCookie);
}
