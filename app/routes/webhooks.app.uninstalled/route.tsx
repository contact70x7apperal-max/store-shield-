import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Clean up everything we stored for this shop.
  if (session) {
    await prisma.session.deleteMany({ where: { shop } });
  }
  await prisma.shopSettings.deleteMany({ where: { shop } });
  await prisma.submissionEvent.deleteMany({ where: { shop } });
  await prisma.scanFinding.deleteMany({ where: { shop } });

  return new Response();
};
