import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher } from "@remix-run/react";
import {
  Page, Layout, Card, Text, BlockStack, Button,
  Banner, Divider, Checkbox, InlineStack, DropZone, Thumbnail, Box,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { useState, useCallback, useEffect } from "react";

// Fixed columns for products and collections
const PRODUCT_FIXED_COLS  = ["id", "title", "handle", "status"];
const PRODUCT_META_COLS   = ["custom.priority", "custom.canonical_url", "custom.faq", "custom.related_collections", "seo.title", "seo.description"];
const COLLECTION_ALL_COLS = ["id", "title", "handle", "product_count", "sort_order", "shopify_url", "canonical_url"];

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

    // Filter to only selected columns
    const selectedCols   = formData.getAll("productCols") as string[];
    const selectedMeta   = formData.getAll("productMeta") as string[];
    const fixedCols      = ["id", "title", "handle", "status"].filter(c => selectedCols.includes(c));
    const metaColsAll    = Array.from(allMetaKeys).sort();
    const metaColsFiltered = selectedMeta.length > 0
      ? metaColsAll.filter(k => selectedMeta.includes(k))
      : metaColsAll;

    const finalCols = [...fixedCols, ...metaColsFiltered];
    const header = finalCols.map(esc).join(",");
    const rows = products.map(p => finalCols.map(col => {
      if (col === "id")     return esc(p.id);
      if (col === "title")  return esc(p.title);
      if (col === "handle") return esc(p.handle);
      if (col === "status") return esc(p.status);
      return esc(p.meta[col] ?? "");
    }).join(","));
    const csv = [header, ...rows].join("\n");
    return { intent: "export-products", csv, filename: `products-${new Date().toISOString().slice(0, 10)}.csv` };
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
          shopify_url:  `https://${process.env.SHOPIFY_SHOP_DOMAIN}/collections/${e.node.handle}`,
          canonical_url: e.node.canonical_url?.value ?? "",
        });
      }
      if (!data.data.collections.pageInfo.hasNextPage) break;
      cursor = data.data.collections.pageInfo.endCursor;
    }

    const selectedCollCols = formData.getAll("collectionCols") as string[];
    const allCollCols = ["id", "title", "handle", "product_count", "sort_order", "shopify_url", "canonical_url"];
    const finalCollCols = selectedCollCols.length > 0
      ? allCollCols.filter(c => selectedCollCols.includes(c))
      : allCollCols;

    const esc2 = (v: any) => {
      const s = String(v ?? "");
      return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = finalCollCols.map(esc2).join(",");
    const rows = collections.map(c =>
      finalCollCols.map(col => esc2((c as any)[col] ?? "")).join(",")
    );
    const csv = [header, ...rows].join("\n");
    return { intent: "export-collections", csv, filename: `collections-${new Date().toISOString().slice(0, 10)}.csv` };
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

  // Products column selection — fixed cols always shown, meta cols toggleable
  const [productFixedCols, setProductFixedCols] = useState<Record<string, boolean>>({
    id: true, title: true, handle: true, status: true,
  });
  const [productMetaCols, setProductMetaCols] = useState<Record<string, boolean>>({
    "custom.priority": true,
    "custom.canonical_url": true,
    "custom.faq": false,
    "custom.related_collections": false,
    "seo.title": true,
    "seo.description": true,
  });

  // Collections column selection
  const [collectionCols, setCollectionCols] = useState<Record<string, boolean>>({
    id: true, title: true, handle: true,
    product_count: true, sort_order: true,
    shopify_url: true, canonical_url: true,
  });

  const handleDrop = useCallback((_: File[], accepted: File[]) => {
    setFile(accepted[0] ?? null);
  }, []);

  const isExportingProducts    = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "export-products";
  const isExportingCollections = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "export-collections";
  const isImporting            = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "import-priorities";

  // Trigger browser file download when CSV data comes back
  useEffect(() => {
    const data = fetcher.data as any;
    if (data?.csv && data?.filename) {
      const blob = new Blob([data.csv], { type: "text/csv;charset=utf-8;" });
      const url  = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href     = url;
      link.download = data.filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }
  }, [fetcher.data]);

  return (
    <Page>
      <TitleBar title="Import / Export" />
      <BlockStack gap="500">

        {/* ── Export Products ───────────────────────────────────────────────── */}
        <Layout>
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">📥 Export Products</Text>
                <Divider />
                <Text as="p" variant="bodyMd" tone="subdued">
                  Select the columns you want to include in the CSV:
                </Text>

                {/* Fixed columns */}
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" fontWeight="semibold">Basic Fields</Text>
                  <Box padding="200" background="bg-surface-secondary" borderRadius="200">
                    <InlineStack gap="400" wrap>
                      {PRODUCT_FIXED_COLS.map(col => (
                        <Checkbox
                          key={col}
                          label={col}
                          checked={productFixedCols[col] ?? true}
                          onChange={v => setProductFixedCols(prev => ({ ...prev, [col]: v }))}
                        />
                      ))}
                    </InlineStack>
                  </Box>
                </BlockStack>

                {/* Metafield columns */}
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" fontWeight="semibold">Metafields</Text>
                  <Box padding="200" background="bg-surface-secondary" borderRadius="200">
                    <InlineStack gap="400" wrap>
                      {PRODUCT_META_COLS.map(col => (
                        <Checkbox
                          key={col}
                          label={col}
                          checked={productMetaCols[col] ?? false}
                          onChange={v => setProductMetaCols(prev => ({ ...prev, [col]: v }))}
                        />
                      ))}
                      <Text as="span" variant="bodySm" tone="subdued">+ all other metafields auto-included</Text>
                    </InlineStack>
                  </Box>
                </BlockStack>

                <fetcher.Form method="POST" action="/app/import-export">
                  <input type="hidden" name="intent" value="export-products" />
                  {/* Pass selected fixed cols */}
                  {PRODUCT_FIXED_COLS.filter(c => productFixedCols[c]).map(c => (
                    <input key={c} type="hidden" name="productCols" value={c} />
                  ))}
                  {/* Pass selected meta cols */}
                  {PRODUCT_META_COLS.filter(c => productMetaCols[c]).map(c => (
                    <input key={c} type="hidden" name="productMeta" value={c} />
                  ))}
                  <Button submit loading={isExportingProducts} variant="primary">
                    Download Products CSV
                  </Button>
                </fetcher.Form>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* ── Export Collections ──────────────────────────────────────────── */}
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">📥 Export Collections</Text>
                <Divider />
                <Text as="p" variant="bodyMd" tone="subdued">
                  Select the columns you want to include in the CSV:
                </Text>

                <Box padding="200" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="200">
                    {COLLECTION_ALL_COLS.map(col => (
                      <Checkbox
                        key={col}
                        label={col}
                        checked={collectionCols[col] ?? true}
                        onChange={v => setCollectionCols(prev => ({ ...prev, [col]: v }))}
                      />
                    ))}
                  </BlockStack>
                </Box>

                <fetcher.Form method="POST" action="/app/import-export">
                  <input type="hidden" name="intent" value="export-collections" />
                  {COLLECTION_ALL_COLS.filter(c => collectionCols[c]).map(c => (
                    <input key={c} type="hidden" name="collectionCols" value={c} />
                  ))}
                  <Button submit loading={isExportingCollections}>
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
                      loading={isImporting}
                      disabled={!file || isImporting}
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
