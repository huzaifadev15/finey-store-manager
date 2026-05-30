import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page, Layout, Card, Text, BlockStack, InlineStack,
  Badge, Button, Box, Divider,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  // Fetch counts
  const res = await admin.graphql(`#graphql
    query {
      products: products(first: 1) { pageInfo { total: endCursor } }
      collections: collections(first: 1) { pageInfo { total: endCursor } }
      p1: products(first: 1, query: "metafield:custom.priority:1") { pageInfo { hasNextPage } }
      p2: products(first: 1, query: "metafield:custom.priority:2") { pageInfo { hasNextPage } }
      p3: products(first: 1, query: "metafield:custom.priority:3") { pageInfo { hasNextPage } }
    }
  `);

  // Get total counts via REST-style count endpoints through GraphQL
  const countRes = await admin.graphql(`#graphql
    query {
      productsCount: productsCount { count }
      collectionsCount: collectionsCount { count }
    }
  `);

  const countData = await countRes.json();

  return {
    productCount:    countData.data?.productsCount?.count ?? 0,
    collectionCount: countData.data?.collectionsCount?.count ?? 0,
    shop,
  };
};

export default function Dashboard() {
  const { productCount, collectionCount, shop } = useLoaderData<typeof loader>();

  return (
    <Page>
      <TitleBar title="Finey Store Manager" />
      <BlockStack gap="500">

        {/* Stats */}
        <Layout>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm" tone="subdued">Total Products</Text>
                <Text as="p" variant="heading2xl">{productCount.toLocaleString()}</Text>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm" tone="subdued">Total Collections</Text>
                <Text as="p" variant="heading2xl">{collectionCount.toLocaleString()}</Text>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm" tone="subdued">Store</Text>
                <Text as="p" variant="headingMd">{shop}</Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* Quick Actions */}
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Quick Actions</Text>
                <Divider />
                <Layout>
                  <Layout.Section variant="oneThird">
                    <BlockStack gap="300">
                      <Text as="h3" variant="headingSm">📦 Products & Priority</Text>
                      <Text as="p" variant="bodyMd" tone="subdued">
                        View all products, see and edit their custom.priority metafield.
                      </Text>
                      <Button url="/app/products">Manage Products</Button>
                    </BlockStack>
                  </Layout.Section>
                  <Layout.Section variant="oneThird">
                    <BlockStack gap="300">
                      <Text as="h3" variant="headingSm">🔄 Reorder Collections</Text>
                      <Text as="p" variant="bodyMd" tone="subdued">
                        One-click sort all collections by priority (1 first → 5 last).
                      </Text>
                      <Button url="/app/reorder" variant="primary">Reorder Now</Button>
                    </BlockStack>
                  </Layout.Section>
                  <Layout.Section variant="oneThird">
                    <BlockStack gap="300">
                      <Text as="h3" variant="headingSm">📤 Import / Export</Text>
                      <Text as="p" variant="bodyMd" tone="subdued">
                        Export products or collections to CSV. Import CSV to bulk update priorities.
                      </Text>
                      <Button url="/app/import-export">Import / Export</Button>
                    </BlockStack>
                  </Layout.Section>
                </Layout>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* Priority Guide */}
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Priority Guide</Text>
                <Divider />
                <InlineStack gap="300" wrap>
                  {[
                    { val: "1", label: "Highest — shows first", tone: "success" },
                    { val: "2", label: "High", tone: "info" },
                    { val: "3", label: "Medium", tone: "attention" },
                    { val: "4", label: "Default", tone: undefined },
                    { val: "5", label: "Lowest — shows last", tone: "critical" },
                  ].map(({ val, label, tone }) => (
                    <Box key={val} padding="200" background="bg-surface-secondary" borderRadius="200">
                      <InlineStack gap="200" blockAlign="center">
                        <Badge tone={tone as any}>Priority {val}</Badge>
                        <Text as="span" variant="bodyMd">{label}</Text>
                      </InlineStack>
                    </Box>
                  ))}
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

      </BlockStack>
    </Page>
  );
}
