import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";

// Called by the storefront script (via Shopify's App Proxy, so it arrives
// same-origin as https://{shop-domain}/apps/store-shield/settings — no CORS
// needed and the request is signature-verified by Shopify before it reaches
// us). Returns only the non-secret toggles the client script needs.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  const shop = session?.shop ?? new URL(request.url).searchParams.get("shop");

  if (!shop) {
    return Response.json({ error: "unknown shop" }, { status: 400 });
  }

  const settings = await prisma.shopSettings.findUnique({ where: { shop } });

  return Response.json({
    cspHardeningEnabled: settings?.cspHardeningEnabled ?? false,
    cspAllowedDomains: (settings?.cspAllowedDomains ?? "")
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean),
    botProtectionEnabled: settings?.botProtectionEnabled ?? true,
    rateLimitEnabled: settings?.rateLimitEnabled ?? true,
    rateLimitMaxSubmits: settings?.rateLimitMaxSubmits ?? 5,
    rateLimitWindowSecs: settings?.rateLimitWindowSecs ?? 60,
    trustBadgeEnabled: settings?.trustBadgeEnabled ?? false,
  });
};
