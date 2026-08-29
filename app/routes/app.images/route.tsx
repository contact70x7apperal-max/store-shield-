import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  DataTable,
  EmptyState,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  RangeSlider,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import sharp from "sharp";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";

type ImageRow = {
  productId: string;
  productTitle: string;
  mediaId: string;
  url: string;
  width: number | null;
  height: number | null;
  altText: string | null;
  currentBytes: number | null;
};

// Content-Length via a HEAD request — cheap (no body transfer) and good
// enough to show "current size" without downloading every image up front.
// Some CDN responses omit the header; those show as "unknown" rather than 0,
// which would misleadingly imply a 0-byte file.
async function headContentLength(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    const len = res.headers.get("content-length");
    return len ? Number(len) : null;
  } catch {
    return null;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // First 20 products, up to 6 images each — enough for a merchant to work
  // through the biggest offenders without the loader itself timing out. A
  // store with more images than that pages through by re-running after the
  // most recently updated products' images have been optimized.
  const resp = await admin.graphql(`#graphql
    query ProductsWithImages {
      products(first: 20, sortKey: UPDATED_AT, reverse: true) {
        nodes {
          id
          title
          media(first: 6) {
            nodes {
              __typename
              ... on MediaImage {
                id
                image { url width height altText }
              }
            }
          }
        }
      }
    }
  `);
  const json = await resp.json();
  const products: {
    id: string;
    title: string;
    media: { nodes: { __typename: string; id?: string; image?: { url: string; width: number; height: number; altText: string | null } }[] };
  }[] = json.data?.products?.nodes ?? [];

  const flat: Omit<ImageRow, "currentBytes">[] = [];
  for (const p of products) {
    for (const m of p.media.nodes) {
      if (m.__typename !== "MediaImage" || !m.image || !m.id) continue;
      flat.push({
        productId: p.id,
        productTitle: p.title,
        mediaId: m.id,
        url: m.image.url,
        width: m.image.width,
        height: m.image.height,
        altText: m.image.altText,
      });
    }
  }

  const sizes = await Promise.all(flat.map((f) => headContentLength(f.url)));
  const rows: ImageRow[] = flat.map((f, i) => ({ ...f, currentBytes: sizes[i] }));

  const recentRuns = await prisma.imageOptimization.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return { rows, recentRuns };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();

  const selected: { productId: string; productTitle: string; mediaId: string; url: string }[] =
    JSON.parse(String(form.get("selected") ?? "[]"));
  const maxWidth = Number(form.get("maxWidth") ?? 1600);
  const quality = Number(form.get("quality") ?? 75);

  // Capped independently of whatever the UI sends — a hard ceiling here is
  // what actually protects against a request that runs past the platform's
  // action timeout, not just a client-side limit that a re-submit could skip.
  const batch = selected.slice(0, 10);

  const results: {
    productTitle: string;
    originalBytes: number;
    newBytes: number;
    status: "done" | "failed";
    errorMessage?: string;
    originalDeleted?: boolean;
    deleteError?: string;
  }[] = [];

  for (const item of batch) {
    let originalBytes = 0;
    try {
      const originalRes = await fetch(item.url);
      const originalBuffer = Buffer.from(await originalRes.arrayBuffer());
      originalBytes = originalBuffer.length;

      // WebP by default: it's what actually gets the size down (vs. just
      // re-saving the same format) and Shopify's CDN + every modern browser
      // serve/render it fine. Transparency is preserved, unlike converting
      // to JPEG.
      const optimizedBuffer = await sharp(originalBuffer)
        .resize({ width: maxWidth, withoutEnlargement: true })
        .webp({ quality })
        .toBuffer();

      const stagedResp = await admin.graphql(`#graphql
        mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets { url resourceUrl parameters { name value } }
            userErrors { field message }
          }
        }
      `, {
        variables: {
          input: [
            {
              resource: "IMAGE",
              filename: `optimized-${Date.now()}.webp`,
              mimeType: "image/webp",
              httpMethod: "POST",
            },
          ],
        },
      });
      const stagedJson = await stagedResp.json();
      const target = stagedJson.data?.stagedUploadsCreate?.stagedTargets?.[0];
      const stagedErrors = stagedJson.data?.stagedUploadsCreate?.userErrors ?? [];
      if (!target || stagedErrors.length > 0) {
        throw new Error(stagedErrors[0]?.message ?? "Could not create an upload target.");
      }

      const uploadForm = new FormData();
      for (const p of target.parameters as { name: string; value: string }[]) {
        uploadForm.append(p.name, p.value);
      }
      uploadForm.append("file", new Blob([optimizedBuffer], { type: "image/webp" }));
      const uploadRes = await fetch(target.url, { method: "POST", body: uploadForm });
      if (!uploadRes.ok) {
        throw new Error(`Upload to staged target failed (${uploadRes.status}).`);
      }

      const createResp = await admin.graphql(`#graphql
        mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
          productCreateMedia(productId: $productId, media: $media) {
            media { ... on MediaImage { id } }
            mediaUserErrors { field message }
          }
        }
      `, {
        variables: {
          productId: item.productId,
          media: [{ originalSource: target.resourceUrl, mediaContentType: "IMAGE" }],
        },
      });
      const createJson = await createResp.json();
      const newMedia = createJson.data?.productCreateMedia?.media?.[0];
      const createErrors = createJson.data?.productCreateMedia?.mediaUserErrors ?? [];
      if (!newMedia || createErrors.length > 0) {
        throw new Error(createErrors[0]?.message ?? "Could not attach the optimized image.");
      }

      // Only ever delete the original after the replacement is confirmed
      // attached above — a failed optimize (caught below) never reaches
      // here, so it never costs the merchant their original image. A failed
      // *deletion*, on the other hand, doesn't roll back the optimize: the
      // new image stays, and we just report that the old one needs manual
      // cleanup instead of silently leaving it there unexplained.
      let originalDeleted = false;
      let deleteError: string | undefined;
      try {
        const deleteResp = await admin.graphql(`#graphql
          mutation ProductDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
            productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
              deletedMediaIds
              mediaUserErrors { field message }
            }
          }
        `, {
          variables: { productId: item.productId, mediaIds: [item.mediaId] },
        });
        const deleteJson = await deleteResp.json();
        const deleteErrors = deleteJson.data?.productDeleteMedia?.mediaUserErrors ?? [];
        const deletedIds = deleteJson.data?.productDeleteMedia?.deletedMediaIds ?? [];
        if (deleteErrors.length > 0 || deletedIds.length === 0) {
          deleteError = deleteErrors[0]?.message ?? "The original image could not be removed automatically.";
        } else {
          originalDeleted = true;
        }
      } catch (delErr) {
        deleteError = delErr instanceof Error ? delErr.message : "The original image could not be removed automatically.";
      }

      await prisma.imageOptimization.create({
        data: {
          shop: session.shop,
          productId: item.productId,
          productTitle: item.productTitle,
          originalMediaId: item.mediaId,
          newMediaId: newMedia.id,
          originalBytes,
          newBytes: optimizedBuffer.length,
          maxWidth,
          quality,
          status: "done",
        },
      });
      results.push({
        productTitle: item.productTitle,
        originalBytes,
        newBytes: optimizedBuffer.length,
        status: "done",
        originalDeleted,
        deleteError,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      await prisma.imageOptimization.create({
        data: {
          shop: session.shop,
          productId: item.productId,
          productTitle: item.productTitle,
          originalMediaId: item.mediaId,
          originalBytes,
          maxWidth,
          quality,
          status: "failed",
          errorMessage: message,
        },
      });
      results.push({
        productTitle: item.productTitle,
        originalBytes,
        newBytes: 0,
        status: "failed",
        errorMessage: message,
      });
    }
  }

  return { results };
};

function formatKB(bytes: number | null): string {
  if (bytes === null) return "unknown";
  return `${Math.round(bytes / 1024)} KB`;
}

export default function ImageOptimizer() {
  const { rows, recentRuns } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const isRunning = fetcher.state !== "idle";

  const [maxWidth, setMaxWidth] = useState(1600);
  const [quality, setQuality] = useState(75);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [sizeThresholdKB, setSizeThresholdKB] = useState("200");

  const keyOf = (r: ImageRow) => `${r.productId}::${r.mediaId}`;

  const toggle = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // The images actually worth running through this are the big ones — a
  // threshold selects everything at or above it in one click instead of
  // eyeballing the size column row by row. Images with an unknown size
  // (missing content-length header) are left out rather than guessed at.
  const selectOverThreshold = () => {
    const thresholdBytes = Number(sizeThresholdKB) * 1024;
    if (!Number.isFinite(thresholdBytes) || thresholdBytes <= 0) return;
    const matching = rows.filter(
      (r) => r.currentBytes !== null && r.currentBytes >= thresholdBytes,
    );
    setSelectedKeys(new Set(matching.map(keyOf)));
  };

  useEffect(() => {
    if (fetcher.data?.results) setSelectedKeys(new Set());
  }, [fetcher.data]);

  const runOptimization = () => {
    const selected = rows
      .filter((r) => selectedKeys.has(keyOf(r)))
      .map((r) => ({
        productId: r.productId,
        productTitle: r.productTitle,
        mediaId: r.mediaId,
        url: r.url,
      }));
    fetcher.submit(
      {
        selected: JSON.stringify(selected),
        maxWidth: String(maxWidth),
        quality: String(quality),
      },
      { method: "post" },
    );
  };

  const totalSaved = (fetcher.data?.results ?? [])
    .filter((r) => r.status === "done")
    .reduce((acc, r) => acc + (r.originalBytes - r.newBytes), 0);

  return (
    <Page title="Image optimizer">
      <Layout>
        <Layout.Section>
          <Banner tone="warning">
            <Text as="p">
              Downloads each selected product image, resizes it to the max
              width below, re-encodes it as WebP at the chosen quality,
              uploads it to the product — and, only once that new image is
              confirmed attached, <b>deletes the original</b>. This is
              destructive: a deleted original cannot be recovered from this
              app. Processes up to 10 images per run to stay within the
              platform's request time limit.
            </Text>
          </Banner>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineGrid columns={2} gap="400">
                <Box>
                  <Text as="p" variant="bodySm">
                    Max width: {maxWidth}px
                  </Text>
                  <RangeSlider
                    label=""
                    labelHidden
                    min={400}
                    max={2400}
                    step={100}
                    value={maxWidth}
                    onChange={(v) => setMaxWidth(v as number)}
                    onFocus={() => {}}
                  />
                </Box>
                <Box>
                  <Text as="p" variant="bodySm">
                    WebP quality: {quality}
                  </Text>
                  <RangeSlider
                    label=""
                    labelHidden
                    min={40}
                    max={95}
                    step={5}
                    value={quality}
                    onChange={(v) => setQuality(v as number)}
                    onFocus={() => {}}
                  />
                </Box>
              </InlineGrid>
              <InlineStack align="space-between" blockAlign="end" gap="200">
                <InlineStack blockAlign="end" gap="200">
                  <Box minWidth="140px">
                    <TextField
                      label="Select images ≥"
                      type="number"
                      suffix="KB"
                      autoComplete="off"
                      value={sizeThresholdKB}
                      onChange={setSizeThresholdKB}
                    />
                  </Box>
                  <Button onClick={selectOverThreshold}>Select matching</Button>
                  {selectedKeys.size > 0 && (
                    <Button variant="plain" onClick={() => setSelectedKeys(new Set())}>
                      Clear selection
                    </Button>
                  )}
                </InlineStack>
                <Text as="p" tone={selectedKeys.size > 10 ? "caution" : "subdued"}>
                  {selectedKeys.size} image(s) selected
                  {selectedKeys.size > 10 &&
                    " — only the first 10 will run this time; run it again for the rest."}
                </Text>
              </InlineStack>
              <InlineStack align="end">
                <Button
                  variant="primary"
                  disabled={selectedKeys.size === 0}
                  loading={isRunning}
                  onClick={runOptimization}
                >
                  Optimize selected images
                </Button>
              </InlineStack>
              {fetcher.data?.results && (
                <Banner tone={totalSaved > 0 ? "success" : "warning"}>
                  <Text as="p">
                    {fetcher.data.results.filter((r) => r.status === "done").length} of{" "}
                    {fetcher.data.results.length} optimized successfully
                    {totalSaved > 0 ? ` — saved about ${formatKB(totalSaved)} total.` : "."}
                    {fetcher.data.results.some((r) => r.status === "done" && !r.originalDeleted) &&
                      " One or more originals couldn't be deleted automatically — check the log below and remove those manually."}
                    {fetcher.data.results.some((r) => r.status === "failed") &&
                      " Check the log below for what failed and why."}
                  </Text>
                </Banner>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            {rows.length === 0 ? (
              <EmptyState
                heading="No product images found"
                image="https://cdn.shopify.com/s/files/1/0757/9955/files/empty-state.svg"
              >
                <p>Add images to your products to optimize them here.</p>
              </EmptyState>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "text"]}
                headings={["", "Image", "Product", "Dimensions", "Current size"]}
                rows={rows.map((r) => [
                  <Checkbox
                    key={`cb-${keyOf(r)}`}
                    label=""
                    labelHidden
                    checked={selectedKeys.has(keyOf(r))}
                    onChange={() => toggle(keyOf(r))}
                  />,
                  <Thumbnail key={`th-${keyOf(r)}`} source={r.url} alt={r.altText ?? r.productTitle} size="small" />,
                  r.productTitle,
                  r.width && r.height ? `${r.width}×${r.height}` : "—",
                  formatKB(r.currentBytes),
                ])}
              />
            )}
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            <Box padding="400">
              <Text as="h2" variant="headingMd">
                Recent optimization runs
              </Text>
            </Box>
            {recentRuns.length === 0 ? (
              <Box padding="400">
                <Text as="p" tone="subdued">
                  Nothing optimized yet.
                </Text>
              </Box>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "text"]}
                headings={["When", "Product", "Before", "After", "Result"]}
                rows={recentRuns.map((r) => [
                  new Date(r.createdAt).toLocaleString(),
                  r.productTitle,
                  formatKB(r.originalBytes),
                  r.newBytes ? formatKB(r.newBytes) : "—",
                  <Badge key={r.id} tone={r.status === "done" ? "success" : "critical"}>
                    {r.status === "done" ? "Optimized" : `Failed: ${r.errorMessage ?? "unknown"}`}
                  </Badge>,
                ])}
              />
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
