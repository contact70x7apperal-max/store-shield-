import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  BlockStack,
  Box,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  RangeSlider,
  Text,
  TextField,
  Banner,
  Checkbox,
  Divider,
} from "@shopify/polaris";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await prisma.shopSettings.upsert({
    where: { shop: session.shop },
    update: {},
    create: { shop: session.shop },
  });
  return { settings };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  const settings = await prisma.shopSettings.update({
    where: { shop: session.shop },
    data: {
      cspHardeningEnabled: form.get("cspHardeningEnabled") === "true",
      cspAllowedDomains: String(form.get("cspAllowedDomains") ?? ""),
      botProtectionEnabled: form.get("botProtectionEnabled") === "true",
      rateLimitEnabled: form.get("rateLimitEnabled") === "true",
      rateLimitMaxSubmits: Number(form.get("rateLimitMaxSubmits") ?? 5),
      rateLimitWindowSecs: Number(form.get("rateLimitWindowSecs") ?? 60),
      trustBadgeEnabled: form.get("trustBadgeEnabled") === "true",
    },
  });

  return { settings, saved: true };
};

export default function Index() {
  const { settings: initial } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [settings, setSettings] = useState(initial);
  const isSaving = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.settings) setSettings(fetcher.data.settings);
  }, [fetcher.data]);

  const save = (next: typeof settings) => {
    setSettings(next);
    fetcher.submit(
      {
        cspHardeningEnabled: String(next.cspHardeningEnabled),
        cspAllowedDomains: next.cspAllowedDomains,
        botProtectionEnabled: String(next.botProtectionEnabled),
        rateLimitEnabled: String(next.rateLimitEnabled),
        rateLimitMaxSubmits: String(next.rateLimitMaxSubmits),
        rateLimitWindowSecs: String(next.rateLimitWindowSecs),
        trustBadgeEnabled: String(next.trustBadgeEnabled),
      },
      { method: "post" },
    );
  };

  return (
    <Page title="StoreShield">
      <Layout>
        <Layout.Section>
          <Banner tone="info">
            <Text as="p">
              Every toggle below does one specific, checkable thing. None of
              them can replace Shopify&apos;s own platform security (TLS,
              PCI-compliant checkout, DDoS protection) — that&apos;s already
              on for every store and no app can add to it.
            </Text>
          </Banner>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">
                  Content-Security-Policy hardening
                </Text>
                <Checkbox
                  label=""
                  labelHidden
                  checked={settings.cspHardeningEnabled}
                  onChange={(v) => save({ ...settings, cspHardeningEnabled: v })}
                />
              </InlineStack>
              <Text as="p" tone="subdued">
                Adds a restrictive Content-Security-Policy meta tag to your
                storefront pages that only allows scripts from your store's
                own domain plus the domains you list below. This narrows the
                blast radius if a third-party script on your store is ever
                compromised. Note: Shopify's theme app extensions can only
                inject markup into the page body, not the &lt;head&gt;, so
                for this to take effect in &lt;head&gt; you'll also need to
                paste the one-line snippet shown after saving into your
                theme.liquid — full instructions are in the app's README.
              </Text>
              <TextField
                label="Additional allowed script domains (comma-separated)"
                autoComplete="off"
                value={settings.cspAllowedDomains}
                onChange={(v) => setSettings({ ...settings, cspAllowedDomains: v })}
                onBlur={() => save(settings)}
                placeholder="e.g. www.googletagmanager.com, cdn.shopify.com"
                disabled={!settings.cspHardeningEnabled}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">
                  Bot &amp; scraper mitigation
                </Text>
                <Checkbox
                  label=""
                  labelHidden
                  checked={settings.botProtectionEnabled}
                  onChange={(v) => save({ ...settings, botProtectionEnabled: v })}
                />
              </InlineStack>
              <Text as="p" tone="subdued">
                Adds an invisible honeypot field and a submission-timing
                check to every form on your storefront (contact, newsletter,
                reviews). Simple bots that fill in every field or submit
                instantly get silently blocked; real shoppers never see a
                difference. This raises the bar for casual scripted abuse —
                it will not stop a targeted, hand-built attack.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">
                  Submission rate limiting
                </Text>
                <Checkbox
                  label=""
                  labelHidden
                  checked={settings.rateLimitEnabled}
                  onChange={(v) => save({ ...settings, rateLimitEnabled: v })}
                />
              </InlineStack>
              <Text as="p" tone="subdued">
                Caps how many form submissions a single visitor's browser can
                send in a time window, based on a lightweight
                fingerprint. Useful against discount-code brute-forcing and
                form-spam floods from one source.
              </Text>
              <InlineGrid columns={2} gap="400">
                <Box>
                  <Text as="p" variant="bodySm">
                    Max submissions: {settings.rateLimitMaxSubmits}
                  </Text>
                  <RangeSlider
                    label=""
                    labelHidden
                    min={1}
                    max={30}
                    value={settings.rateLimitMaxSubmits}
                    onChange={(v) =>
                      setSettings({ ...settings, rateLimitMaxSubmits: v as number })
                    }
                    onFocus={() => {}}
                    disabled={!settings.rateLimitEnabled}
                  />
                </Box>
                <Box>
                  <Text as="p" variant="bodySm">
                    Window: {settings.rateLimitWindowSecs}s
                  </Text>
                  <RangeSlider
                    label=""
                    labelHidden
                    min={10}
                    max={600}
                    step={10}
                    value={settings.rateLimitWindowSecs}
                    onChange={(v) =>
                      setSettings({ ...settings, rateLimitWindowSecs: v as number })
                    }
                    onFocus={() => {}}
                    disabled={!settings.rateLimitEnabled}
                  />
                </Box>
              </InlineGrid>
              <InlineStack>
                <Button onClick={() => save(settings)} loading={isSaving}>
                  Save rate limit
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">
                  Trust badge (visual only)
                </Text>
                <Checkbox
                  label=""
                  labelHidden
                  checked={settings.trustBadgeEnabled}
                  onChange={(v) => save({ ...settings, trustBadgeEnabled: v })}
                />
              </InlineStack>
              <Divider />
              <Text as="p" tone="subdued">
                Shows a small "Protected by StoreShield" badge near your
                checkout button. Labeled honestly here: this is a
                conversion/trust signal for shoppers, not a security
                mechanism. It's off by default for that reason — turn it on
                only if you want the visual, not because it adds protection.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
