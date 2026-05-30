import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page, Layout, Card, Text, BlockStack, Button,
  Banner, ProgressBar, List, Badge, InlineStack, Divider, Box,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  // Fetch priority breakdown
  const res = await admin.graphql(`#graphql
    query {
      all:   productsCount { count }
      p1:    productsCount(query: "metafield:custom.priority:1") { count }
      p2:    productsCount(query: "metafield:custom.priority:2") { count }
      p3:    productsCount(query: "metafield:custom.priority:3") { count }
      p4:    productsCount(query: "metafield:custom.priority:4") { count }
      p5:    productsCount(query: "metafield:custom.priority:5") { count }
      colls: collectionsCount { count }
    }
  `);

  const d = await res.json();
  return {
    total:       d.data.all.count,
    p1:          d.data.p1.count,
    p2:          d.data.p2.count,
    p3:          d.data.p3.count,
    p4:          d.data.p4.count,
    p5:          d.data.p5.count,
    collections: d.data.colls.count,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  // 1. Build priority map from all products
  const priorityMap: Record<string, number> = {};
  let cursor: string | null = null;

  while (true) {
    const res = await admin.graphql(`#graphql
      query($cursor: String) {
        products(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              priority: metafield(namespace: "custom", key: "priority") { value }
            }
          }
        }
      }
    `, { variables: { cursor } });

    const data = await res.json();
    for (const edge of data.data.products.edges) {
      const numId = edge.node.id;
      priorityMap[numId] = edge.node.priority?.value
        ? Number(edge.node.priority.value)
        : 999;
    }

    if (!data.data.products.pageInfo.hasNextPage) break;
    cursor = data.data.products.pageInfo.endCursor;
  }

  // 2. Fetch all collections
  const collections: { id: string; title: string; sortOrder: string }[] = [];
  cursor = null;

  while (true) {
    const res = await admin.graphql(`#graphql
      query($cursor: String) {
        collections(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges { node { id title sortOrder } }
        }
      }
    `, { variables: { cursor } });

    const data = await res.json();
    for (const edge of data.data.collections.edges) {
      collections.push(edge.node);
    }
    if (!data.data.collections.pageInfo.hasNextPage) break;
    cursor = data.data.collections.pageInfo.endCursor;
  }

  // 3. Reorder each collection
  let reordered = 0, skipped = 0, errors = 0;
  const errorList: string[] = [];

  for (const coll of collections) {
    // Fetch products in this collection
    const productGids: string[] = [];
    let prodCursor: string | null = null;

    while (true) {
      const res = await admin.graphql(`#graphql
        query($id: ID!, $after: String) {
          collection(id: $id) {
            products(first: 250, after: $after) {
              pageInfo { hasNextPage endCursor }
              edges { node { id } }
            }
          }
        }
      `, { variables: { id: coll.id, after: prodCursor } });

      const data = await res.json();
      for (const edge of data.data.collection.products.edges) {
        productGids.push(edge.node.id);
      }
      if (!data.data.collection.products.pageInfo.hasNextPage) break;
      prodCursor = data.data.collection.products.pageInfo.endCursor;
    }

    if (productGids.length === 0) { skipped++; continue; }

    // Sort by priority
    const sorted = productGids
      .map((gid, idx) => ({ gid, priority: priorityMap[gid] ?? 999, idx }))
      .sort((a, b) => a.priority !== b.priority ? a.priority - b.priority : a.idx - b.idx);

    if (sorted.every((p, i) => p.gid === productGids[i])) { skipped++; continue; }

    // Set manual sort order if needed
    if (coll.sortOrder !== "MANUAL") {
      const numId = coll.id.split("/").pop();
      const collType = "custom_collections"; // try custom first
      await fetch(`https://${process.env.SHOPIFY_APP_URL?.replace("https://", "") || "fineystjackets.myshopify.com"}/admin/api/2024-01/${collType}/${numId}.json`, {
        method: "PUT",
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_API_SECRET || "",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ custom_collection: { id: numId, sort_order: "manual" } }),
      });
    }

    // Send moves in chunks of 250
    const allMoves = sorted.map((p, i) => ({ id: p.gid, newPosition: String(i) }));
    const chunks = [];
    for (let i = 0; i < allMoves.length; i += 250) chunks.push(allMoves.slice(i, i + 250));

    let hasError = false;
    for (const chunk of chunks) {
      const res = await admin.graphql(`#graphql
        mutation($id: ID!, $moves: [MoveInput!]!) {
          collectionReorderProducts(id: $id, moves: $moves) {
            job { id }
            userErrors { field message }
          }
        }
      `, { variables: { id: coll.id, moves: chunk } });

      const data = await res.json();
      if (data.data.collectionReorderProducts.userErrors.length > 0) {
        hasError = true;
        errorList.push(`${coll.title}: ${data.data.collectionReorderProducts.userErrors[0].message}`);
        break;
      }
    }

    if (hasError) errors++;
    else reordered++;
  }

  return { reordered, skipped, errors, errorList, total: collections.length };
};

