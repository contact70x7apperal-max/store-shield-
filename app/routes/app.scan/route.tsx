import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  DataTable,
  EmptyState,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";
import { scanRules } from "./scan-rules.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const findings = await prisma.scanFinding.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return { findings };
};

// Fetches the live theme's asset list + contents via the Admin GraphQL API
// and greps them against a small set of concrete, checkable rules (exposed
// secrets, risky inline patterns, known-outdated libraries). This is real
// static analysis, not a marketing claim: every finding names the exact
// asset, line, and rule that fired.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const themeResp = await admin.graphql(`#graphql
    query MainTheme {
      themes(first: 1, roles: [MAIN]) {
        nodes { id name }
      }
    }
  `);
  const themeJson = await themeResp.json();
  const theme = themeJson.data?.themes?.nodes?.[0];

  if (!theme) {
    return { error: "Could not find the live theme.", findings: [] };
  }

  // filenames: ["*"] is Shopify's documented wildcard for "match every file"
  // (an empty array matches nothing, per the Admin API docs) — first: 250 is
  // one page; a store with a very large theme would need to follow
  // pageInfo.hasNextPage and page through with `after`, which this v1 scan
  // doesn't do yet (documented as a known limitation below).
  let allFiles: { filename: string; body?: { content?: string } }[] = [];
  let after: string | null = null;
  let hasNextPage = true;

  while (hasNextPage && allFiles.length < 1000) {
    const filesResp: Response = await admin.graphql(
      `#graphql
      query ThemeFiles($id: ID!, $after: String) {
        theme(id: $id) {
          files(first: 250, after: $after, filenames: ["*"]) {
            nodes {
              filename
              body {
                ... on OnlineStoreThemeFileBodyText { content }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    `,
      { variables: { id: theme.id, after } },
    );
    const filesJson = await filesResp.json();
    const connection = filesJson.data?.theme?.files;
    allFiles = allFiles.concat(connection?.nodes ?? []);
    hasNextPage = !!connection?.pageInfo?.hasNextPage;
    after = connection?.pageInfo?.endCursor ?? null;
  }

  const files = allFiles;

  await prisma.scanFinding.deleteMany({ where: { shop: session.shop } });

  const findings: {
    assetKey: string;
    ruleId: string;
    severity: string;
    message: string;
    lineNumber: number | null;
  }[] = [];

  for (const file of files) {
    const content: string | undefined = file.body?.content;
    if (!content) continue;
    if (!/\.(liquid|js|json)$/.test(file.filename)) continue;

    for (const rule of scanRules) {
      const lines = content.split("\n");
      lines.forEach((line, idx) => {
        if (rule.pattern.test(line)) {
          findings.push({
            assetKey: file.filename,
            ruleId: rule.id,
            severity: rule.severity,
            message: rule.message,
            lineNumber: idx + 1,
          });
        }
      });
    }
  }

  if (findings.length > 0) {
    await prisma.scanFinding.createMany({
      data: findings.map((f) => ({ ...f, shop: session.shop, themeId: theme.id })),
    });
  }

  return { scanned: files.length, findingsCount: findings.length };
};

const SEVERITY_TONE: Record<string, "critical" | "warning" | "info"> = {
  high: "critical",
  medium: "warning",
  low: "info",
};

export default function Scan() {
  const { findings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const isScanning = fetcher.state !== "idle";

  return (
    <Page
      title="Security scan"
      primaryAction={{
        content: isScanning ? "Scanning…" : "Run scan now",
        loading: isScanning,
        onAction: () => fetcher.submit({}, { method: "post" }),
      }}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                What this checks
              </Text>
              <Text as="p" tone="subdued">
                Scans every .liquid, .js, and settings .json file in your
                live theme for a fixed set of concrete patterns: hardcoded
                API keys/secrets, inline event-handler attributes that are
                common XSS vectors, and script tags pulling in known-outdated
                jQuery versions. It reports the exact file and line number
                for every hit — nothing here is a vague severity score.
              </Text>
              {fetcher.data && "scanned" in fetcher.data && (
                <Text as="p">
                  Scanned {fetcher.data.scanned} files, found{" "}
                  {fetcher.data.findingsCount} issue(s).
                </Text>
              )}
              {fetcher.data?.error && (
                <Text as="p" tone="critical">
                  {fetcher.data.error}
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <Card padding="0">
            {findings.length === 0 ? (
              <EmptyState
                heading="No findings yet"
                image="https://cdn.shopify.com/s/files/1/0757/9955/files/empty-state.svg"
              >
                <p>Run a scan to check your live theme.</p>
              </EmptyState>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text", "text"]}
                headings={["Severity", "File", "Line", "Issue"]}
                rows={findings.map((f) => [
                  <Box key={f.id}>
                    <Badge tone={SEVERITY_TONE[f.severity] ?? "info"}>
                      {f.severity}
                    </Badge>
                  </Box>,
                  f.assetKey,
                  f.lineNumber?.toString() ?? "—",
                  f.message,
                ])}
              />
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
