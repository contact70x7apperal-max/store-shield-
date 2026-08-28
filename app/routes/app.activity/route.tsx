import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  BlockStack,
  Card,
  DataTable,
  EmptyState,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const events = await prisma.submissionEvent.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const counts = events.reduce<Record<string, number>>((acc, e) => {
    acc[e.eventType] = (acc[e.eventType] ?? 0) + 1;
    return acc;
  }, {});

  return { events, counts };
};

const LABELS: Record<string, string> = {
  form_submit: "Legitimate submission",
  honeypot_triggered: "Blocked — honeypot triggered",
  rate_limited: "Blocked — rate limit exceeded",
  bot_suspected: "Blocked — bot heuristics",
};

export default function Activity() {
  const { events, counts } = useLoaderData<typeof loader>();

  return (
    <Page title="Activity log">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                Last 100 events (most recent first)
              </Text>
              <Text as="p" tone="subdued">
                Counts: {Object.entries(counts)
                  .map(([k, v]) => `${LABELS[k] ?? k}: ${v}`)
                  .join(" · ") || "No events recorded yet"}
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <Card padding="0">
            {events.length === 0 ? (
              <EmptyState
                heading="No activity yet"
                image="https://cdn.shopify.com/s/files/1/0757/9955/files/empty-state.svg"
              >
                <p>
                  Once bot protection or rate limiting is enabled and a
                  visitor triggers one, it'll show up here.
                </p>
              </EmptyState>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text"]}
                headings={["When", "Event", "Fingerprint (hashed)"]}
                rows={events.map((e) => [
                  new Date(e.createdAt).toLocaleString(),
                  LABELS[e.eventType] ?? e.eventType,
                  e.fingerprint,
                ])}
              />
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
