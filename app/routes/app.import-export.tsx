import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher } from "@remix-run/react";
import {
  Page, Layout, Card, Text, BlockStack, Button,
  Banner, Divider, List, InlineStack, DropZone, Thumbnail,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { useState, useCallback } from "react";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // ── Export Products (with ALL metafields) ────────────────────────────────────
  if (intent === "export-products") {
    const products: any[] = [];
    let cursor: string | null = null;

    // Collect all unique metafield keys across all products
    const allMetaKeys = new Set<string>();

    while (true) {
      const res = await admin.graphql(`#graphql
        query($cursor: String) {
          products(first: 50, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id title handle status
                metafields(first: 30) {
                  edges { node { namespace key value type } }
                }
              }
            }
          }
        }
      `, { variables: { cursor } });

      const data = await res.json();
      for (const e of data.data.products.edges) {
        const metaMap: Record<string, string> = {};
        for (const m of e.node.metafields.edges) {
          const col = `${m.node.namespace}.${m.node.key}`;
          metaMap[col] = m.node.value;
          allMetaKeys.add(col);
        }
        products.push({
          id:     e.node.id.split("/").pop(),
          title:  e.node.title,
          handle: e.node.handle,
          status: e.node.status,
          meta:   metaMap,
        });
      }
      if (!data.data.products.pageInfo.hasNextPage) break;
      cursor = data.data.products.pageInfo.endCursor;
    }

    const esc = (v: any) => {
      const s = String(v ?? "");
      return s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const metaCols = Array.from(allMetaKeys).sort();
    const header = ["id", "title", "handle", "status", ...metaCols].map(esc).join(",");
    const rows = products.map(p =>
      [p.id, p.title, p.handle, p.status, ...metaCols.map(k => p.meta[k] ?? "")].map(esc).join(",")
    );
    const csv = [header, ...rows].join("\n");

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="products-priority-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  // ── Export Collections ────────────────────────────────────────────────────────
  if (intent === "export-collections") {
    const collections: any[] = [];
    let cursor: string | null = null;

    while (true) {
      const res = await admin.graphql(`#graphql
        query($cursor: String) {
          collections(first: 250, after: $cursor, sortKey: TITLE) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id title handle
                productsCount { count }
                sortOrder
                canonical_url: metafield(namespace: "custom", key: "canonical_url") { value }
              }
            }
          }
        }
      `, { variables: { cursor } });

      const data = await res.json();
      for (const e of data.data.collections.edges) {
        collections.push({
          id:           e.node.id.split("/").pop(),
          title:        e.node.title,
          handle:       e.node.handle,
          product_count: e.node.productsCount?.count ?? 0,
          sort_order:   e.node.sortOrder,
          shopify_url:  `https://www.fineystjackets.com/collections/${e.node.handle}`,
          canonical_url: e.node.canonical_url?.value ?? "",
        });
      }
      if (!data.data.collections.pageInfo.hasNextPage) break;
      cursor = data.data.collections.pageInfo.endCursor;
    }

    const header = "id,title,handle,product_count,sort_order,shopify_url,canonical_url";
    const esc = (v: any) => {
      const s = String(v ?? "");
      return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = collections.map(c =>
      [c.id, c.title, c.handle, c.product_count, c.sort_order, c.shopify_url, c.canonical_url].map(esc).join(",")
    );
    const csv = [header, ...rows].join("\n");

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="collections-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  // ── Import priorities from CSV ────────────────────────────────────────────────
  if (intent === "import-priorities") {
    const file = formData.get("file") as File;
    if (!file) return { error: "No file uploaded" };

    const text = await file.text();
    const lines = text.trim().split("\n");
    const headers = lines[0].split(",").map(h => h.trim().toLowerCase());
    const idIdx  = headers.indexOf("id");
    const priIdx = headers.indexOf("priority");

    if (idIdx === -1 || priIdx === -1) {
      return { error: "CSV must have 'id' and 'priority' columns" };
    }

    const updates = lines.slice(1).map(line => {
      const cols = line.split(",");
      return { id: cols[idIdx]?.trim(), priority: cols[priIdx]?.trim() };
    }).filter(r => r.id && r.priority);

    // Batch update in groups of 25
    let updated = 0, errors = 0;
    for (let i = 0; i < updates.length; i += 25) {
      const batch = updates.slice(i, i + 25);
      const metafields = batch.map(r => ({
        ownerId:   `gid://shopify/Product/${r.id}`,
        namespace: "custom",
        key:       "priority",
        value:     r.priority,
        type:      "single_line_text_field",
      }));

      const res = await admin.graphql(`#graphql
        mutation($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id }
            userErrors { field message }
          }
        }
      `, { variables: { metafields } });

      const data = await res.json();
      const errs = data.data.metafieldsSet.userErrors;
      if (errs.length > 0) errors += batch.length;
      else updated += batch.length;
    }

    return { imported: true, updated, errors, total: updates.length };
  }

  return null;
};

export default function ImportExport() {
  const fetcher = useFetcher<typeof action>();
  const [file, setFile] = useState<File | null>(null);

  const handleDrop = useCallback((_: File[], accepted: File[]) => {
    setFile(accepted[0] ?? null);
  }, []);

  const isLoading = fetcher.state !== "idle";

  return (
    <Page>
      <TitleBar title="Import / Export" />
      <BlockStack gap="500">

        {/* Export */}
        <Layout>
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">📥 Export Products</Text>
                <Divider />
                <Text as="p" variant="bodyMd" tone="subdued">
                  Download all products with their title, handle, status, and custom.priority as a CSV file.
                </Text>
                <List type="bullet">
                  <List.Item>Columns: id, title, handle, status, priority</List.Item>
                  <List.Item>All products included</List.Item>
                  <List.Item>Edit in Excel, import back to update priorities</List.Item>
                </List>
                <fetcher.Form method="POST" action="/app/import-export">
                  <input type="hidden" name="intent" value="export-products" />
                  <Button submit loading={isLoading} variant="primary">
                    Download Products CSV
                  </Button>
                </fetcher.Form>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">📥 Export Collections</Text>
                <Divider />
                <Text as="p" variant="bodyMd" tone="subdued">
                  Download all collections with their canonical URL, sort order, and product count.
                </Text>
                <List type="bullet">
                  <List.Item>Columns: id, title, handle, product_count, sort_order, shopify_url, canonical_url</List.Item>
                  <List.Item>All collections included</List.Item>
                </List>
                <fetcher.Form method="POST" action="/app/import-export">
                  <input type="hidden" name="intent" value="export-collections" />
                  <Button submit loading={isLoading}>
                    Download Collections CSV
                  </Button>
                </fetcher.Form>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* Import */}
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">📤 Import Priorities from CSV</Text>
                <Divider />
                <Text as="p" variant="bodyMd" tone="subdued">
                  Upload a CSV with <strong>id</strong> and <strong>priority</strong> columns to bulk update product priorities.
                  Export the products CSV above, edit the priority column in Excel, then upload it here.
                </Text>

                {fetcher.data?.error && (
                  <Banner tone="critical">{fetcher.data.error}</Banner>
                )}
                {fetcher.data?.imported && (
                  <Banner tone="success">
                    ✅ Import complete — Updated: {fetcher.data.updated} products, Errors: {fetcher.data.errors}
                  </Banner>
                )}

                <fetcher.Form method="POST" action="/app/import-export" encType="multipart/form-data">
                  <input type="hidden" name="intent" value="import-priorities" />
                  <BlockStack gap="300">
                    <DropZone onDrop={handleDrop} accept=".csv" allowMultiple={false}>
                      {file ? (
                        <InlineStack gap="300" blockAlign="center">
                          <Thumbnail size="small" alt={file.name} source="" />
                          <Text as="span" variant="bodyMd">{file.name}</Text>
                        </InlineStack>
                      ) : (
                        <DropZone.FileUpload actionTitle="Upload CSV" actionHint="or drag and drop your priorities CSV here" />
                      )}
                    </DropZone>
                    {file && (
                      <input type="file" name="file" style={{ display: "none" }} />
                    )}
                    <Button
                      submit
                      variant="primary"
                      loading={isLoading}
                      disabled={!file || isLoading}
                    >
                      Import & Update Priorities
                    </Button>
                  </BlockStack>
                </fetcher.Form>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

      </BlockStack>
    </Page>
  );
}