export default function Reorder() {
  const stats = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const isRunning = fetcher.state !== "idle";
  const result = fetcher.data;

  return (
    <Page>
      <TitleBar title="Reorder Collections by Priority" />
      <BlockStack gap="500">

        {/* Priority breakdown */}
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Current Priority Breakdown</Text>
                <Divider />
                <InlineStack gap="400" wrap>
                  {[
                    { label: "Priority 1", count: stats.p1, tone: "success" },
                    { label: "Priority 2", count: stats.p2, tone: "info" },
                    { label: "Priority 3", count: stats.p3, tone: "attention" },
                    { label: "Priority 4", count: stats.p4, tone: undefined },
                    { label: "Priority 5", count: stats.p5, tone: "critical" },
                  ].map(({ label, count, tone }) => (
                    <Box key={label} padding="300" background="bg-surface-secondary" borderRadius="200" minWidth="120px">
                      <BlockStack gap="100">
                        <Badge tone={tone as any}>{label}</Badge>
                        <Text as="p" variant="heading2xl">{count}</Text>
                        <Text as="p" variant="bodySm" tone="subdued">products</Text>
                      </BlockStack>
                    </Box>
                  ))}
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* Reorder action */}
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Reorder All Collections</Text>
                <Divider />
                <Text as="p" variant="bodyMd" tone="subdued">
                  This will sort products inside all {stats.collections} collections so that
                  Priority 1 products appear first, followed by 2, 3, 4, and 5.
                  Collections that are already in the correct order will be skipped automatically.
                </Text>

                <List type="bullet">
                  <List.Item>Processes all {stats.collections} collections</List.Item>
                  <List.Item>Auto-sets manual sort order where needed</List.Item>
                  <List.Item>Handles large collections automatically</List.Item>
                  <List.Item>This may take 1–3 minutes</List.Item>
                </List>

                {isRunning && (
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd">Processing collections… please wait</Text>
                    <ProgressBar progress={undefined} size="small" />
                  </BlockStack>
                )}

                {result && (
                  <Banner tone={result.errors === 0 ? "success" : "warning"}>
                    <BlockStack gap="100">
                      <Text as="p" fontWeight="semibold">
                        ✅ Reordered: {result.reordered} &nbsp;|&nbsp;
                        ⏭ Skipped: {result.skipped} &nbsp;|&nbsp;
                        ❌ Errors: {result.errors}
                      </Text>
                      {result.errorList?.length > 0 && (
                        <List>
                          {result.errorList.map((e: string, i: number) => (
                            <List.Item key={i}>{e}</List.Item>
                          ))}
                        </List>
                      )}
                    </BlockStack>
                  </Banner>
                )}

                <fetcher.Form method="POST">
                  <Button
                    variant="primary"
                    size="large"
                    submit
                    loading={isRunning}
                    disabled={isRunning}
                  >
                    {isRunning ? "Reordering…" : "🔄 Reorder All Collections Now"}
                  </Button>
                </fetcher.Form>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

      </BlockStack>
    </Page>
  );
}
