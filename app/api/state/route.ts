import { route } from "@/lib/tk/server";

export const dynamic = "force-dynamic";

/** The whole live picture, with the server's clock so every screen agrees on the time. */
export const GET = route(async () => ({}));
