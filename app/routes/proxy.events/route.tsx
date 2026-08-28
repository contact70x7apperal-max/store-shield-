import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";

const VALID_EVENTS = new Set([
  "form_submit",
  "honeypot_triggered",
  "rate_limited",
  "bot_suspected",
]);

// Called by the storefront script through the App Proxy. Logs the event and,
// for form_submit, tells the caller whether this fingerprint is currently
// over its rate limit — this is the server-side check; the client-side
// check in the theme extension is only a fast first pass and is not
// trusted on its own, since a determined bot can just skip client JS.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  const shop = session?.shop ?? new URL(request.url).searchParams.get("shop");
  if (!shop) return Response.json({ error: "unknown shop" }, { status: 400 });

  const body = await request.json().catch(() => null);
  const eventType = body?.eventType;
  const fingerprint = String(body?.fingerprint ?? "").slice(0, 128);

  if (!VALID_EVENTS.has(eventType) || !fingerprint) {
    return Response.json({ error: "invalid payload" }, { status: 400 });
  }

  await prisma.submissionEvent.create({
    data: { shop, fingerprint, eventType },
  });

  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  const windowSecs = settings?.rateLimitWindowSecs ?? 60;
  const maxSubmits = settings?.rateLimitMaxSubmits ?? 5;
  const since = new Date(Date.now() - windowSecs * 1000);

  const recentCount = await prisma.submissionEvent.count({
    where: {
      shop,
      fingerprint,
      eventType: "form_submit",
      createdAt: { gte: since },
    },
  });

  const overLimit = (settings?.rateLimitEnabled ?? true) && recentCount > maxSubmits;

  if (overLimit && eventType === "form_submit") {
    await prisma.submissionEvent.create({
      data: { shop, fingerprint, eventType: "rate_limited" },
    });
  }

  return Response.json({ ok: true, overLimit });
};
